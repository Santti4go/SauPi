import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const EXTENSION_NAME = "CodexUsage";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const POLL_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

type AuthFile = {
	tokens?: {
		access_token?: unknown;
		refresh_token?: unknown;
		account_id?: unknown;
		[key: string]: unknown;
	};
	[key: string]: unknown;
};

type CodexAuth = {
	accessToken: string;
	accountId: string;
	refreshToken?: string;
};

class UsageHttpError extends Error {
	constructor(readonly status: number) {
		super(`HTTP ${status}`);
	}
}

type UsageResponse = {
	rate_limit?: {
		primary_window?: UsageWindow;
		secondary_window?: UsageWindow;
		allowed?: boolean;
		limit_reached?: boolean;
	};
};

type UsageWindow = {
		used_percent?: unknown;
		reset_after_seconds?: unknown;
		reset_at?: unknown;
};

type CodexUsage = {
		fiveHourPercent: number;
		weeklyPercent: number;
		fiveHourResetAt?: number;
		weeklyResetAt?: number;
};

function authPath(): string {
	return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
}

async function readCodexAuth(): Promise<CodexAuth | undefined> {
	try {
		const parsed = JSON.parse(await readFile(authPath(), "utf8")) as AuthFile;
		const accessToken = parsed.tokens?.access_token;
		const refreshToken = parsed.tokens?.refresh_token;
		const accountId = parsed.tokens?.account_id;
		if (typeof accessToken !== "string" || !accessToken || typeof accountId !== "string" || !accountId) {
			return undefined;
		}
		return {
			accessToken,
			accountId,
			...(typeof refreshToken === "string" && refreshToken ? { refreshToken } : {}),
		};
	} catch {
		// Missing or malformed auth.json is reported through the footer status.
		return undefined;
	}
}

const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

async function refreshCodexAuth(auth: CodexAuth): Promise<CodexAuth> {
	if (!auth.refreshToken) throw new Error("La sesión de Codex requiere volver a autenticarse");
	const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: auth.refreshToken,
			client_id: CODEX_OAUTH_CLIENT_ID,
		}),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`No se pudo renovar la sesión (HTTP ${response.status})`);
	const result = await response.json() as { access_token?: unknown; refresh_token?: unknown };
	if (typeof result.access_token !== "string" || typeof result.refresh_token !== "string") {
		throw new Error("Respuesta de renovación OAuth no válida");
	}

	// Conserva campos que Codex pueda añadir y actualiza el archivo atómicamente.
	const path = authPath();
	const parsed = JSON.parse(await readFile(path, "utf8")) as AuthFile;
	const updated: AuthFile = {
		...parsed,
		tokens: {
			...parsed.tokens,
			access_token: result.access_token,
			refresh_token: result.refresh_token,
		},
	};
	const temporaryPath = `${path}.codex-usage.tmp-${process.pid}`;
	await writeFile(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
	await chmod(temporaryPath, 0o600);
	await rename(temporaryPath, path);
	return { accessToken: result.access_token, accountId: auth.accountId, refreshToken: result.refresh_token };
}

function percent(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.min(100, Math.round(value)));
}

function timestamp(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseUsage(value: unknown): CodexUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const rateLimit = (value as UsageResponse).rate_limit;
	const primary = rateLimit?.primary_window;
	const secondary = rateLimit?.secondary_window;
	const fiveHourPercent = percent(primary?.used_percent);
	const weeklyPercent = percent(secondary?.used_percent);
	if (fiveHourPercent === undefined || weeklyPercent === undefined) return undefined;
	const usage: CodexUsage = { fiveHourPercent, weeklyPercent };
	const fiveHourResetAt = timestamp(primary?.reset_at);
	const weeklyResetAt = timestamp(secondary?.reset_at);
	if (fiveHourResetAt !== undefined) usage.fiveHourResetAt = fiveHourResetAt;
	if (weeklyResetAt !== undefined) usage.weeklyResetAt = weeklyResetAt;
	return usage;
}

