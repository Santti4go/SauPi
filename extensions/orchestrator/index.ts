import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadOrchestratorConfig, type OrchestratorConfig } from "./config.ts";
import { initializeOrchestrator } from "./init.ts";
import type { AgentInstance } from "./registry.ts";
import { AgentRegistry } from "./registry.ts";
import { AgentScheduler } from "./scheduler.ts";
import { defaultTmuxSession, piTmuxRunner, TmuxManager } from "./tmux.ts";
import { listOrchestratorUiThemes, renderOrchestratorUiTheme } from "./ui-themes/index.ts";
import { pingWorker } from "./worker-client.ts";
import { prepareWorkspace } from "./workspace.ts";

const DEFAULT_CONFIG = ".pi/orchestrator.yaml";
const HEARTBEAT_MS = 2_000;
const JUMP_SHORTCUT = "ctrl+0";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function projectHash(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 10);
}

function currentPiCommand(): string[] {
	const script = process.argv[1];
	const virtual = script?.startsWith("/$bunfs/root/");
	if (script && !virtual && existsSync(script)) return [process.execPath, script];
	const executable = basename(process.execPath).toLowerCase();
	return /^(node|bun)(\.exe)?$/.test(executable) ? ["pi"] : [process.execPath];
}

function rosterLines(registry: AgentRegistry, session: string): string[] {
	const icon = { idle: "●", busy: "◆", starting: "◌", offline: "○", failed: "×" } as const;
	return [
		`AGENTS // ${session}`,
		...registry.all().map((agent) => {
			const location = agent.branch ? ` ${agent.branch}` : "";
			const detail = agent.error ? ` — ${agent.error}` : agent.currentTaskId ? ` — task ${agent.currentTaskId.slice(0, 8)}` : "";
			return `${icon[agent.status]} ${agent.id.padEnd(18)} ${agent.status}${location}${detail}`;
		}),
		`jump: ${JUMP_SHORTCUT}  command: /agent-jump`,
	];
}

