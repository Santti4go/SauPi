import type { OrchestratorUiThemeRenderer } from "./types.ts";
import { agentDetail } from "./types.ts";

const ICON = { idle: "●", busy: "◆", starting: "◌", offline: "○", failed: "×" } as const;

export const renderOrchestratorList: OrchestratorUiThemeRenderer = ({ agents, session, shortcut, theme }) => [
	theme.fg("accent", `AGENTS // ${session}`),
	...agents.map((agent) => {
		const detail = agentDetail(agent);
		return `${ICON[agent.status]} ${agent.id.padEnd(18)} ${agent.status}${detail ? ` — ${detail}` : ""}`;
	}),
	theme.fg("dim", `jump: ${shortcut}  command: /agent-jump`),
];
