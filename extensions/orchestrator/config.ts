import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parse } from "yaml";

export type AgentLifecycle = "persistent" | "ephemeral";
export type AgentWorkspace = "shared" | "worktree";
export type AgentStartMode = "lazy" | "eager";
export type OrchestratorUiTheme = "orchestrator-list" | "orchestrator-grid";

export interface AgentDefinition {
	name: string;
	description: string;
	count: number;
	promptPath: string;
	lifecycle: AgentLifecycle;
	workspace: AgentWorkspace;
	start: AgentStartMode;
	themeProfile?: string | undefined;
	model?: string | undefined;
	tools?: string[] | undefined;
	extensionPaths?: string[] | undefined;
	cwd: string;
}

export interface OrchestratorConfig {
	version: 1;
	projectName: string;
	orchestratorThemeProfile?: string | undefined;
	orchestratorUiTheme: OrchestratorUiTheme;
	tmuxSession?: string | undefined;
	runtimeDir: string;
	worktreeRoot?: string | undefined;
	agents: AgentDefinition[];
}

interface AgentDefaults {
	lifecycle: AgentLifecycle;
	workspace: AgentWorkspace;
	start: AgentStartMode;
	themeProfile?: string | undefined;
	model?: string | undefined;
	tools?: string[] | undefined;
	extensionPaths?: string[] | undefined;
	cwd: string;
}

function mapping(value: unknown, field: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`"${field}" must be a mapping`);
	return value as Record<string, unknown>;
}

function optionalMapping(value: unknown, field: string): Record<string, unknown> {
	return value === undefined ? {} : mapping(value, field);
}

function text(value: unknown, field: string, fallback?: string): string {
	if (value === undefined && fallback !== undefined) return fallback;
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`"${field}" must be a non-empty string`);
	return value.trim();
}

function optionalText(value: unknown, field: string): string | undefined {
	return value === undefined ? undefined : text(value, field);
}

function choice<T extends string>(value: unknown, field: string, allowed: readonly T[], fallback: T): T {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw new Error(`"${field}" must be one of: ${allowed.join(", ")}`);
	}
	return value as T;
}

function tools(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	const values = typeof value === "string" ? value.split(",") : value;
	if (!Array.isArray(values) || values.some((item) => typeof item !== "string")) {
		throw new Error(`"${field}" must be a comma-separated string or string list`);
	}
	const normalized = [...new Set(values.map((item) => (item as string).trim()).filter(Boolean))];
	return normalized.length > 0 ? normalized : undefined;
}

function paths(value: unknown, field: string, cwd: string): string[] | undefined {
	if (value === undefined) return undefined;
	const values = typeof value === "string" ? [value] : value;
	if (!Array.isArray(values) || values.some((item) => typeof item !== "string" || !(item as string).trim())) {
		throw new Error(`"${field}" must be a non-empty string or string list`);
	}
	return [...new Set(values.map((item) => resolve(cwd, (item as string).trim())))];
}

function count(value: unknown, field: string): number {
	const result = value === undefined ? 1 : value;
	if (!Number.isInteger(result) || (result as number) < 1 || (result as number) > 16) {
		throw new Error(`"${field}" must be an integer between 1 and 16`);
	}
	return result as number;
}

function validateName(value: string, field: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
		throw new Error(`"${field}" may contain only letters, digits, "_" and "-"`);
	}
	return value;
}

function parseDefaults(value: unknown, cwd: string): AgentDefaults {
	const source = optionalMapping(value, "defaults");
	const extensionPaths = paths(source.extensions, "defaults.extensions", cwd);
	return {
		lifecycle: choice(source.lifecycle, "defaults.lifecycle", ["persistent", "ephemeral"], "persistent"),
		workspace: choice(source.workspace, "defaults.workspace", ["shared", "worktree"], "shared"),
		start: choice(source.start, "defaults.start", ["lazy", "eager"], "lazy"),
		...(optionalText(source.themeProfile, "defaults.themeProfile") ? { themeProfile: text(source.themeProfile, "defaults.themeProfile") } : {}),
		...(optionalText(source.model, "defaults.model") ? { model: text(source.model, "defaults.model") } : {}),
		...(tools(source.tools, "defaults.tools") ? { tools: tools(source.tools, "defaults.tools") } : {}),
		...(extensionPaths ? { extensionPaths } : {}),
		cwd: resolve(cwd, optionalText(source.cwd, "defaults.cwd") ?? "."),
	};
}

