import { chmod, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	encodeMessage,
	parseMessage,
	type WorkerRequest,
	type WorkerResponse,
	type WorkerSnapshot,
} from "../protocol.ts";

function requiredEnvironment(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Missing ${name}`);
	return value;
}

function assistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as Record<string, unknown>).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is { type: string; text: string } => {
			return Boolean(item && typeof item === "object" && (item as Record<string, unknown>).type === "text" && typeof (item as Record<string, unknown>).text === "string");
		})
		.map((item) => item.text)
		.join("\n");
}

export default function orchestratorWorker(pi: ExtensionAPI): void {
	const id = requiredEnvironment("PI_ORCHESTRATOR_AGENT_ID");
	const role = requiredEnvironment("PI_ORCHESTRATOR_AGENT_ROLE");
	const socketPath = requiredEnvironment("PI_ORCHESTRATOR_SOCKET");
	const tmuxTarget = process.env.PI_ORCHESTRATOR_TMUX_TARGET;
	const orchestratorTarget = process.env.PI_ORCHESTRATOR_PARENT_TARGET;
	let server: Server | undefined;
	let context: ExtensionContext | undefined;
	let currentTask: { id: string; socket: import("node:net").Socket } | undefined;
	let status: WorkerSnapshot["status"] = "starting";

	const snapshot = (): WorkerSnapshot => ({
		id,
		role,
		status,
		...(context?.model?.id ? { model: context.model.id } : {}),
		...(currentTask ? { taskId: currentTask.id } : {}),
		pid: process.pid,
		...(tmuxTarget ? { tmuxTarget } : {}),
		updatedAt: new Date().toISOString(),
	});
	const reply = (socket: import("node:net").Socket, response: WorkerResponse, end = false) => {
		socket.write(encodeMessage(response));
		if (end) socket.end();
	};
	const progress = (message: string) => {
		if (currentTask) reply(currentTask.socket, { type: "progress", taskId: currentTask.id, message });
	};
	const resetTask = () => {
		currentTask = undefined;
		status = "idle";
		context?.ui.setStatus("orchestrator-worker", `${id}: ${status}`);
	};

	const handle = (request: WorkerRequest, socket: import("node:net").Socket) => {
		if (request.type === "ping") {
			reply(socket, { type: "status", worker: snapshot() }, true);
			return;
		}
		if (request.type === "abort") {
			if (request.taskId && currentTask?.id !== request.taskId) {
				reply(socket, { type: "error", message: `Task ${request.taskId} is not active`, taskId: request.taskId }, true);
				return;
			}
			context?.abort();
			reply(socket, { type: "status", worker: snapshot() }, true);
			return;
		}
		if (!context || currentTask || !context.isIdle()) {
			reply(socket, { type: "error", message: `Worker ${id} is busy`, taskId: request.taskId }, true);
			return;
		}
		currentTask = { id: request.taskId, socket };
		status = "busy";
		context.ui.setStatus("orchestrator-worker", `${id}: busy`);
		reply(socket, { type: "accepted", taskId: request.taskId });
		try {
			// Pi convierte la tarea externa en un mensaje humano real del worker.
			pi.sendUserMessage(request.prompt);
		} catch (error) {
			reply(socket, {
				type: "error",
				message: error instanceof Error ? error.message : String(error),
				taskId: request.taskId,
			}, true);
			resetTask();
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
		context = ctx;
		status = "idle";
		pi.setSessionName(id);
		ctx.ui.setTitle(`π // ${id}`);
		ctx.ui.setStatus("orchestrator-worker", `${id}: idle`);
		ctx.ui.setToolsExpanded(false);
		await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
		await chmod(dirname(socketPath), 0o700);
		await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		server = createServer((socket) => {
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk) => {
				buffer += chunk;
				while (true) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) break;
					let line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line.endsWith("\r")) line = line.slice(0, -1);
					if (!line.trim()) continue;
					try {
						handle(parseMessage(line) as WorkerRequest, socket);
					} catch (error) {
						reply(socket, { type: "error", message: error instanceof Error ? error.message : String(error) }, true);
					}
				}
			});
		});
		await new Promise<void>((resolve, reject) => {
			server!.once("error", reject);
			server!.listen(socketPath, () => {
				server!.removeListener("error", reject);
				resolve();
			});
		});
		await chmod(socketPath, 0o600);
	});

	pi.on("agent_start", () => {
		status = "busy";
		context?.ui.setStatus("orchestrator-worker", `${id}: busy`);
	});

	pi.on("tool_execution_start", (event) => progress(`tool: ${event.toolName}`));

	pi.on("turn_end", (event) => {
		const text = assistantText(event.message);
		if (text) progress(text.slice(-500));
	});

	pi.on("agent_end", (event) => {
		if (currentTask) {
			const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
			const output = assistantText(assistant) || "(no output)";
			const isError = assistant?.role === "assistant" && ["error", "aborted"].includes(assistant.stopReason);
			reply(currentTask.socket, { type: "result", taskId: currentTask.id, output, isError }, true);
		}
		resetTask();
	});

	const jumpToOrchestrator = async (ctx: ExtensionContext) => {
		if (!orchestratorTarget) {
			ctx.ui.notify("Orchestrator tmux target is unavailable", "warning");
			return;
		}
		const result = await pi.exec("tmux", ["switch-client", "-t", orchestratorTarget]);
		if (result.code !== 0) ctx.ui.notify(result.stderr || `Could not jump to ${orchestratorTarget}`, "error");
	};

	pi.registerCommand("agent-jump", {
		description: "Jump back to the orchestrator tmux pane",
		handler: async (_args, ctx) => jumpToOrchestrator(ctx),
	});

	pi.registerShortcut("f8", {
		description: "Jump back to the orchestrator tmux pane",
		handler: jumpToOrchestrator,
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (currentTask) reply(currentTask.socket, { type: "error", message: `Worker ${id} shut down`, taskId: currentTask.id }, true);
		currentTask = undefined;
		status = "offline";
		context = undefined;
		ctx.ui.setStatus("orchestrator-worker", undefined);
		if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
		server = undefined;
		await unlink(socketPath).catch(() => undefined);
	});
}
