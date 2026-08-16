import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentInstance } from "../registry.ts";
import { renderOrchestratorList } from "./list.ts";
import type { OrchestratorUiThemeContext, OrchestratorUiThemeRenderer } from "./types.ts";
import { agentDetail } from "./types.ts";

const ICON = { idle: "●", busy: "◆", starting: "◌", offline: "○", failed: "×" } as const;
const MIN_CARD_WIDTH = 24;
const MAX_COLUMNS = 3;

function fit(text: string, width: number): string {
	const value = truncateToWidth(text, Math.max(0, width));
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function statusColor(agent: AgentInstance): "success" | "accent" | "warning" | "dim" | "error" {
	if (agent.status === "idle") return "success";
	if (agent.status === "busy") return "accent";
	if (agent.status === "starting") return "warning";
	if (agent.status === "failed") return "error";
	return "dim";
}

function card(context: OrchestratorUiThemeContext, agent: AgentInstance, width: number): string[] {
	const inner = Math.max(1, width - 2);
	const border = (value: string) => context.theme.fg("borderMuted", value);
	const row = (value: string, color: "accent" | "success" | "warning" | "dim" | "error") =>
		`${border("│")}${context.theme.fg(color, fit(value, inner))}${border("│")}`;
	const detail = agentDetail(agent);
	const model = agent.model ?? agent.definition.model ?? "default";
	const status = `${ICON[agent.status]} ${agent.status}${detail ? ` — ${detail}` : ""}`;
	return [
		border(`┌${"─".repeat(inner)}┐`),
		row(agent.id, "accent"),
		row(status, statusColor(agent)),
		row(`model ${model}`, "dim"),
		border(`└${"─".repeat(inner)}┘`),
	];
}

function columnsFor(width: number, count: number): number {
	for (let columns = Math.min(MAX_COLUMNS, count); columns > 1; columns--) {
		if (Math.floor((width - (columns - 1)) / columns) >= MIN_CARD_WIDTH) return columns;
	}
	return 1;
}

export const renderOrchestratorGrid: OrchestratorUiThemeRenderer = (context) => {
	if (context.width < MIN_CARD_WIDTH) return renderOrchestratorList(context);
	const columns = columnsFor(context.width, context.agents.length);
	const gap = 1;
	const cardWidth = Math.floor((context.width - gap * (columns - 1)) / columns);
	const lines = [context.theme.fg("accent", `AGENTS // ${context.session}`)];

	for (let index = 0; index < context.agents.length; index += columns) {
		const cards = context.agents.slice(index, index + columns).map((agent) => card(context, agent, cardWidth));
		while (cards.length < columns) cards.push(Array(5).fill(" ".repeat(cardWidth)));
		for (let line = 0; line < 5; line++) lines.push(cards.map((entry) => entry[line]!).join(" "));
	}

	lines.push(context.theme.fg("dim", `${context.shortcut}: jump  /agents: details`));
	return lines;
};
