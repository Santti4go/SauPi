import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const FILES = [
	{
		path: ".pi/prompts/agent1.md",
		content: `# Agent 1 — Developer

Implement the delegated task. Inspect the existing code first, keep changes scoped, run relevant tests, and report changed files, validation results, and remaining risks.
`,
	},
	{
		path: ".pi/prompts/agent2.md",
		content: `# Agent 2 — Researcher

Investigate the delegated question using project evidence. Return a concise report with relevant file paths, verified facts, assumptions, and recommended next steps. Do not modify files.
`,
	},
] as const;

export interface OrchestratorInitResult {
	created: string[];
	skipped: string[];
}

function projectName(cwd: string): string {
	return basename(cwd).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "") || "project";
}

function configTemplate(cwd: string): string {
	return `# Pi orchestrator configuration. Paths are relative to the project root.
version: 1 # Required schema version. Keep this at 1.
projectName: ${JSON.stringify(projectName(cwd))} # Names the team and the default tmux session.

orchestrator:
  uiTheme: orchestrator-grid # Roster layout: orchestrator-grid or orchestrator-list.
  # themeProfile: orchestrator # Optional theme-map profile for the parent session.

defaults:
  lifecycle: persistent # persistent keeps a reusable tmux worker; ephemeral creates a fresh worker per task.
  workspace: shared # shared uses this checkout; worktree creates an isolated Git worktree per worker.
  start: lazy # lazy starts on first use; eager starts persistent workers when Pi opens.
  cwd: . # Default working directory for every agent.
  # model: provider/model-id # Optional Pi model override inherited by every agent.
  tools: read, grep, find, ls # Allowed Pi tools. Use a comma-separated string or YAML list.
  # extensions: # Optional explicit extensions loaded by every worker (paths relative to project root).
  #   - ../PiCommon/extensions/provider-gate/index.ts
  # themeProfile: developer # Optional theme-map profile inherited by every agent.

agents:
  - name: agent1 # Delegation role and instance prefix. Allowed: letters, digits, underscore, hyphen.
    description: Implements scoped changes and validates them # Helps the orchestrator choose this role.
    count: 1 # Number of instances. Allowed range: 1-16.
    prompt: .pi/prompts/agent1.md # System instructions appended to the worker prompt.
    tools: read, grep, find, ls, bash, edit, write # Overrides defaults.tools for this role.
    # model: provider/model-id # Overrides defaults.model for this role.
    # lifecycle: persistent # Overrides defaults.lifecycle.
    # workspace: shared # Overrides defaults.workspace.
    # start: lazy # Overrides defaults.start for persistent workers.
    # cwd: . # Overrides defaults.cwd.
    # themeProfile: developer # Overrides defaults.themeProfile.

  - name: agent2
    description: Researches the codebase and returns evidence-backed findings
    count: 1
    prompt: .pi/prompts/agent2.md
    lifecycle: ephemeral # This role gets a clean one-task session and no persistent tmux pane.
    tools: read, grep, find, ls

runtime:
  directory: .pi/orchestrator # Stores worker sessions and runtime state.
  # worktreeRoot: .pi/worktrees # Optional location for isolated Git worktrees.

# tmux:
#   session: pi-my-project # Optional fixed session name; omit it for an automatic unique name.
`;
}

async function createExclusive(path: string, content: string): Promise<boolean> {
	try {
		await writeFile(path, content, { encoding: "utf8", flag: "wx" });
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
		throw error;
	}
}

export async function initializeOrchestrator(cwd: string): Promise<OrchestratorInitResult> {
	await mkdir(resolve(cwd, ".pi/prompts"), { recursive: true });
	const entries = [{ path: ".pi/orchestrator.yaml", content: configTemplate(cwd) }, ...FILES];
	const result: OrchestratorInitResult = { created: [], skipped: [] };
	for (const entry of entries) {
		const created = await createExclusive(resolve(cwd, entry.path), entry.content);
		result[created ? "created" : "skipped"].push(entry.path);
	}
	return result;
}