export default function orchestrator(pi: ExtensionAPI): void {
	let config: OrchestratorConfig | undefined;
	let registry: AgentRegistry | undefined;
	let scheduler: AgentScheduler | undefined;
	let tmux: TmuxManager | undefined;
	let tmuxSession = "";
	let orchestratorTarget: string | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let currentContext: ExtensionContext | undefined;
	let startupError: string | undefined;
	let requestRosterRender: (() => void) | undefined;
	let activeUiTheme: OrchestratorConfig["orchestratorUiTheme"] = "orchestrator-list";
	const extensionRoot = dirname(fileURLToPath(import.meta.url));
	const workerExtension = resolve(extensionRoot, "worker/index.ts");
	const themeMapExtension = resolve(extensionRoot, "../theme-map/index.ts");
	const themesDirectory = resolve(extensionRoot, "../../themes");

	pi.registerFlag("orchestrator-config", {
		description: "Path to the project orchestrator YAML",
		type: "string",
		default: DEFAULT_CONFIG,
	});

	const configPath = (cwd: string) => {
		const value = pi.getFlag("orchestrator-config");
		return resolve(cwd, typeof value === "string" ? value : DEFAULT_CONFIG);
	};

	const renderRoster = () => {
		if (!currentContext?.hasUI || !registry || !tmuxSession) return;
		const online = registry.all().filter((agent) => agent.status !== "offline" && agent.status !== "failed").length;
		const busy = registry.all().filter((agent) => agent.status === "busy").length;
		currentContext.ui.setStatus("orchestrator", `agents: ${online} online / ${busy} busy`);
		requestRosterRender?.();
	};

	const installRosterWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		// Pi entrega el ancho real de la terminal al componente del widget.
		ctx.ui.setWidget("orchestrator-agents", (tui, theme) => {
			const requestRender = () => tui.requestRender();
			requestRosterRender = requestRender;
			return {
				render(width: number): string[] {
					if (!config || !registry) return [];
					return renderOrchestratorUiTheme(activeUiTheme, {
						agents: registry.all(),
						session: tmuxSession,
						shortcut: JUMP_SHORTCUT,
						theme,
						width,
					});
				},
				invalidate() {},
				dispose() {
					if (requestRosterRender === requestRender) requestRosterRender = undefined;
				},
			};
		});
	};

	const workerSocket = (id: string) => resolve(`/tmp/pi-orchestrator-${process.getuid?.() ?? "user"}`, projectHash(currentContext?.cwd ?? process.cwd()), `${id}.sock`);

	const startPersistent = async (instance: AgentInstance): Promise<void> => {
		if (!config || !registry || !tmux || !currentContext) throw new Error("Orchestrator is not initialized");
		const socketPath = instance.socketPath ?? workerSocket(instance.id);
		try {
			const active = await pingWorker(socketPath).catch(() => undefined);
			if (active) {
				registry.applyHeartbeat(active);
				return;
			}
			registry.update(instance.id, { status: "starting", socketPath, error: undefined });
			const workspace = await prepareWorkspace(pi, instance, config.worktreeRoot);
			await mkdir(resolve(config.runtimeDir, "sessions", instance.id), { recursive: true, mode: 0o700 });
			const targetName = `${tmuxSession}:${instance.id}`;
			const command = [
				"env",
				`PI_ORCHESTRATOR_AGENT_ID=${instance.id}`,
				`PI_ORCHESTRATOR_AGENT_ROLE=${instance.role}`,
				`PI_ORCHESTRATOR_SOCKET=${socketPath}`,
				`PI_ORCHESTRATOR_TMUX_TARGET=${targetName}`,
				...(orchestratorTarget ? [`PI_ORCHESTRATOR_PARENT_TARGET=${orchestratorTarget}`] : []),
				...currentPiCommand(),
				"--approve",
				"--no-extensions",
				"--extension",
				themeMapExtension,
				"--extension",
				workerExtension,
				"--theme",
				themesDirectory,
				"--theme-map-config",
				resolve(currentContext.cwd, ".pi/theme-map.yaml"),
				"--name",
				instance.id,
				"--session-dir",
				resolve(config.runtimeDir, "sessions", instance.id),
				"--session-id",
				`${projectHash(currentContext.cwd)}-${instance.id}`,
				"--append-system-prompt",
				instance.definition.promptPath,
			];
			if (instance.definition.themeProfile) command.push("--theme-profile", instance.definition.themeProfile);
			if (instance.definition.model) command.push("--model", instance.definition.model);
			if (instance.definition.tools) command.push("--tools", instance.definition.tools.join(","));
			const target = await tmux.startWorker({
				session: tmuxSession,
				window: instance.id,
				cwd: workspace.path,
				command,
			});
			registry.update(instance.id, {
				tmuxTarget: target,
				workspacePath: workspace.path,
				branch: workspace.branch,
			});

			const deadline = Date.now() + 20_000;
			while (Date.now() < deadline) {
				const snapshot = await pingWorker(socketPath).catch(() => undefined);
				if (snapshot) {
					registry.applyHeartbeat(snapshot);
					return;
				}
				await new Promise((resolveWait) => setTimeout(resolveWait, 250));
			}
			throw new Error(`Worker ${instance.id} did not become ready within 20 seconds`);
		} catch (error) {
			registry.update(instance.id, { status: "failed", error: errorMessage(error) });
			throw error;
		}
	};

	const heartbeatOnce = async () => {
		if (!registry) return;
		await Promise.all(
			registry
				.all()
				.filter((instance) => instance.definition.lifecycle === "persistent" && instance.socketPath)
				.map(async (instance) => {
					const snapshot = await pingWorker(instance.socketPath!).catch(() => undefined);
					if (snapshot) registry!.applyHeartbeat(snapshot);
					else if (instance.status !== "starting") registry!.update(instance.id, { status: "offline" });
				}),
		);
	};

	const registerDelegateTool = (roles: string[] = []) => {
		const roleList = roles.length > 0 ? roles.join(", ") : "the roles configured in orchestrator.yaml";
		// Pi permite refrescar una tool con el mismo nombre después de cargar la configuración del proyecto.
		pi.registerTool({
			name: "delegate",
			label: "Delegate",
			description: `Delegate one task to an available specialized agent. Valid roles: ${roleList}.`,
			promptSnippet: `Delegate isolated work to one of these exact roles: ${roleList}`,
			promptGuidelines: [`Use delegate only with an exact configured role (${roleList}); never invent or rename agent roles.`],
			parameters: Type.Object({
				agent: Type.String({ description: `Exact configured role. Valid values: ${roleList}` }),
				task: Type.String({ description: "Self-contained task and expected result" }),
			}),
			async execute(_toolCallId, params, signal, onUpdate, _ctx) {
				if (!scheduler) {
					return {
						content: [{ type: "text", text: `Orchestrator is unavailable${startupError ? `: ${startupError}` : ""}` }],
						details: {},
						isError: true,
					};
				}
				try {
					const result = await scheduler.dispatch(params.agent, params.task, signal, (message) => {
						onUpdate?.({ content: [{ type: "text", text: `[${params.agent}] ${message}` }], details: {} });
					});
					const location = result.branch ? `\nWorkspace: ${result.workspacePath}\nBranch: ${result.branch}` : `\nWorkspace: ${result.workspacePath}`;
					return {
						content: [{ type: "text", text: `[${result.agentId}] ${result.output}${location}` }],
						details: result,
						isError: result.isError,
					};
				} catch (error) {
					return { content: [{ type: "text", text: errorMessage(error) }], details: {}, isError: true };
				}
			},
		});
	};

	registerDelegateTool();

	pi.registerCommand("orchestrator-init", {
		description: "Create a documented starter orchestrator config and agent prompts",
		handler: async (_args, ctx) => {
			try {
				const result = await initializeOrchestrator(ctx.cwd);
				if (result.created.length === 0) {
					ctx.ui.notify(`Orchestrator files already exist; nothing changed: ${result.skipped.join(", ")}`, "info");
					return;
				}
				const skipped = result.skipped.length > 0 ? `\nPreserved existing: ${result.skipped.join(", ")}` : "";
				ctx.ui.notify(`Created: ${result.created.join(", ")}${skipped}\nRun /reload to load the new team.`, "info");
			} catch (error) {
				ctx.ui.notify(`Orchestrator init failed: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		currentContext = ctx;
		try {
			config = await loadOrchestratorConfig(configPath(ctx.cwd), ctx.cwd);
			activeUiTheme = config.orchestratorUiTheme;
			registry = new AgentRegistry(config.agents);
			tmux = new TmuxManager(piTmuxRunner(pi));
			if (!(await tmux.available())) throw new Error("tmux is not available");
			tmuxSession = config.tmuxSession ?? defaultTmuxSession(config.projectName, ctx.cwd);
			orchestratorTarget = await tmux.currentTarget();
			scheduler = new AgentScheduler(pi, config, registry, { startPersistent });
			registerDelegateTool(config.agents.map((agent) => agent.name));
			registry.subscribe(renderRoster);
			installRosterWidget(ctx);
			pi.setSessionName("orchestrator");
			if (config.orchestratorThemeProfile) pi.events.emit("theme-map:activate", config.orchestratorThemeProfile);
			renderRoster();
			startupError = undefined;
			heartbeat = setInterval(() => void heartbeatOnce(), HEARTBEAT_MS);
			heartbeat.unref?.();
			const eager = registry
				.all()
				.filter((instance) => instance.definition.lifecycle === "persistent" && instance.definition.start === "eager");
			for (const instance of eager) {
				await startPersistent(instance).catch((error) => ctx.ui.notify(errorMessage(error), "error"));
			}
		} catch (error) {
			startupError = errorMessage(error);
			config = undefined;
			registry = undefined;
			scheduler = undefined;
			if (!isMissingFile(error) && ctx.hasUI) ctx.ui.notify(`Orchestrator config error: ${startupError}`, "error");
		}
	});

	const jump = async (requested: string, ctx: ExtensionContext) => {
		if (!registry || !tmux) {
			ctx.ui.notify(`Orchestrator is unavailable${startupError ? `: ${startupError}` : ""}`, "error");
			return;
		}
		let instance = requested ? registry.get(requested) : undefined;
		if (!instance) {
			const available = registry.all().filter((candidate) => candidate.tmuxTarget);
			if (available.length === 0) {
				ctx.ui.notify("No persistent agent panes are running", "warning");
				return;
			}
			const selected = await ctx.ui.select("Jump to agent", available.map((candidate) => `${candidate.id} — ${candidate.status}`));
			if (!selected) return;
			instance = registry.get(selected.split(" — ")[0]!);
		}
		if (!instance) {
			ctx.ui.notify(`Unknown agent "${requested}"`, "error");
			return;
		}
		if (instance.definition.lifecycle !== "persistent") {
			ctx.ui.notify(`${instance.id} is ephemeral and has no tmux pane`, "warning");
			return;
		}
		if (!instance.tmuxTarget) await startPersistent(instance);
		if (!process.env.TMUX) {
			ctx.ui.notify(`Outside tmux. Attach with: tmux attach-session -t ${tmuxSession}`, "info");
			return;
		}
		await tmux.jump(instance.tmuxTarget!);
	};

	pi.registerCommand("agents", {
		description: "Show configured agent instances and runtime state",
		handler: async (_args, ctx) => {
			if (!registry) {
				ctx.ui.notify(`Orchestrator is unavailable${startupError ? `: ${startupError}` : ""}`, "error");
				return;
			}
			ctx.ui.notify(rosterLines(registry, tmuxSession).join("\n"), "info");
		},
	});

	pi.registerCommand("orchestrator-themes", {
		description: "List or select an orchestrator roster UI theme",
		handler: async (args, ctx) => {
			const themes = listOrchestratorUiThemes();
			const requested = args.trim();
			let selected = themes.find((theme) => theme.name === requested);
			if (requested && !selected) {
				ctx.ui.notify(`Unknown orchestrator theme "${requested}". Available: ${themes.map((theme) => theme.name).join(", ")}`, "error");
				return;
			}
			if (!selected) {
				const choice = await ctx.ui.select(
					"Orchestrator UI theme",
					themes.map((theme) => `${theme.name}${theme.name === activeUiTheme ? " (active)" : ""} — ${theme.description}`),
				);
				if (!choice) return;
				selected = themes.find((theme) => choice.startsWith(theme.name));
			}
			if (!selected) return;
			activeUiTheme = selected.name;
			requestRosterRender?.();
			ctx.ui.notify(`Orchestrator UI theme: ${activeUiTheme}`, "info");
		},
	});

	pi.registerCommand("agent-start", {
		description: "Start a persistent agent instance: /agent-start developer-1",
		handler: async (args, ctx) => {
			const instance = registry?.get(args.trim());
			if (!instance) {
				ctx.ui.notify(`Unknown agent "${args.trim()}"`, "error");
				return;
			}
			if (instance.definition.lifecycle !== "persistent") {
				ctx.ui.notify(`${instance.id} is ephemeral`, "warning");
				return;
			}
			await startPersistent(instance);
			ctx.ui.notify(`${instance.id} is ${instance.status}`, "info");
		},
	});

	pi.registerCommand("agent-stop", {
		description: "Stop one persistent agent instance: /agent-stop developer-1",
		handler: async (args, ctx) => {
			const instance = registry?.get(args.trim());
			if (!instance || !registry || !tmux) {
				ctx.ui.notify(`Unknown agent "${args.trim()}"`, "error");
				return;
			}
			if (instance.definition.lifecycle !== "persistent" || !instance.tmuxTarget) {
				ctx.ui.notify(`${instance.id} has no persistent tmux pane`, "warning");
				return;
			}
			if (instance.status === "busy") {
				const confirmed = await ctx.ui.confirm("Stop busy agent?", `${instance.id} is working on a task. Its current turn will be interrupted.`);
				if (!confirmed) return;
			}
			await tmux.stopWorker(tmuxSession, instance.id);
			registry.update(instance.id, {
				status: "offline",
				tmuxTarget: undefined,
				currentTaskId: undefined,
				error: undefined,
			});
			ctx.ui.notify(`${instance.id} stopped`, "info");
		},
	});

	pi.registerCommand("agent-jump", {
		description: "Select or jump to a persistent agent tmux pane",
		handler: async (args, ctx) => jump(args.trim(), ctx),
	});

	pi.registerCommand("agent-send", {
		description: "Delegate directly: /agent-send <role> <task>",
		handler: async (args, ctx) => {
			const [role, ...rest] = args.trim().split(/\s+/);
			if (!role || rest.length === 0 || !scheduler) {
				ctx.ui.notify("Usage: /agent-send <role> <task>", "warning");
				return;
			}
			try {
				const result = await scheduler.dispatch(role, rest.join(" "), ctx.signal);
				ctx.ui.notify(`[${result.agentId}] ${result.output}`, result.isError ? "error" : "info");
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	pi.registerShortcut(JUMP_SHORTCUT, {
		description: "Select and jump to an agent tmux pane",
		handler: async (ctx) => jump("", ctx),
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = undefined;
		ctx.ui.setWidget("orchestrator-agents", undefined);
		ctx.ui.setStatus("orchestrator", undefined);
		requestRosterRender = undefined;
		if (event.reason === "quit" && tmux && tmuxSession && (await tmux.hasSession(tmuxSession))) {
			await tmux.stopSession(tmuxSession).catch((error) => ctx.ui.notify(errorMessage(error), "error"));
		}
		currentContext = undefined;
	});
}
