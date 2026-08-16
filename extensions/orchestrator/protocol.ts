export type WorkerStatus = "starting" | "idle" | "busy" | "offline" | "failed";

export interface WorkerSnapshot {
	id: string;
	role: string;
	status: WorkerStatus;
	model?: string;
	taskId?: string;
	pid: number;
	tmuxTarget?: string;
	updatedAt: string;
}

export type WorkerRequest =
	| { type: "ping" }
	| { type: "task"; taskId: string; prompt: string }
	| { type: "abort"; taskId?: string };

export type WorkerResponse =
	| { type: "status"; worker: WorkerSnapshot }
	| { type: "accepted"; taskId: string }
	| { type: "progress"; taskId: string; message: string }
	| { type: "result"; taskId: string; output: string; isError: boolean }
	| { type: "error"; message: string; taskId?: string };

export function encodeMessage(value: WorkerRequest | WorkerResponse): string {
	return `${JSON.stringify(value)}\n`;
}

export function parseMessage(value: string): WorkerRequest | WorkerResponse {
	const parsed: unknown = JSON.parse(value);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("type" in parsed)) {
		throw new Error("Invalid worker protocol message");
	}
	return parsed as WorkerRequest | WorkerResponse;
}
