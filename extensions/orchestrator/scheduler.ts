import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OrchestratorConfig } from "./config.ts";
import { runEphemeralAgent, type AgentRunResult } from "./ephemeral-runner.ts";
import type { AgentInstance } from "./registry.ts";
import { AgentRegistry } from "./registry.ts";
import { runWorkerTask } from "./worker-client.ts";
import { prepareWorkspace } from "./workspace.ts";

export interface SchedulerHooks {
	startPersistent(instance: AgentInstance): Promise<void>;
}

export interface DispatchResult extends AgentRunResult {
	agentId: string;
	role: string;
	workspacePath: string;
	branch?: string;
}

export class AgentScheduler {
	constructor(
		private readonly pi: ExtensionAPI,
		private readonly config: OrchestratorConfig,
		private readonly registry: AgentRegistry,
		private readonly hooks: SchedulerHooks,
	) {}

	async dispatch(
		role: string,
		task: string,
		signal: AbortSignal | undefined,
		onProgress?: (message: string) => void,
	): Promise<DispatchResult> {
		const candidates = this.registry.forRole(role);
		if (candidates.length === 0) {
			throw new Error(`Unknown agent role "${role}". Available roles: ${this.config.agents.map((agent) => agent.name).join(", ")}`);
		}
		const definition = candidates[0]!.definition;
		if (definition.lifecycle === "ephemeral") {
			const instance = candidates.find((candidate) => candidate.status === "offline" || candidate.status === "idle");
			if (!instance) throw new Error(`All ${role} agents are busy`);
			this.registry.update(instance.id, { status: "busy", error: undefined });
			try {
				const workspace = await prepareWorkspace(this.pi, instance, this.config.worktreeRoot);
				this.registry.update(instance.id, { workspacePath: workspace.path, branch: workspace.branch });
				const result = await runEphemeralAgent(definition, task, workspace.path, signal, onProgress);
				return { ...result, agentId: instance.id, role, workspacePath: workspace.path, ...(workspace.branch ? { branch: workspace.branch } : {}) };
			} finally {
				this.registry.update(instance.id, { status: "offline", currentTaskId: undefined });
			}
		}

		const taskId = randomUUID();
		const instance = await this.acquirePersistent(candidates, taskId, signal);
		if (!instance.socketPath || !instance.workspacePath) throw new Error(`Worker ${instance.id} is missing runtime metadata`);
		try {
			const result = await runWorkerTask(instance.socketPath, taskId, task, signal, onProgress);
			return {
				output: result.output,
				isError: result.isError,
				exitCode: result.isError ? 1 : 0,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
				agentId: instance.id,
				role,
				workspacePath: instance.workspacePath,
				...(instance.branch ? { branch: instance.branch } : {}),
			};
		} finally {
			this.registry.update(instance.id, { status: "idle", currentTaskId: undefined });
		}
	}

	private async acquirePersistent(candidates: AgentInstance[], taskId: string, signal: AbortSignal | undefined): Promise<AgentInstance> {
		const deadline = Date.now() + 30 * 60_000;
		while (Date.now() < deadline) {
			if (signal?.aborted) throw new Error("Agent dispatch aborted");
			const idle = candidates.find((candidate) => candidate.status === "idle");
			if (idle) {
				this.registry.update(idle.id, { status: "busy", currentTaskId: taskId, error: undefined });
				return idle;
			}
			const stopped = candidates.find((candidate) => candidate.status === "offline" || candidate.status === "failed");
			if (stopped) {
				await this.hooks.startPersistent(stopped);
				if (stopped.status === "idle") {
					this.registry.update(stopped.id, { status: "busy", currentTaskId: taskId, error: undefined });
					return stopped;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		throw new Error(`Timed out waiting for an available ${candidates[0]?.role ?? "agent"}`);
	}
}
