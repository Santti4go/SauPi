import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer, type Server, type Socket } from "node:net";
import { VERSION } from "@earendil-works/pi-coding-agent";
import {
	callSocket,
	collectGarbage,
	createRuntimeRoot,
	endpointSocketPath,
	HEARTBEAT_MS,
	listLiveSessions,
	LiveEndpoint,
	PROTOCOL_VERSION,
	runtimeRoots,
	sendToSession,
	type DiscoveredSession,
	type LiveSession,
	type LiveStatus,
} from "./network.ts";
import { RpcProcess, type RpcState } from "./rpc-process.ts";

interface ManagedRpc {
	worker: RpcProcess;
	endpoint: LiveEndpoint;
	timer: NodeJS.Timeout;
	unsubscribe: () => void;
	startedAt: number;
}

function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function pick(sessions: DiscoveredSession[], target: string): DiscoveredSession {
	const matches = sessions.filter((item) => item.endpointId === target || item.endpointId.startsWith(target) || item.sessionName === target);
	if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous endpoint: ${matches.map((item) => item.endpointId).join(", ")}` : `Endpoint not found: ${target}`);
	return matches[0]!;
}

function clean(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

function rows(sessions: DiscoveredSession[]): string {
	return [
		"ENDPOINT  TYPE  NAME  STATUS  PID  CWD",
		...sessions.map((item) => `${item.endpointId.slice(0, 8)}  ${item.transport === "tui-socket" ? "TUI" : "RPC"}  ${clean(item.sessionName ?? basename(item.cwd))}  ${item.status}  ${item.pid}  ${clean(item.cwd)}`),
	].join("\n");
}

async function writeHistory(event: string, details: object = {}): Promise<void> {
	const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	await mkdir(join(dir, "coordinator"), { recursive: true, mode: 0o700 });
	await appendFile(join(dir, "coordinator", "history.jsonl"), `${JSON.stringify({ at: Date.now(), event, ...details })}\n`, { mode: 0o600 });
}

export class Coordinator {
	private readonly id = randomUUID();
	private readonly workers = new Map<string, ManagedRpc>();
	private root = "";
	private controlPath = "";
	private lockPath = "";
	private lock: Awaited<ReturnType<typeof open>> | undefined;
	private server: Server | undefined;
	private gcTimer: NodeJS.Timeout | undefined;
	private stopping = false;

	async start(): Promise<void> {
		this.root = await createRuntimeRoot(this.id);
		this.controlPath = join(this.root, "coordinator.sock");
		this.lockPath = join(this.root, "coordinator.lock");
		await this.acquireLock();
		this.server = createServer((socket) => this.accept(socket));
		try {
			await new Promise<void>((resolve, reject) => {
				const fail = (error: Error) => reject(error);
				this.server!.once("error", fail);
				this.server!.listen(this.controlPath, () => {
					this.server!.off("error", fail);
					resolve();
				});
			});
			this.server.on("error", () => undefined);
			await import("node:fs/promises").then(({ chmod }) => chmod(this.controlPath, 0o600));
		} catch (error) {
			await this.stop();
			throw error;
		}
		this.gcTimer = setInterval(() => void collectGarbage().catch(() => undefined), 60_000);
		await this.history("coordinator_started").catch(() => undefined);
	}

	async stop(): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		if (this.gcTimer) clearInterval(this.gcTimer);
		for (const endpointId of [...this.workers.keys()]) await this.removeWorker(endpointId, true);
		if (this.server?.listening) await new Promise<void>((resolve) => this.server?.close(() => resolve()));
		await unlink(this.controlPath).catch(() => undefined);
		await this.lock?.close().catch(() => undefined);
		await unlink(this.lockPath).catch(() => undefined);
		await this.history("coordinator_stopped").catch(() => undefined);
	}

	async spawn(cwd: string, name: string): Promise<LiveSession> {
		const directory = resolve(cwd);
		if (!(await stat(directory)).isDirectory()) throw new Error(`Not a directory: ${directory}`);
		const endpointId = randomUUID();
		const root = await createRuntimeRoot(endpointId);
		const worker = new RpcProcess(directory, name);
		const state = await worker.start();
		const startedAt = Date.now();
		const info = this.rpcInfo(root, endpointId, worker, state, startedAt, directory);
		const endpoint = new LiveEndpoint(root, info, {
			deliver: async ({ text, delivery, messageId, source }) => {
				const from = source?.name || source?.endpointId || "external Pi session";
				await worker.deliver(`[Message from Pi session: ${from}]\nMessage ID: ${messageId}\n\n${text}`, delivery);
				return { accepted: true, stage: "pi_accepted", messageId };
			},
			abort: async () => { await worker.abort(); return { accepted: true }; },
			stop: () => { setImmediate(() => void this.removeWorker(endpointId, true)); return { accepted: true }; },
		});
		try {
			await endpoint.start();
		} catch (error) {
			await worker.stop();
			throw error;
		}
		const unsubscribe = worker.onEvent((event) => void this.handleWorkerEvent(endpointId, event));
		const timer = setInterval(() => void this.refreshWorker(endpointId), HEARTBEAT_MS);
		this.workers.set(endpointId, { worker, endpoint, timer, unsubscribe, startedAt });
		await this.history("rpc_spawned", { endpointId, pid: worker.pid, cwd: directory, name }).catch(() => undefined);
		return endpoint.snapshot();
	}

	private rpcInfo(root: string, endpointId: string, worker: RpcProcess, state: RpcState, startedAt: number, cwd: string): LiveSession {
		const now = Date.now();
		return {
			protocolVersion: 1,
			revision: 1,
			endpointId,
			transport: "rpc-proxy",
			managedBy: this.id,
			pid: worker.pid,
			processUptimeSeconds: 0,
			sessionId: state.sessionId,
			sessionName: state.sessionName ?? null,
			sessionFile: state.sessionFile ?? null,
			cwd,
			socketPath: endpointSocketPath(root, endpointId),
			model: state.model ? { provider: state.model.provider, id: state.model.id } : null,
			thinkingLevel: state.thinkingLevel,
			status: state.isCompacting ? "compacting" : state.isStreaming ? "running" : "idle",
			startedAt,
			updatedAt: now,
			heartbeatAt: now,
			lastActivityAt: now,
			piVersion: VERSION,
			capabilities: ["ping", "get_info", "deliver", "abort", "stop"],
			statusPrecision: "rpc-events",
			pendingMessageCount: state.pendingMessageCount,
		};
	}

	private async refreshWorker(endpointId: string): Promise<void> {
		const managed = this.workers.get(endpointId);
		if (!managed) return;
		try {
			const state = await managed.worker.getState();
			const previous = managed.endpoint.snapshot();
			const status: Exclude<LiveStatus, "unreachable"> = state.isCompacting ? "compacting" : state.isStreaming ? "running" : "idle";
			const changed = previous.status !== status || previous.sessionName !== (state.sessionName ?? null) || previous.sessionId !== state.sessionId;
			await managed.endpoint.update({
				sessionId: state.sessionId,
				sessionName: state.sessionName ?? null,
				sessionFile: state.sessionFile ?? null,
				model: state.model ? { provider: state.model.provider, id: state.model.id } : null,
				thinkingLevel: state.thinkingLevel,
				status,
				pendingMessageCount: state.pendingMessageCount,
				processUptimeSeconds: (Date.now() - managed.startedAt) / 1000,
				heartbeatAt: Date.now(),
				...(changed ? { updatedAt: Date.now() } : {}),
			});
		} catch {}
	}

	private async handleWorkerEvent(endpointId: string, event: Record<string, unknown>): Promise<void> {
		const managed = this.workers.get(endpointId);
		if (!managed) return;
		if (event.type === "process_exit") { await this.removeWorker(endpointId, false); return; }
		let status: Exclude<LiveStatus, "unreachable"> | undefined;
		if (event.type === "agent_start") status = "running";
		if (event.type === "agent_settled") status = "idle";
		if (event.type === "compaction_start") status = "compacting";
		if (event.type === "auto_retry_start") status = "retrying";
		if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(String(event.method))) status = "waiting_user";
		const pending = event.type === "queue_update" ? ((event.steering as unknown[] | undefined)?.length ?? 0) + ((event.followUp as unknown[] | undefined)?.length ?? 0) : undefined;
		if (status || pending !== undefined) await managed.endpoint.update({ ...(status ? { status, lastActivityAt: Date.now() } : {}), ...(pending !== undefined ? { pendingMessageCount: pending } : {}), updatedAt: Date.now() }).catch(() => undefined);
	}

	private async removeWorker(endpointId: string, terminate: boolean): Promise<void> {
		const managed = this.workers.get(endpointId);
		if (!managed) return;
		this.workers.delete(endpointId);
		clearInterval(managed.timer);
		managed.unsubscribe();
		if (terminate) await managed.worker.stop();
		await managed.endpoint.stop();
		await this.history("rpc_exited", { endpointId }).catch(() => undefined);
	}

	private async acquireLock(): Promise<void> {
		try {
			this.lock = await open(this.lockPath, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const stat = await lstat(this.lockPath);
			const owner = JSON.parse(await readFile(this.lockPath, "utf8")) as { pid?: number };
			if (stat.uid !== process.getuid?.() || !owner.pid || processAlive(owner.pid)) throw new Error("A coordinator is already running");
			await unlink(this.lockPath);
			await unlink(this.controlPath).catch(() => undefined);
			this.lock = await open(this.lockPath, "wx", 0o600);
		}
		await this.lock.writeFile(JSON.stringify({ pid: process.pid, id: this.id }));
	}

	private accept(socket: Socket): void {
		let buffer = Buffer.alloc(0);
		socket.setTimeout(3_000, () => socket.destroy());
		socket.on("data", (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			const newline = buffer.indexOf(0x0a);
			if (newline < 0) {
				if (buffer.length > 64 * 1024) socket.destroy();
				return;
			}
			void this.controlRequest(socket, buffer.subarray(0, newline).toString("utf8"));
		});
	}

	private async controlRequest(socket: Socket, line: string): Promise<void> {
		let request: Record<string, unknown> = {};
		try { request = JSON.parse(line) as Record<string, unknown>; } catch {}
		const id = typeof request.id === "string" ? request.id : null;
		try {
			if (request.v !== PROTOCOL_VERSION) throw new Error("Unsupported protocol");
			let result: object;
			if (request.method === "ping") result = { coordinatorId: this.id };
			else if (request.method === "spawn") {
				const params = request.params as Record<string, unknown> | undefined;
				if (typeof params?.cwd !== "string" || typeof params.name !== "string") throw new Error("spawn requires cwd and name");
				result = { info: await this.spawn(params.cwd, params.name) };
			} else if (request.method === "shutdown") {
				result = { accepted: true };
				setImmediate(() => void this.stop());
			} else throw new Error("Unknown coordinator method");
			socket.end(`${JSON.stringify({ v: 1, id, ok: true, result })}\n`);
		} catch (error) {
			socket.end(`${JSON.stringify({ v: 1, id, ok: false, error: { code: "REQUEST_FAILED", message: error instanceof Error ? error.message : String(error) } })}\n`);
		}
	}

	private history(event: string, details: object = {}): Promise<void> {
		return writeHistory(event, details);
	}
}

async function coordinatorCall(method: string, params: object = {}): Promise<Record<string, unknown>> {
	let last: Error | undefined;
	for (const root of runtimeRoots()) {
		try { return await callSocket(join(root, "coordinator.sock"), method, params); }
		catch (error) { last = error instanceof Error ? error : new Error(String(error)); }
	}
	throw last ?? new Error("Coordinator is not running; start it with: pi-coordinator serve");
}

async function main(args = process.argv.slice(2)): Promise<void> {
	const [command = "list", ...rest] = args;
	if (command === "serve") {
		const coordinator = new Coordinator();
		await coordinator.start();
		console.log("Pi coordinator is running");
		for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void coordinator.stop().then(() => process.exit(0)));
		return;
	}
	if (command === "list") { console.log(rows(await listLiveSessions())); return; }
	if (command === "watch") {
		const draw = async () => { process.stdout.write(`\x1b[2J\x1b[H${rows(await listLiveSessions())}\n`); };
		await draw();
		setInterval(() => void draw(), 1_000);
		return;
	}
	if (command === "gc") {
		const removed = await collectGarbage();
		await writeHistory("gc", { removed }).catch(() => undefined);
		console.log(`Removed ${removed} orphan registration(s).`);
		return;
	}
	if (command === "inspect") { console.log(JSON.stringify(pick(await listLiveSessions(), rest[0] ?? ""), null, 2)); return; }
	if (command === "send") {
		const target = rest.shift() ?? "";
		const session = pick(await listLiveSessions(), target);
		await sendToSession(session, rest.join(" "));
		await writeHistory("message_sent", { endpointId: session.endpointId }).catch(() => undefined);
		console.log("Message dispatched");
		return;
	}
	if (command === "notify" || command === "abort" || command === "stop") {
		const target = rest.shift() ?? "";
		const session = pick(await listLiveSessions(), target);
		await callSocket(session.socketPath, command, { targetEndpointId: session.endpointId, ...(command === "notify" ? { text: rest.join(" ") } : {}) });
		await writeHistory(`${command}_accepted`, { endpointId: session.endpointId }).catch(() => undefined);
		console.log(`${command} accepted`);
		return;
	}
	if (command === "spawn") {
		const cwdIndex = rest.indexOf("--cwd");
		const nameIndex = rest.indexOf("--name");
		const cwd = cwdIndex >= 0 ? rest[cwdIndex + 1] : undefined;
		const name = nameIndex >= 0 ? rest[nameIndex + 1] : undefined;
		if (!cwd || !name) throw new Error("Usage: pi-coordinator spawn --cwd <path> --name <name>");
		console.log(JSON.stringify(await coordinatorCall("spawn", { cwd, name }), null, 2));
		return;
	}
	if (command === "shutdown") { await coordinatorCall("shutdown"); return; }
	throw new Error("Commands: serve, list, watch, inspect, gc, send, notify, spawn, abort, stop, shutdown");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
