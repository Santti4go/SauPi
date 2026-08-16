import { connect, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { encodeMessage, parseMessage, type WorkerRequest, type WorkerResponse, type WorkerSnapshot } from "./protocol.ts";

function openSocket(path: string, timeoutMs: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = connect(path);
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error(`Timed out connecting to worker socket: ${path}`));
		}, timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timeout);
			resolve(socket);
		});
		socket.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
	});
}

function attachReader(socket: Socket, onMessage: (message: WorkerResponse) => void, onError: (error: Error) => void): void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	const processBuffer = () => {
		while (true) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			let line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line.trim()) continue;
			try {
				onMessage(parseMessage(line) as WorkerResponse);
			} catch (error) {
				onError(error instanceof Error ? error : new Error(String(error)));
			}
		}
	};
	socket.on("data", (chunk) => {
		buffer += decoder.write(chunk);
		processBuffer();
	});
	socket.on("end", () => {
		buffer += decoder.end();
		processBuffer();
	});
}

async function send(path: string, request: WorkerRequest, timeoutMs = 2_000): Promise<WorkerResponse> {
	const socket = await openSocket(path, timeoutMs);
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error(`Worker response timed out: ${path}`));
		}, timeoutMs);
		attachReader(
			socket,
			(message) => {
				clearTimeout(timeout);
				socket.end();
				resolve(message);
			},
			(error) => {
				clearTimeout(timeout);
				socket.destroy();
				reject(error);
			},
		);
		socket.once("error", reject);
		socket.write(encodeMessage(request));
	});
}

export async function pingWorker(path: string): Promise<WorkerSnapshot> {
	const response = await send(path, { type: "ping" });
	if (response.type !== "status") throw new Error(response.type === "error" ? response.message : "Invalid ping response");
	return response.worker;
}

export async function abortWorker(path: string, taskId?: string): Promise<void> {
	const response = await send(path, { type: "abort", ...(taskId ? { taskId } : {}) });
	if (response.type === "error") throw new Error(response.message);
}

export interface WorkerTaskResult {
	output: string;
	isError: boolean;
}

export async function runWorkerTask(
	path: string,
	taskId: string,
	prompt: string,
	signal: AbortSignal | undefined,
	onProgress?: (message: string) => void,
): Promise<WorkerTaskResult> {
	const socket = await openSocket(path, 5_000);
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			socket.end();
			callback();
		};
		const onAbort = () => {
			void abortWorker(path, taskId).catch(() => undefined);
			finish(() => reject(new Error(`Task ${taskId} aborted`)));
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		attachReader(
			socket,
			(message) => {
				if (message.type === "progress" && message.taskId === taskId) onProgress?.(message.message);
				else if (message.type === "result" && message.taskId === taskId) {
					finish(() => resolve({ output: message.output, isError: message.isError }));
				} else if (message.type === "error") finish(() => reject(new Error(message.message)));
			},
			(error) => finish(() => reject(error)),
		);
		socket.once("error", (error) => finish(() => reject(error)));
		socket.once("close", () => {
			if (!settled) finish(() => reject(new Error(`Worker ${path} closed before returning task ${taskId}`)));
		});
		socket.write(encodeMessage({ type: "task", taskId, prompt }));
	});
}
