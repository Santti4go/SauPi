/**
 * Instruction Inspector
 *
 * Provides `/instructions`, `/instructions full`, and `/instructions watch` to
 * explain which files contribute to an agent's instruction context. It reports:
 * system/append/role prompt files, Pi-provided context files (`AGENTS.md`),
 * skill metadata advertised in the system prompt, and skill files successfully
 * read during the session. The widget and notifications are local TUI output:
 * this extension does not modify the system prompt, inject model messages, or
 * make provider requests.
 *
 * Important semantic boundary: arbitrary files read with the `read` tool are
 * conversation/tool context, not system instructions. At present only known
 * skill files and files named `SKILL.md` are tracked as session reads; therefore
 * `/instructions` is authoritative for Pi's injected context files but is not a
 * complete audit log of every file the agent has read.
 *
 * Snapshot construction is timed locally with `performance.now()`. Reported
 * last/average/max latency covers inventory creation (filesystem matching and
 * prompt hashing), while direct provider overhead remains zero requests, zero
 * injected tokens, and zero direct cost.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface InstructionSnapshot {
	role: string;
	instructionFiles: string[];
	contextFiles: string[];
	advertisedSkills: Array<{ name: string; path: string }>;
	readSkills: string[];
	tools: string[];
	promptChars?: number;
	promptFingerprint?: string;
	overhead?: { lastMs: number; averageMs: number; maxMs: number; samples: number };
}

function unique(values: string[]): string[] {
	return [...new Set(values.map((value) => resolve(value)))];
}

function argvFileValues(flag: "--system-prompt" | "--append-system-prompt"): string[] {
	const values: string[] = [];
	for (let index = 0; index < process.argv.length; index++) {
		const argument = process.argv[index]!;
		if (argument === flag && process.argv[index + 1]) values.push(process.argv[++index]!);
		else if (argument.startsWith(`${flag}=`)) values.push(argument.slice(flag.length + 1));
	}
	return values.filter((value) => isAbsolute(value) || existsSync(resolve(value)));
}

async function contentAppears(path: string, text: string | undefined): Promise<boolean> {
	if (!text || !existsSync(path)) return false;
	const content = await readFile(path, "utf8").catch(() => "");
	return Boolean(content && text.includes(content));
}

async function instructionFiles(options: BuildSystemPromptOptions): Promise<string[]> {
	const projectRoot = resolve(process.env.PI_ORCHESTRATOR_PROJECT_ROOT || options.cwd);
	const rolePrompt = process.env.PI_ORCHESTRATOR_ROLE_PROMPT_PATH;
	const explicit = [
		...argvFileValues("--system-prompt"),
		...argvFileValues("--append-system-prompt"),
		...(rolePrompt ? [rolePrompt] : []),
	].map((path) => resolve(path));
	const candidates = unique([
		resolve(projectRoot, ".pi", "SYSTEM.md"),
		resolve(projectRoot, ".pi", "APPEND_SYSTEM.md"),
		resolve(options.cwd, ".pi", "SYSTEM.md"),
		resolve(options.cwd, ".pi", "APPEND_SYSTEM.md"),
		resolve(homedir(), ".pi", "agent", "SYSTEM.md"),
		resolve(homedir(), ".pi", "agent", "APPEND_SYSTEM.md"),
		...explicit,
	]);
	const loaded: string[] = [];
	for (const path of candidates) {
		if (explicit.includes(path)) {
			if (existsSync(path)) loaded.push(path);
			continue;
		}
		if (await contentAppears(path, options.customPrompt) || await contentAppears(path, options.appendSystemPrompt)) loaded.push(path);
	}
	return loaded;
}

function advertisedSkills(options: BuildSystemPromptOptions): Array<{ name: string; path: string }> {
	const hasRead = !options.selectedTools || options.selectedTools.includes("read");
	if (!hasRead) return [];
	return (options.skills ?? [])
		.filter((skill) => !skill.disableModelInvocation)
		.map((skill) => ({ name: skill.name, path: resolve(skill.filePath) }));
}

async function makeSnapshot(
	options: BuildSystemPromptOptions,
	readSkillPaths: Set<string>,
	effectivePrompt?: string,
): Promise<InstructionSnapshot> {
	const prompt = effectivePrompt;
	return {
		role: process.env.PI_ORCHESTRATOR_AGENT_ROLE?.trim() || "session",
		instructionFiles: await instructionFiles(options),
		contextFiles: (options.contextFiles ?? []).map((file) => resolve(file.path)),
		advertisedSkills: advertisedSkills(options),
		readSkills: [...readSkillPaths].sort(),
		tools: options.selectedTools ?? [],
		...(prompt ? {
			promptChars: prompt.length,
			promptFingerprint: createHash("sha256").update(prompt).digest("hex").slice(0, 10),
		} : {}),
	};
}

function displayPath(path: string, cwd: string, full: boolean): string {
	if (full) return path;
	const local = relative(cwd, path).replaceAll("\\", "/");
	return local && !local.startsWith("../") ? local : basename(path);
}

export function formatInstructionSnapshot(snapshot: InstructionSnapshot, cwd: string, full = false): string {
	const lines = [`Instructions // ${snapshot.role}`, "", "System instruction files"];
	lines.push(...(snapshot.instructionFiles.length ? snapshot.instructionFiles.map((path) => `  - ${displayPath(path, cwd, full)}`) : ["  - <pi default system prompt>"]));
	lines.push("", "Context files");
	lines.push(...(snapshot.contextFiles.length ? snapshot.contextFiles.map((path) => `  - ${displayPath(path, cwd, full)}`) : ["  - (none)"]));
	lines.push("", "Skills advertised to the model");
	lines.push(...(snapshot.advertisedSkills.length
		? snapshot.advertisedSkills.map((skill) => `  - ${skill.name}: ${displayPath(skill.path, cwd, full)}`)
		: ["  - (none)"]));
	lines.push("", "Skill files read during this session");
	lines.push(...(snapshot.readSkills.length ? snapshot.readSkills.map((path) => `  - ${displayPath(path, cwd, full)}`) : ["  - (none)"]));
	lines.push("", `Tools: ${snapshot.tools.join(", ") || "(none)"}`);
	if (snapshot.promptChars !== undefined) lines.push(`Effective prompt: ${snapshot.promptChars} chars · ${snapshot.promptFingerprint}`);
	if (snapshot.overhead) {
		lines.push(
			`Local inventory latency: ${snapshot.overhead.lastMs.toFixed(2)} ms last · ${snapshot.overhead.averageMs.toFixed(2)} ms avg · ${snapshot.overhead.maxMs.toFixed(2)} ms max (${snapshot.overhead.samples})`,
			"Provider overhead: 0 requests · 0 injected tokens · $0 direct cost",
		);
	}
	return lines.join("\n");
}

export default function instructionInspector(pi: ExtensionAPI): void {
	const readSkillPaths = new Set<string>();
	let latest: InstructionSnapshot | undefined;
	let latestOptions: BuildSystemPromptOptions | undefined;
	let widgetVisible = false;
	let latencySamples = 0;
	let latencyTotalMs = 0;
	let latencyMaxMs = 0;

	const measuredSnapshot = async (options: BuildSystemPromptOptions, effectivePrompt?: string): Promise<InstructionSnapshot> => {
		const started = performance.now();
		const snapshot = await makeSnapshot(options, readSkillPaths, effectivePrompt);
		const elapsed = performance.now() - started;
		latencySamples += 1;
		latencyTotalMs += elapsed;
		latencyMaxMs = Math.max(latencyMaxMs, elapsed);
		snapshot.overhead = {
			lastMs: elapsed,
			averageMs: latencyTotalMs / latencySamples,
			maxMs: latencyMaxMs,
			samples: latencySamples,
		};
		return snapshot;
	};

	const updateUi = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || !latest) return;
		const latency = latest.overhead ? ` · ${latest.overhead.lastMs.toFixed(1)}ms` : "";
		ctx.ui.setStatus("instruction-inspector", `instr:${latest.instructionFiles.length + latest.contextFiles.length} files/${latest.advertisedSkills.length} skills${latency}`);
		ctx.ui.setWidget("instruction-inspector", widgetVisible ? formatInstructionSnapshot(latest, ctx.cwd).split("\n") : undefined);
	};

	pi.on("before_agent_start", async (event, ctx) => {
		latestOptions = event.systemPromptOptions;
		latest = await measuredSnapshot(event.systemPromptOptions, event.systemPrompt);
		updateUi(ctx);
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "read" || event.isError) return;
		const input = event.input as { path?: unknown };
		if (typeof input.path !== "string") return;
		const path = resolve(ctx.cwd, input.path.replace(/^@/, ""));
		const knownSkill = latest?.advertisedSkills.some((skill) => skill.path === path) ?? false;
		if (!knownSkill && basename(path) !== "SKILL.md") return;
		readSkillPaths.add(path);
		if (latest) latest = { ...latest, readSkills: [...readSkillPaths].sort() };
		updateUi(ctx);
	});

	pi.registerCommand("instructions", {
		description: "Show files and skills included in the current instruction prompt",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "watch") {
				widgetVisible = !widgetVisible;
				updateUi(ctx);
				ctx.ui.notify(`Instruction widget ${widgetVisible ? "enabled" : "disabled"}`, "info");
				return;
			}
			const commandOptions = (ctx as typeof ctx & { getSystemPromptOptions?: () => BuildSystemPromptOptions }).getSystemPromptOptions?.();
			const options = commandOptions ?? latestOptions;
			if (!options) {
				ctx.ui.notify("Instruction inventory is available after the first agent prompt with this Pi version.", "warning");
				return;
			}
			const snapshot = await measuredSnapshot(options, ctx.getSystemPrompt());
			latest = snapshot;
			updateUi(ctx);
			ctx.ui.notify(formatInstructionSnapshot(snapshot, ctx.cwd, action === "full"), "info");
		},
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("instruction-inspector", undefined);
		ctx.ui.setWidget("instruction-inspector", undefined);
	});
}
