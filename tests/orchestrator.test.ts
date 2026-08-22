import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { loadOrchestratorConfig, skillCliArgs } from "../extensions/orchestrator/config.ts";
import { initializeOrchestrator } from "../extensions/orchestrator/init.ts";
import { encodeMessage, parseMessage } from "../extensions/orchestrator/protocol.ts";
import { AgentRegistry } from "../extensions/orchestrator/registry.ts";
import { evaluateRolePath, loadRolePolicy } from "../extensions/orchestrator/role-policy.ts";
import roleGuard from "../extensions/orchestrator/role-guard.ts";
import { defaultTmuxSession, TmuxManager, type TmuxCommandRunner } from "../extensions/orchestrator/tmux.ts";
import { pingWorker, runWorkerTask } from "../extensions/orchestrator/worker-client.ts";
import orchestratorWorker from "../extensions/orchestrator/worker/index.ts";
import { listOrchestratorUiThemes, renderOrchestratorUiTheme } from "../extensions/orchestrator/ui-themes/index.ts";

async function fixture(yaml: string): Promise<{ cwd: string; path: string }> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-orchestrator-config-"));
	await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
	await writeFile(join(cwd, ".pi", "agents", "developer.md"), "# Developer\n");
	const path = join(cwd, ".pi", "orchestrator.yaml");
	await writeFile(path, yaml);
	return { cwd, path };
}

test("initializes a documented example without overwriting existing files", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-orchestrator-init-"));
	const first = await initializeOrchestrator(cwd);
	assert.deepEqual(first.created, [".pi/orchestrator.yaml", ".pi/orchestrator-policy.yaml", ".pi/prompts/agent1.md", ".pi/prompts/agent2.md"]);
	assert.deepEqual(first.skipped, []);

	const yamlPath = join(cwd, ".pi", "orchestrator.yaml");
	const yaml = await readFile(yamlPath, "utf8");
	assert.match(yaml, /start: lazy # lazy starts on first use/);
	assert.match(yaml, /lifecycle: ephemeral # This role gets a clean one-task session/);
	assert.match(await readFile(join(cwd, ".pi", "prompts", "agent1.md"), "utf8"), /Agent 1 — Developer/);
	const config = await loadOrchestratorConfig(yamlPath, cwd);
	assert.deepEqual(config.agents.map((agent) => agent.name), ["agent1", "agent2"]);

	await writeFile(yamlPath, "custom: true\n");
	const second = await initializeOrchestrator(cwd);
	assert.deepEqual(second.created, []);
	assert.deepEqual(second.skipped, [".pi/orchestrator.yaml", ".pi/orchestrator-policy.yaml", ".pi/prompts/agent1.md", ".pi/prompts/agent2.md"]);
	assert.equal(await readFile(yamlPath, "utf8"), "custom: true\n");
});

test("loads and expands agent pools from orchestrator YAML", async () => {
	const { cwd, path } = await fixture(`
version: 1
projectName: demo
orchestrator:
  themeProfile: orchestrator
  uiTheme: orchestrator-grid
defaults:
  lifecycle: persistent
  workspace: shared
  model: gpt-configured
  skills:
    - .pi/skills/common/SKILL.md
agents:
  - name: developer
    description: Builds features
    count: 2
    prompt: .pi/agents/developer.md
    workspace: worktree
    tools: read, edit, write
    extensions:
      - .pi/extensions/audit.ts
    skills:
      - .pi/skills/developer/SKILL.md
  - name: scout
    description: Discovers every skill
    prompt: .pi/agents/developer.md
    skills: all
`);
	const config = await loadOrchestratorConfig(path, cwd);
	assert.equal(config.projectName, "demo");
	assert.equal(config.orchestratorThemeProfile, "orchestrator");
	assert.equal(config.orchestratorUiTheme, "orchestrator-grid");
	assert.equal(config.agents[0]?.promptPath, join(cwd, ".pi", "agents", "developer.md"));
	assert.equal(config.agents[0]?.model, "gpt-configured");
	assert.deepEqual(config.agents[0]?.tools, ["read", "edit", "write"]);
	assert.deepEqual(config.agents[0]?.extensionPaths, [join(cwd, ".pi", "extensions", "audit.ts")]);
	assert.deepEqual(config.agents[0]?.skills, [
		join(cwd, ".pi", "skills", "common", "SKILL.md"),
		join(cwd, ".pi", "skills", "developer", "SKILL.md"),
	]);
	assert.deepEqual(skillCliArgs(config.agents[0]!.skills), [
		"--no-skills",
		"--skill", join(cwd, ".pi", "skills", "common", "SKILL.md"),
		"--skill", join(cwd, ".pi", "skills", "developer", "SKILL.md"),
	]);
	assert.equal(config.agents[1]?.skills, "all");
	assert.deepEqual(skillCliArgs(config.agents[1]!.skills), []);

	const registry = new AgentRegistry(config.agents);
	assert.deepEqual(registry.all().map((agent) => agent.id), ["developer-1", "developer-2", "scout-1"]);
	registry.applyHeartbeat({
		id: "developer-1",
		role: "developer",
		status: "idle",
		model: "gpt-heartbeat",
		pid: 42,
		tmuxTarget: "pi-demo:developer-1",
		updatedAt: new Date(0).toISOString(),
	});
	assert.equal(registry.get("developer-1")?.status, "idle");
	assert.equal(registry.get("developer-1")?.model, "gpt-heartbeat");
	assert.equal(registry.get("developer-1")?.tmuxTarget, "pi-demo:developer-1");
	registry.update("developer-1", { status: "busy", currentTaskId: "reserved-task" });
	registry.applyHeartbeat({
		id: "developer-1",
		role: "developer",
		status: "idle",
		pid: 42,
		tmuxTarget: "pi-demo:developer-1",
		updatedAt: new Date(1).toISOString(),
	});
	assert.equal(registry.get("developer-1")?.status, "busy");
	assert.equal(registry.get("developer-1")?.currentTaskId, "reserved-task");

	const grid = renderOrchestratorUiTheme("orchestrator-grid", {
		agents: registry.all(),
		session: "pi-demo",
		shortcut: "ctrl+0",
		theme: { fg: (_color: string, value: string) => value } as never,
		width: 60,
	});
	assert.ok(grid.some((line) => line.includes("developer-1") && line.includes("developer-2")));
	assert.ok(grid.some((line) => line.includes("◆ busy")));
	assert.ok(grid.some((line) => line.includes("model gpt-heartbeat")));
	assert.ok(grid.every((line) => visibleWidth(line) <= 60));
	assert.deepEqual(listOrchestratorUiThemes().map((theme) => theme.name), ["orchestrator-list", "orchestrator-grid"]);
});

test("enforces allow, deny, and explicit outside rules for roles", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-orchestrator-role-policy-"));
	const path = join(cwd, "policy.yaml");
	await writeFile(path, `version: 1
roles:
  developer:
    allow: [src/**]
    deny: [src/secrets/**]
    allowOutside: [/tmp/pi-output/**]
`);
	const policy = await loadRolePolicy(path);
	const rules = policy?.roles.get("developer");
	assert.ok(rules);
	assert.equal(evaluateRolePath(rules, cwd, join(cwd, "src", "index.ts")).allowed, true);
	assert.deepEqual(evaluateRolePath(rules, cwd, join(cwd, "src", "secrets", "key.ts")), { allowed: false, reason: "deny", rule: "src/secrets/**" });
	assert.deepEqual(evaluateRolePath(rules, cwd, join(cwd, "README.md")), { allowed: false, reason: "no-allow" });
	assert.equal(evaluateRolePath(rules, cwd, "/tmp/pi-output/report.txt").allowed, true);
	assert.deepEqual(evaluateRolePath(rules, cwd, "/tmp/other/report.txt"), { allowed: false, reason: "outside-root" });
});

