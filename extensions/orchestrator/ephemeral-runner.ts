import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { skillCliArgs, type AgentDefinition } from "./config.ts";

export interface GuardEnvironment {
	role: string;
	projectRoot: string;
	workspaceRoot: string;
	policyConfig: string;
	globalProtectedConfig: string;
	extensionPath: string;
	instructionInspectorPath: string;
}

export interface AgentRunResult {
	output: string;
	isError: boolean;
	exitCode: number;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
	};
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const bunVirtual = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !bunVirtual && existsSync(currentScript)) return { command: process.execPath, args: [currentScript, ...args] };
	const executable = basename(process.execPath).toLowerCase();
	return /^(node|bun)(\.exe)?$/.test(executable) ? { command: "pi", args } : { command: process.execPath, args };
}

function assistantText(message: Record<string, unknown>): string {
	const content = message.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is { type: string; text: string } => {
			return Boolean(item && typeof item === "object" && (item as Record<string, unknown>).type === "text" && typeof (item as Record<string, unknown>).text === "string");
		})
		.map((item) => item.text)
		.join("\n");
}

export async function runEphemeralAgent(
	definition: AgentDefinition,
	task: string,
	cwd: string,
	signal: AbortSignal | undefined,
	onProgress: ((message: string) => void) | undefined,
	guard: GuardEnvironment,
): Promise<AgentRunResult> {
	const args = [
		"--mode",
		"json",
		"--print",
		"--no-session",
		"--no-extensions",
		"--extension",
		guard.extensionPath,
		"--extension",
		guard.instructionInspectorPath,
		"--append-system-prompt",
		definition.promptPath,
	];
	args.push(...skillCliArgs(definition.skills));
	if (definition.model) args.push("--model", definition.model);
	if (definition.tools) args.push("--tools", definition.tools.join(","));
	args.push(`Task: ${task}`);

	const invocation = piInvocation(args);
	const child = spawn(invocation.command, invocation.args, {
		cwd,
		env: {
			...process.env,
			PI_ORCHESTRATOR_AGENT_ROLE: guard.role,
			PI_ORCHESTRATOR_PROJECT_ROOT: guard.projectRoot,
			PI_ORCHESTRATOR_WORKSPACE_ROOT: guard.workspaceRoot,
			PI_ORCHESTRATOR_POLICY_CONFIG: guard.policyConfig,
			PI_ORCHESTRATOR_GLOBAL_PROTECTED_CONFIG: guard.globalProtectedConfig,
			PI_ORCHESTRATOR_ROLE_PROMPT_PATH: definition.promptPath,
		},
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const decoder = new StringDecoder("utf8");
	let stdoutBuffer = "";
	let stderr = "";
	let finalOutput = "";
	let stopReason = "";
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

	const processLine = (line: string) => {
		if (!line.trim()) return;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}
		if (event.type === "tool_execution_start") {
			onProgress?.(`tool: ${String(event.toolName ?? "unknown")}`);
		}
		if (event.type !== "message_end" || !event.message || typeof event.message !== "object") return;
		const message = event.message as Record<string, unknown>;
		if (message.role !== "assistant") return;
		const output = assistantText(message);
		if (output) {
			finalOutput = output;
			onProgress?.(output.slice(-500));
		}
		stopReason = typeof message.stopReason === "string" ? message.stopReason : stopReason;
		if (message.usage && typeof message.usage === "object") {
			const current = message.usage as Record<string, unknown>;
			usage.input += Number(current.input) || 0;
			usage.output += Number(current.output) || 0;
			usage.cacheRead += Number(current.cacheRead) || 0;
			usage.cacheWrite += Number(current.cacheWrite) || 0;
			if (current.cost && typeof current.cost === "object") usage.cost += Number((current.cost as Record<string, unknown>).total) || 0;
		}
	};

	child.stdout.on("data", (chunk) => {
		stdoutBuffer += decoder.write(chunk);
		while (true) {
			const newline = stdoutBuffer.indexOf("\n");
			if (newline < 0) break;
			processLine(stdoutBuffer.slice(0, newline).replace(/\r$/, ""));
			stdoutBuffer = stdoutBuffer.slice(newline + 1);
		}
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	const abort = () => {
		child.kill("SIGTERM");
		setTimeout(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
		}, 5_000).unref?.();
	};
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });

	const exitCode = await new Promise<number>((resolve) => {
		child.once("error", () => resolve(1));
		child.once("close", (code) => resolve(code ?? 1));
	});
	signal?.removeEventListener("abort", abort);
	stdoutBuffer += decoder.end();
	if (stdoutBuffer.trim()) processLine(stdoutBuffer.replace(/\r$/, ""));
	const isError = exitCode !== 0 || stopReason === "error" || stopReason === "aborted";
	return {
		output: finalOutput || stderr.trim() || "(no output)",
		isError,
		exitCode,
		usage,
	};
}
