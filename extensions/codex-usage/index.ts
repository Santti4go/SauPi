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
	"openai-codex"?: PiOAuthCredential;
	[key: string]: unknown;
};

type PiOAuthCredential = {
	type?: unknown;
	access?: unknown;
	refresh?: unknown;
	accountId?: unknown;
	expires?: unknown;
	[key: string]: unknown;
};

type CodexAuth = {
	accessToken: string;
	accountId: string;
	refreshToken?: string;
	path: string;
	format: "pi" | "codex";
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

function authPaths(): string[] {
	const piDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const codexDir = process.env.CODEX_HOME || join(homedir(), ".codex");
	return [join(piDir, "auth.json"), join(codexDir, "auth.json")];
}

async function readCodexAuth(): Promise<CodexAuth | undefined> {
	for (const path of authPaths()) {
		try {
			const parsed = JSON.parse(await readFile(path, "utf8")) as AuthFile;
			// Pi stores this provider under the `openai-codex` key.
			const piAuth = parsed["openai-codex"];
			if (typeof piAuth?.access === "string" && typeof piAuth.accountId === "string") {
				return {
					accessToken: piAuth.access,
					accountId: piAuth.accountId,
					...(typeof piAuth.refresh === "string" && piAuth.refresh ? { refreshToken: piAuth.refresh } : {}),
					path,
					format: "pi",
				};
			}

			// Legacy/native Codex stores OAuth tokens under `tokens`.
			const accessToken = parsed.tokens?.access_token;
			const refreshToken = parsed.tokens?.refresh_token;
			const accountId = parsed.tokens?.account_id;
			if (typeof accessToken === "string" && accessToken && typeof accountId === "string" && accountId) {
				return {
					accessToken,
					accountId,
					...(typeof refreshToken === "string" && refreshToken ? { refreshToken } : {}),
					path,
					format: "codex",
				};
			}
		} catch {
			// Try the next location; the final error is shown in the footer.
		}
	}
	return undefined;
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
	const result = await response.json() as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
	if (typeof result.access_token !== "string" || typeof result.refresh_token !== "string") {
		throw new Error("Respuesta de renovación OAuth no válida");
	}

	// Conserva campos que Codex pueda añadir y actualiza el archivo atómicamente.
	const path = auth.path;
	const parsed = JSON.parse(await readFile(path, "utf8")) as AuthFile;
	const updated: AuthFile = auth.format === "pi"
		? {
			...parsed,
			"openai-codex": {
				...parsed["openai-codex"],
				access: result.access_token,
				refresh: result.refresh_token,
				...(typeof result.expires_in === "number" ? { expires: Date.now() + result.expires_in * 1000 - 300_000 } : {}),
			},
		}
		: {
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
	return { accessToken: result.access_token, accountId: auth.accountId, refreshToken: result.refresh_token, path, format: auth.format };
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

type UsageColor = "accent" | "warning" | "error";

function usageColor(remainder: number): UsageColor {
	if (remainder >= 60) return "accent"; // azul (color primario del tema)
	if (remainder >= 30) return "warning"; // amarillo
	return "error"; // rojo
}

export function formatStatus(usage: CodexUsage): string {
	return `${EXTENSION_NAME}: ${usage.fiveHourPercent}% | ${usage.weeklyPercent}%`;
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
	let latestUsage: CodexUsage | undefined;

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

				// Pi puede haber renovado auth.json en paralelo. Releer antes de
				// intentar otro refresh evita invalidar/rotar refresh tokens válidos.
				const latestAuth = await readCodexAuth();
				if (!latestAuth) throw new Error("No se encontró una sesión OAuth de Pi");
				try {
					usage = await fetchUsage(latestAuth);
					auth = latestAuth;
				} catch (latestError) {
					if (!(latestError instanceof UsageHttpError) || latestError.status !== 401) throw latestError;
					auth = await refreshCodexAuth(latestAuth);
					usage = await fetchUsage(auth);
				}
			}
			latestUsage = usage;
			latestStatus = formatStatus(usage);
			setStatus(ctx, latestStatus);
		} catch (error) {
			const message = error instanceof Error ? error.message : "error desconocido";
			latestUsage = undefined;
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
		latestUsage = undefined;
		setStatus(ctx, undefined);
		if (ctx.hasUI) ctx.ui.setFooter(undefined);
	};

	const installFooter = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setFooter((_tui, theme) => ({
			invalidate() { },
			render(width: number): string[] {
				const model = theme.fg("dim", ctx.model?.id || "sin-modelo");
				const remaining5h = 100 - latestUsage?.fiveHourPercent;
				const remainingWeek = 100 - latestUsage?.weeklyPercent;
				const usage = latestUsage
					? `${theme.fg("dim", `5h: `)} ${theme.fg(usageColor(remaining5h), `${remaining5h}%`)}${theme.fg("dim", " | weekly: ")}${theme.fg(usageColor(remainingWeek), `${remainingWeek}%`)}`
					: theme.fg("dim", latestStatus || `${EXTENSION_NAME}: consultando...`);
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
