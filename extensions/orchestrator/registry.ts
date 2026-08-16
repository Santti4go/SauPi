import type { AgentDefinition } from "./config.ts";
import type { WorkerSnapshot, WorkerStatus } from "./protocol.ts";

export interface AgentInstance {
	id: string;
	role: string;
	ordinal: number;
	definition: AgentDefinition;
	status: WorkerStatus;
	model?: string | undefined;
	socketPath?: string | undefined;
	tmuxTarget?: string | undefined;
	workspacePath?: string | undefined;
	branch?: string | undefined;
	currentTaskId?: string | undefined;
	lastSeenAt?: string | undefined;
	error?: string | undefined;
}

export class AgentRegistry {
	private readonly instances = new Map<string, AgentInstance>();
	private readonly listeners = new Set<() => void>();

	constructor(definitions: AgentDefinition[]) {
		for (const definition of definitions) {
			for (let ordinal = 1; ordinal <= definition.count; ordinal++) {
				const id = `${definition.name}-${ordinal}`;
				this.instances.set(id, {
					id,
					role: definition.name,
					ordinal,
					definition,
					status: "offline",
					...(definition.model ? { model: definition.model } : {}),
				});
			}
		}
	}

	all(): AgentInstance[] {
		return [...this.instances.values()];
	}

	forRole(role: string): AgentInstance[] {
		return this.all().filter((instance) => instance.role === role);
	}

	get(id: string): AgentInstance | undefined {
		return this.instances.get(id);
	}

	update(id: string, patch: Partial<Omit<AgentInstance, "id" | "role" | "ordinal" | "definition">>): void {
		const instance = this.instances.get(id);
		if (!instance) return;
		Object.assign(instance, patch);
		this.emit();
	}

	applyHeartbeat(snapshot: WorkerSnapshot): void {
		const instance = this.instances.get(snapshot.id);
		if (!instance) return;
		if (instance.currentTaskId && snapshot.status === "idle") {
			this.update(snapshot.id, {
				lastSeenAt: snapshot.updatedAt,
				tmuxTarget: snapshot.tmuxTarget ?? instance.tmuxTarget,
				...(snapshot.model ? { model: snapshot.model } : {}),
			});
			return;
		}
		this.update(snapshot.id, {
			status: snapshot.status,
			...(snapshot.model ? { model: snapshot.model } : {}),
			currentTaskId: snapshot.taskId,
			tmuxTarget: snapshot.tmuxTarget,
			lastSeenAt: snapshot.updatedAt,
			error: undefined,
		});
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}