test("role guard reloads policy and applies global, deny, and allow precedence", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-orchestrator-role-guard-"));
	await mkdir(join(cwd, ".pi"));
	await mkdir(join(cwd, "src", "private"), { recursive: true });
	await writeFile(join(cwd, ".pi", "protected-paths.yaml"), "protectedPaths:\n  - src/global.ts\n");
	const policyPath = join(cwd, ".pi", "orchestrator-policy.yaml");
	await writeFile(policyPath, "version: 1\nroles:\n  developer:\n    allow: [src/**]\n    deny: [src/private/**]\n");
	const previous = {
		role: process.env.PI_ORCHESTRATOR_AGENT_ROLE,
		project: process.env.PI_ORCHESTRATOR_PROJECT_ROOT,
		workspace: process.env.PI_ORCHESTRATOR_WORKSPACE_ROOT,
		policy: process.env.PI_ORCHESTRATOR_POLICY_CONFIG,
		global: process.env.PI_ORCHESTRATOR_GLOBAL_PROTECTED_CONFIG,
	};
	Object.assign(process.env, {
		PI_ORCHESTRATOR_AGENT_ROLE: "developer",
		PI_ORCHESTRATOR_PROJECT_ROOT: cwd,
		PI_ORCHESTRATOR_WORKSPACE_ROOT: cwd,
		PI_ORCHESTRATOR_POLICY_CONFIG: policyPath,
		PI_ORCHESTRATOR_GLOBAL_PROTECTED_CONFIG: join(cwd, ".pi", "protected-paths.yaml"),
	});
	const handlers = new Map<string, (...args: any[]) => any>();
	const pi = {
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		registerCommand() {},
	} as unknown as ExtensionAPI;
	const ctx = { cwd, hasUI: false, ui: { notify() {}, setStatus() {} } } as unknown as ExtensionContext;
	try {
		roleGuard(pi);
		const hook = handlers.get("tool_call");
		assert.ok(hook);
		assert.equal(await hook({ toolName: "write", input: { path: "src/index.ts" } }, ctx), undefined);
		assert.match((await hook({ toolName: "write", input: { path: "src/private/key.ts" } }, ctx)).reason, /deny/);
		assert.match((await hook({ toolName: "write", input: { path: "src/global.ts" } }, ctx)).reason, /global/);
		assert.match((await hook({ toolName: "write", input: { path: "README.md" } }, ctx)).reason, /no-allow/);
		assert.equal(await hook({ toolName: "read", input: { path: "README.md" } }, ctx), undefined);
		await writeFile(policyPath, "version: 1\nroles:\n  developer:\n    allow: [src/**, README.md]\n    deny: [src/private/**]\n");
		assert.equal(await hook({ toolName: "write", input: { path: "README.md" } }, ctx), undefined);
	} finally {
		for (const [key, value] of Object.entries({
			PI_ORCHESTRATOR_AGENT_ROLE: previous.role,
			PI_ORCHESTRATOR_PROJECT_ROOT: previous.project,
			PI_ORCHESTRATOR_WORKSPACE_ROOT: previous.workspace,
			PI_ORCHESTRATOR_POLICY_CONFIG: previous.policy,
			PI_ORCHESTRATOR_GLOBAL_PROTECTED_CONFIG: previous.global,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("rejects duplicate agent roles and missing prompts", async () => {
	const { cwd, path } = await fixture(`
version: 1
agents:
  - name: developer
    description: First
    prompt: .pi/agents/developer.md
  - name: developer
    description: Duplicate
    prompt: .pi/agents/developer.md
`);
	await assert.rejects(loadOrchestratorConfig(path, cwd), /duplicate agent name/);

	await writeFile(path, `
version: 1
agents:
  - name: scout
    description: Missing prompt
    prompt: .pi/agents/missing.md
`);
	await assert.rejects(loadOrchestratorConfig(path, cwd), /prompt not found/);

	await writeFile(path, `
version: 1
orchestrator:
  uiTheme: unknown-grid
agents:
  - name: developer
    description: Builds
    prompt: .pi/agents/developer.md
`);
	await assert.rejects(loadOrchestratorConfig(path, cwd), /orchestrator.uiTheme/);
});

test("worker protocol uses one JSON object per LF-delimited record", () => {
	const encoded = encodeMessage({ type: "task", taskId: "t-1", prompt: "line 1\nline 2" });
	assert.equal(encoded.endsWith("\n"), true);
	assert.deepEqual(parseMessage(encoded.trimEnd()), { type: "task", taskId: "t-1", prompt: "line 1\nline 2" });
});

test("tmux manager creates a named project session and safely quotes the worker command", async () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	let sessionExists = false;
	const windows: string[] = [];
	const runner: TmuxCommandRunner = {
		async exec(command, args) {
			calls.push({ command, args });
			if (args[0] === "has-session") return { stdout: "", stderr: "", code: sessionExists ? 0 : 1 };
			if (args[0] === "list-windows") return { stdout: windows.join("\n"), stderr: "", code: 0 };
			if (args[0] === "new-session") {
				sessionExists = true;
				windows.push(args[args.indexOf("-n") + 1]!);
				return { stdout: "", stderr: "", code: 0 };
			}
			if (args[0] === "new-window") {
				windows.push(args[args.indexOf("-n") + 1]!);
				return { stdout: "", stderr: "", code: 0 };
			}
			if (args[0] === "display-message") return { stdout: "pi-demo:1.0\n", stderr: "", code: 0 };
			return { stdout: "", stderr: "", code: 0 };
		},
	};
	const tmux = new TmuxManager(runner);
	const target = await tmux.startWorker({
		session: "pi-demo",
		window: "developer-1",
		cwd: "/tmp/project",
		command: ["env", "PROMPT=it's safe", "pi", "--no-extensions"],
	});
	assert.equal(target, "pi-demo:1.0");
	const create = calls.find((call) => call.args[0] === "new-session");
	assert.ok(create);
	assert.match(create.args.at(-1) ?? "", /^exec 'env'/);
	assert.match(create.args.at(-1) ?? "", /'PROMPT=it'"'"'s safe'/);
	assert.equal(defaultTmuxSession("Demo Project", "/tmp/project"), defaultTmuxSession("Demo Project", "/tmp/project"));
	await tmux.respawnWorker("pi-demo", "developer-1", "/tmp/project", ["pi", "--no-extensions"]);
	assert.ok(calls.some((call) => call.args[0] === "respawn-window" && call.args.includes("pi-demo:developer-1")));
	await tmux.stopWorker("pi-demo", "developer-1");
	assert.ok(calls.some((call) => call.args[0] === "kill-window" && call.args.at(-1) === "pi-demo:developer-1"));
	await tmux.stopSession("pi-demo");
	assert.ok(calls.some((call) => call.args[0] === "kill-session" && call.args.at(-1) === "pi-demo"));
});

test("tmux manager recovers when another worker creates the session concurrently", async () => {
	const calls: string[] = [];
	let sessionProbes = 0;
	const runner: TmuxCommandRunner = {
		async exec(_command, args) {
			calls.push(args[0]!);
			if (args[0] === "has-session") return { stdout: "", stderr: "", code: sessionProbes++ === 0 ? 1 : 0 };
			if (args[0] === "new-session") return { stdout: "", stderr: "duplicate session: pi-demo", code: 1 };
			if (args[0] === "list-windows") return { stdout: "orchestrator\n", stderr: "", code: 0 };
			if (args[0] === "display-message") return { stdout: "pi-demo:2.0\n", stderr: "", code: 0 };
			return { stdout: "", stderr: "", code: 0 };
		},
	};

	const target = await new TmuxManager(runner).startWorker({
		session: "pi-demo",
		window: "marketing-1",
		cwd: "/tmp/project",
		command: ["pi", "--no-extensions"],
	});

	assert.equal(target, "pi-demo:2.0");
	assert.deepEqual(calls.slice(0, 5), ["has-session", "new-session", "has-session", "list-windows", "new-window"]);
});

test("persistent worker accepts a socket task and injects it through Pi", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-orchestrator-worker-"));
	const socketPath = join(directory, "developer-1.sock");
	const previous = {
		id: process.env.PI_ORCHESTRATOR_AGENT_ID,
		role: process.env.PI_ORCHESTRATOR_AGENT_ROLE,
		socket: process.env.PI_ORCHESTRATOR_SOCKET,
		target: process.env.PI_ORCHESTRATOR_TMUX_TARGET,
	};
	process.env.PI_ORCHESTRATOR_AGENT_ID = "developer-1";
	process.env.PI_ORCHESTRATOR_AGENT_ROLE = "developer";
	process.env.PI_ORCHESTRATOR_SOCKET = socketPath;
	process.env.PI_ORCHESTRATOR_TMUX_TARGET = "pi-demo:developer-1";

	const handlers = new Map<string, (...args: any[]) => any>();
	let idle = true;
	let injected = "";
	const ctx = {
		isIdle: () => idle,
		abort() {},
		model: { id: "gpt-worker" },
		ui: { setTitle() {}, setStatus() {}, setToolsExpanded() {} },
	} as unknown as ExtensionContext;
	const pi = {
		on(name: string, handler: (...args: any[]) => any) {
			handlers.set(name, handler);
		},
		setSessionName() {},
		registerCommand() {},
		registerShortcut() {},
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		sendUserMessage(prompt: string) {
			injected = prompt;
			idle = false;
			void handlers.get("agent_start")?.({}, ctx);
			setImmediate(() => {
				idle = true;
				void handlers.get("agent_end")?.(
					{
						messages: [
							{ role: "assistant", content: [{ type: "text", text: "worker complete" }], stopReason: "stop" },
						],
					},
					ctx,
				);
			});
		},
	} as unknown as ExtensionAPI;

	try {
		orchestratorWorker(pi);
		await handlers.get("session_start")?.({}, ctx);
		const snapshot = await pingWorker(socketPath);
		assert.equal(snapshot.id, "developer-1");
		assert.equal(snapshot.status, "idle");
		assert.equal(snapshot.model, "gpt-worker");
		const result = await runWorkerTask(socketPath, "task-1", "Implement it", undefined);
		assert.equal(injected, "Implement it");
		assert.deepEqual(result, { output: "worker complete", isError: false });
		await handlers.get("session_shutdown")?.({}, ctx);
	} finally {
		for (const [key, value] of Object.entries({
			PI_ORCHESTRATOR_AGENT_ID: previous.id,
			PI_ORCHESTRATOR_AGENT_ROLE: previous.role,
			PI_ORCHESTRATOR_SOCKET: previous.socket,
			PI_ORCHESTRATOR_TMUX_TARGET: previous.target,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
