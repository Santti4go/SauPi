import type { OrchestratorUiTheme } from "../config.ts";
import { renderOrchestratorGrid } from "./grid.ts";
import { renderOrchestratorList } from "./list.ts";
import type { OrchestratorUiThemeContext, OrchestratorUiThemeRenderer } from "./types.ts";

export interface OrchestratorUiThemeDefinition {
	name: OrchestratorUiTheme;
	description: string;
	render: OrchestratorUiThemeRenderer;
}

const DEFINITIONS: OrchestratorUiThemeDefinition[] = [
	{
		name: "orchestrator-list",
		description: "Compact vertical agent list",
		render: renderOrchestratorList,
	},
	{
		name: "orchestrator-grid",
		description: "Responsive agent cards in up to three columns",
		render: renderOrchestratorGrid,
	},
];

const RENDERERS: Record<OrchestratorUiTheme, OrchestratorUiThemeRenderer> = {
	"orchestrator-list": DEFINITIONS[0]!.render,
	"orchestrator-grid": DEFINITIONS[1]!.render,
};

export function listOrchestratorUiThemes(): OrchestratorUiThemeDefinition[] {
	return DEFINITIONS.map((definition) => ({ ...definition }));
}

export function renderOrchestratorUiTheme(name: OrchestratorUiTheme, context: OrchestratorUiThemeContext): string[] {
	return RENDERERS[name](context);
}