function resetText(resetAt: number | undefined): string {
	if (resetAt === undefined) return "";
	const remaining = Math.max(0, resetAt * 1000 - Date.now());
	const hours = Math.floor(remaining / 3_600_000);
	const minutes = Math.floor((remaining % 3_600_000) / 60_000);
	return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function formatStatus(usage: CodexUsage): string {
	const fiveHourReset = resetText(usage.fiveHourResetAt);
	const weeklyReset = resetText(usage.weeklyResetAt);
	return `${EXTENSION_NAME}: 5h ${usage.fiveHourPercent}%${fiveHourReset ? ` (${fiveHourReset})` : ""} | semanal ${usage.weeklyPercent}%${weeklyReset ? ` (${weeklyReset})` : ""}`;
}

async function fetchUsage(auth: CodexAuth): Promise<CodexUsage> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(USAGE_URL, {
			headers: {
				Authorization: `Bearer ${auth.accessToken}`,
				"chatgpt-account-id": auth.accountId,
			},
			signal: controller.signal,
		});
		if (!response.ok) throw new UsageHttpError(response.status);
		return parseUsage(await response.json()) ?? (() => { throw new Error("Respuesta de uso no válida"); })();
	} finally {
		clearTimeout(timeout);
	}
}

export default function codexUsage(pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setInterval> | undefined;
	let inFlight = false;
	let latestStatus: string | undefined;

	const setStatus = (ctx: ExtensionContext, text: string | undefined) => {
		if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_NAME, text);
	};

	const update = async (ctx: ExtensionContext, notifyOnError = false): Promise<void> => {
		if (inFlight) return;
		inFlight = true;
		try {
			let auth = await readCodexAuth();
			if (!auth) throw new Error("No se encontró una sesión OAuth de Codex");
			let usage: CodexUsage;
			try {
				usage = await fetchUsage(auth);
			} catch (error) {
				if (!(error instanceof UsageHttpError) || error.status !== 401) throw error;
				auth = await refreshCodexAuth(auth);
				usage = await fetchUsage(auth);
			}
			latestStatus = formatStatus(usage);
			setStatus(ctx, latestStatus);
		} catch (error) {
			const message = error instanceof Error ? error.message : "error desconocido";
			latestStatus = `${EXTENSION_NAME}: ${message}`;
			setStatus(ctx, latestStatus);
			if (notifyOnError && ctx.hasUI) ctx.ui.notify(`CodexUsage: ${message}`, "warning");
		} finally {
			inFlight = false;
		}
	};

	const stop = (ctx: ExtensionContext) => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
		latestStatus = undefined;
		setStatus(ctx, undefined);
		if (ctx.hasUI) ctx.ui.setFooter(undefined);
	};

	const installFooter = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setFooter((_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				const model = theme.fg("dim", ctx.model?.id || "sin-modelo");
				const usage = latestStatus ? theme.fg("dim", latestStatus) : theme.fg("dim", `${EXTENSION_NAME}: consultando...`);
				const separator = theme.fg("dim", "  ·  ");
				return [truncateToWidth(`${" ".repeat(Math.max(1, width - visibleWidth(usage) - visibleWidth(separator) - visibleWidth(model)))}${usage}${separator}${model}`, width, "")];
			},
		}));
	};

	pi.registerCommand("codex-usage", {
		description: "Actualizar y mostrar el uso de Codex",
		handler: async (_args, ctx) => update(ctx, true),
	});

	pi.on("session_start", async (_event, ctx) => {
		stop(ctx);
		if (!ctx.hasUI) return;
		installFooter(ctx);
		await update(ctx);
		timer = setInterval(() => void update(ctx), POLL_INTERVAL_MS);
		timer.unref?.();
	});

	pi.on("session_shutdown", (_event, ctx) => stop(ctx));
}
