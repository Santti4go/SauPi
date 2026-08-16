import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentInstance } from "../registry.ts";

export interface OrchestratorUiThemeContext {
	agents: AgentInstance[];
	session: string;
	shortcut: string;
	theme: Theme;
	width: number;
}

export type OrchestratorUiThemeRenderer = (context: OrchestratorUiThemeContext) => string[];

export function agentDetail(agent: AgentInstance): string {
	if (agent.error) return agent.error;
	if (agent.currentTaskId) return `task ${agent.currentTaskId.slice(0, 8)}`;
	if (agent.branch) return agent.branch;
	return agent.status === "idle" ? "ready" : "";
}