function parseAgent(value: unknown, index: number, defaults: AgentDefaults, cwd: string): AgentDefinition {
	const source = mapping(value, `agents[${index}]`);
	const prefix = `agents[${index}]`;
	const name = validateName(text(source.name, `${prefix}.name`), `${prefix}.name`);
	const prompt = text(source.prompt, `${prefix}.prompt`);
	const parsedTools = tools(source.tools, `${prefix}.tools`) ?? defaults.tools;
	const extensionPaths = paths(source.extensions, `${prefix}.extensions`, cwd) ?? defaults.extensionPaths;
	const themeProfile = optionalText(source.themeProfile, `${prefix}.themeProfile`) ?? defaults.themeProfile;
	const model = optionalText(source.model, `${prefix}.model`) ?? defaults.model;
	return {
		name,
		description: text(source.description, `${prefix}.description`),
		count: count(source.count, `${prefix}.count`),
		promptPath: resolve(cwd, prompt),
		lifecycle: choice(source.lifecycle, `${prefix}.lifecycle`, ["persistent", "ephemeral"], defaults.lifecycle),
		workspace: choice(source.workspace, `${prefix}.workspace`, ["shared", "worktree"], defaults.workspace),
		start: choice(source.start, `${prefix}.start`, ["lazy", "eager"], defaults.start),
		...(themeProfile ? { themeProfile } : {}),
		...(model ? { model } : {}),
		...(parsedTools ? { tools: parsedTools } : {}),
		...(extensionPaths ? { extensionPaths } : {}),
		cwd: resolve(cwd, optionalText(source.cwd, `${prefix}.cwd`) ?? defaults.cwd),
	};
}

export async function loadOrchestratorConfig(path: string, cwd: string): Promise<OrchestratorConfig> {
	const source = mapping(parse(await readFile(path, "utf8")), "root");
	if (source.version !== 1) throw new Error('"version" must be 1');
	if (!Array.isArray(source.agents) || source.agents.length === 0) throw new Error('"agents" must be a non-empty list');
	const defaults = parseDefaults(source.defaults, cwd);
	const agents = source.agents.map((agent, index) => parseAgent(agent, index, defaults, cwd));
	const names = new Set<string>();
	for (const agent of agents) {
		if (names.has(agent.name)) throw new Error(`duplicate agent name "${agent.name}"`);
		names.add(agent.name);
		const promptStat = await stat(agent.promptPath).catch(() => undefined);
		if (!promptStat?.isFile()) throw new Error(`agent "${agent.name}" prompt not found: ${agent.promptPath}`);
	}

	const orchestrator = optionalMapping(source.orchestrator, "orchestrator");
	const tmux = optionalMapping(source.tmux, "tmux");
	const runtime = optionalMapping(source.runtime, "runtime");
	const inferredProjectName = basename(cwd).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
	const projectName = validateName(
		optionalText(source.projectName, "projectName") ?? (inferredProjectName || "project"),
		"projectName",
	);
	const orchestratorThemeProfile = optionalText(orchestrator.themeProfile, "orchestrator.themeProfile");
	const orchestratorUiTheme = choice(
		orchestrator.uiTheme,
		"orchestrator.uiTheme",
		["orchestrator-list", "orchestrator-grid"],
		"orchestrator-list",
	);
	const configuredTmuxSession = optionalText(tmux.session, "tmux.session");
	const tmuxSession = configuredTmuxSession ? validateName(configuredTmuxSession, "tmux.session") : undefined;
	const worktreeRoot = optionalText(runtime.worktreeRoot, "runtime.worktreeRoot");

	return {
		version: 1,
		projectName,
		...(orchestratorThemeProfile ? { orchestratorThemeProfile } : {}),
		orchestratorUiTheme,
		...(tmuxSession ? { tmuxSession } : {}),
		runtimeDir: resolve(cwd, optionalText(runtime.directory, "runtime.directory") ?? ".pi/orchestrator"),
		...(worktreeRoot ? { worktreeRoot: resolve(cwd, worktreeRoot) } : {}),
		agents,
	};
}
