import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findProtectedTarget, loadProtectionPolicy } from "./policy.ts";

const DEFAULT_CONFIG = ".pi/protected-paths.yaml";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function protectedPaths(pi: ExtensionAPI): void {
	// Pi expone esta opción como --protected-paths-config <path>.
	pi.registerFlag("protected-paths-config", {
		description: "YAML file containing paths that non-read tools cannot access",
		type: "string",
		default: DEFAULT_CONFIG,
	});

	const getConfigPath = (cwd: string): string => {
		const configured = pi.getFlag("protected-paths-config");
		return resolve(cwd, typeof configured === "string" ? configured : DEFAULT_CONFIG);
	};

	pi.on("session_start", async (_event, ctx) => {
		try {
			const policy = await loadProtectionPolicy(getConfigPath(ctx.cwd), ctx.cwd);
			if (!ctx.hasUI) return;
			if (policy) ctx.ui.notify(`Protected paths: ${policy.rules.length - 1} rule(s) loaded`, "info");
			else ctx.ui.notify(`Protected paths config not found: ${getConfigPath(ctx.cwd)}`, "warning");
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Invalid protected paths config: ${errorMessage(error)}`, "error");
		}
	});

	// Pi ejecuta tool_call antes de la herramienta y respeta el resultado block.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "read") return undefined;

		let policy;
		try {
			policy = await loadProtectionPolicy(getConfigPath(ctx.cwd), ctx.cwd);
		} catch (error) {
			return { block: true, reason: `Protected paths policy could not be loaded: ${errorMessage(error)}` };
		}

		if (!policy) return undefined;

		const input = event.input as Record<string, unknown>;
		const shellCommand = event.toolName === "bash" && typeof input.command === "string" ? input.command : undefined;
		const violation = findProtectedTarget(policy, input, ctx.cwd, shellCommand);
		if (!violation) return undefined;

		const reason = `Tool "${event.toolName}" cannot access protected path "${violation.candidate}"`;
		if (ctx.hasUI) ctx.ui.notify(reason, "warning");
		return { block: true, reason };
	});
}
