import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const MAX_RPC_LINE = 10 * 1024 * 1024;

export interface RpcState {
	model?: { provider: string; id: string };
	thinkingLevel: string;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	pendingMessageCount: number;
}

export class RpcProcess {
	private child: ChildProcessWithoutNullStreams | undefined;
	private readonly pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
	private readonly listeners = new Set<(event: Record<string, unknown>) => void>();
	private requestId = 0;
	private stderr = "";

	constructor(
		private readonly cwd: string,
		private readonly name: string,
		private readonly command = process.env.PI_COMMAND || "pi",
		private readonly extraArgs: string[] = [],
	) {}

	get pid(): number {
		if (!this.child?.pid) throw new Error("RPC process is not running");
		return this.child.pid;
	}

	onEvent(listener: (event: Record<string, unknown>) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async start(): Promise<RpcState> {
		this.child = spawn(this.command, [...this.extraArgs, "--mode", "rpc", "--name", this.name], {
			cwd: this.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});
		this.readStdout(this.child);
		this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-65_536); });
		this.child.on("exit", (code, signal) => {
			const error = new Error(`RPC process exited (${signal ?? code ?? "unknown"})${this.stderr ? `: ${this.stderr.trim()}` : ""}`);
			for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
			this.pending.clear();
			for (const listener of this.listeners) listener({ type: "process_exit", code, signal });
		});
		try {
			return await this.getState();
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	async getState(): Promise<RpcState> {
		const response = await this.send({ type: "get_state" });
		return response.data as RpcState;
	}

	async deliver(message: string, delivery: "steer" | "followUp"): Promise<void> {
		await this.send({ type: "prompt", message, streamingBehavior: delivery });
	}

	async abort(): Promise<void> {
		await this.send({ type: "clear_queue" }, 3_000).catch(() => undefined);
		await this.send({ type: "abort" }, 5_000);
	}

	async stop(): Promise<void> {
		const child = this.child;
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		await this.abort().catch(() => undefined);
		child.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const force = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
			child.once("exit", () => { clearTimeout(force); resolve(); });
		});
	}

	private send(command: Record<string, unknown>, timeout = 10_000): Promise<Record<string, unknown>> {
		const child = this.child;
		if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.reject(new Error("RPC process is not running"));
		const id = `rpc-${++this.requestId}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC request timed out: ${String(command.type)}`)); }, timeout);
			this.pending.set(id, { resolve, reject, timer });
			child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
				if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
			});
		});
	}

	private readStdout(child: ChildProcessWithoutNullStreams): void {
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		child.stdout.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				this.handleLine(child, line);
			}
			if (Buffer.byteLength(buffer) > MAX_RPC_LINE) child.kill("SIGTERM");
		});
	}

	private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
		let event: Record<string, unknown>;
		try { event = JSON.parse(line) as Record<string, unknown>; } catch { return; }
		if (event.type === "response" && typeof event.id === "string") {
			const request = this.pending.get(event.id);
			if (!request) return;
			clearTimeout(request.timer);
			this.pending.delete(event.id);
			event.success === true ? request.resolve(event) : request.reject(new Error(String(event.error ?? "RPC request failed")));
			return;
		}
		if (event.type === "extension_ui_request" && typeof event.id === "string" && ["select", "confirm", "input", "editor"].includes(String(event.method))) {
			child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true })}\n`);
		}
		for (const listener of this.listeners) listener(event);
	}
}
