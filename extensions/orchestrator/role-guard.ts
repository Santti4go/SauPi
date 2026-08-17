import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalize, collectPathArguments, collectShellPathCandidates, findProtectedTarget, loadProtectionPolicy } from "../protected-paths/policy.ts";
import { evaluateRolePath, loadRolePolicy, policyPath, type RolePolicy } from "./role-policy.ts";

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const SHELL_COMMANDS = new Set(["cat", "cd", "echo", "find", "git", "grep", "head", "ls", "pwd", "rg", "tail", "which"]);

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function shellIsReadOnly(command: string): boolean {
	if (/[><`]|\$\(|&&|\|\||[;&]/.test(command)) return false;
	const words = command.trim().split(/\s+/);
	if (words.length === 0 || !SHELL_COMMANDS.has(words[0]!)) return false;
	if (words[0] === "git") return ["status", "diff", "log", "show", "branch"].includes(words[1] ?? "status");
	return true;
}

function mutableTargets(toolName: string, input: Record<string, unknown>, cwd: string): string[] | undefined {
	if (READ_TOOLS.has(toolName)) return undefined;
	const values = collectPathArguments(input);
	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		if (shellIsReadOnly(command)) return undefined;
		const commandName = command.trim().split(/\s+/)[0];
		for (const value of collectShellPathCandidates(command)) {
			if (!value || value === "-" || value.startsWith("-") || value === commandName || SHELL_COMMANDS.has(value)) continue;
			values.push(value);
		}
		// A mutating shell command can modify its working directory even when no
		// literal target was found (for example, a build tool).
		values.push(cwd);
	}
	return [...new Set(values.map((value) => canonicalize(value, cwd)))];
}

function blocked(ctx: ExtensionContext, role: string, path: string, reason: string, rule?: string) {
	const detail = rule ? ` rule=${rule}` : "";
	const message = `guard:${role} blocked ${path} (${reason}${detail})`;
	if (ctx.hasUI) ctx.ui.notify(message, "warning");
	return { block: true, reason: message };
}

function policyLines(role: string, policyPath: string, projectRoot: string, workspaceRoot: string, globalRules: string[], policy: RolePolicy | undefined): string {
	const rules = policy?.roles.get(role);
	return [
		`Guard role: ${role}`,
		`Policy: ${policyPath}${policy ? "" : " (not found)"}`,
		`Project root: ${projectRoot}`,
		`Workspace root: ${workspaceRoot}`,
		`Global protected: ${globalRules.length ? globalRules.join(", ") : "(none)"}`,
		`Allow: ${rules?.allow.join(", ") || "(none)"}`,
		`Deny: ${rules?.deny.join(", ") || "(none)"}`,
		`Allow outside: ${rules?.allowOutside.join(", ") || "(none)"}`,
	].join("\n");
}

export default function roleGuard(pi: ExtensionAPI): void {
	const role = process.env.PI_ORCHESTRATOR_AGENT_ROLE?.trim() || "unknown";
	const projectRoot = resolve(process.env.PI_ORCHESTRATOR_PROJECT_ROOT || process.cwd());
	const workspaceRoot = resolve(process.env.PI_ORCHESTRATOR_WORKSPACE_ROOT || projectRoot);
	const rolePolicyPath = resolve(process.env.PI_ORCHESTRATOR_POLICY_CONFIG || policyPath(projectRoot));
	const globalPolicyPath = resolve(process.env.PI_ORCHESTRATOR_GLOBAL_PROTECTED_CONFIG || resolve(projectRoot, ".pi", "protected-paths.yaml"));

	const load = async () => {
		const [global, roles] = await Promise.all([
			loadProtectionPolicy(globalPolicyPath, workspaceRoot),
			loadRolePolicy(rolePolicyPath),
		]);
		return { global, roles };
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("orchestrator-role-guard", `guard:${role}`);
		try {
			const { global, roles } = await load();
			if (ctx.hasUI) ctx.ui.notify(`guard:${role} loaded ${roles?.roles.get(role)?.allow.length ?? 0} allow rule(s), ${global?.rules.length ?? 0} global rule(s)`, "info");
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`guard:${role} policy error: ${errorMessage(error)}`, "error");
		}
	});

	pi.registerCommand("protected-paths-policy", {
		description: "Show the effective orchestrator role protection policy",
		handler: async (_args, ctx) => {
			try {
				const { global, roles } = await load();
				ctx.ui.notify(policyLines(role, rolePolicyPath, projectRoot, workspaceRoot, global?.rules.map((rule) => rule.source) ?? [], roles), "info");
			} catch (error) {
				ctx.ui.notify(`guard:${role} policy error: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;
		const targets = mutableTargets(event.toolName, input, ctx.cwd);
		let loaded;
		try {
			// Deliberately reload both files for every preflight: policy edits take
			// effect immediately and malformed policies fail closed for mutations.
			loaded = await load();
		} catch (error) {
			return targets ? blocked(ctx, role, "(policy)", "policy-load-error", errorMessage(error)) : undefined;
		}
		if (!targets) return undefined;
		if (targets.length === 0) return blocked(ctx, role, "(unknown)", "no-target");

		for (const target of targets) {
			if (canonicalize(target, ctx.cwd) === canonicalize(rolePolicyPath, ctx.cwd)) {
				return blocked(ctx, role, target, "global", rolePolicyPath);
			}
			const globalViolation = loaded.global && findProtectedTarget(loaded.global, { paths: [target] }, ctx.cwd);
			if (globalViolation) return blocked(ctx, role, canonicalize(target, ctx.cwd), "global", globalViolation.rule.source);
		}
		const rules = loaded.roles?.roles.get(role);
		if (!rules) return blocked(ctx, role, targets[0]!, "unknown-role");
		for (const target of targets) {
			const decision = evaluateRolePath(rules, workspaceRoot, target);
			if (!decision.allowed) return blocked(ctx, role, target, decision.reason, decision.rule);
		}
		return undefined;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("orchestrator-role-guard", undefined);
	});
}
