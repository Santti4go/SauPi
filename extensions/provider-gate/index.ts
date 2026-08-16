import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ApprovalQueue } from "./approval-queue.ts";
import { shouldGatePayload } from "./payload-inspection.ts";
import { ProjectionLedger, type ProjectionSnapshot } from "./projection-ledger.ts";
import { openBrowser, ProviderGateServer } from "./server.ts";
import { collectProviderGateMetrics } from "./telemetry.ts";

const PROJECTION_ENTRY = "provider-gate-projection";

function validPort(value: boolean | string | undefined): number {
	const port = typeof value === "string" ? Number(value) : 0;
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`Invalid provider gate port: ${String(value)}`);
	}
	return port;
}

export default function providerGate(pi: ExtensionAPI): void {
	const ledger = new ProjectionLedger();
	const queue = new ApprovalQueue(ledger, (snapshot) => {
		// Pi persiste el ledger sin incorporarlo al contexto del modelo.
		pi.appendEntry(PROJECTION_ENTRY, snapshot);
	});
	let server: ProviderGateServer | undefined;
	let url: string | undefined;
	let startupError: string | undefined;
	let enabled = false;

	const statusText = () => (enabled ? "provider gate: armed" : "provider gate: bypass");
	const updateMetrics = (ctx: ExtensionContext) => {
		server?.updateMetrics(collectProviderGateMetrics(ctx));
	};

	// Pi registra estas opciones como flags propias de la extensión.
	pi.registerFlag("provider-gate-port", {
		description: "Loopback port for the provider authorization UI; 0 selects a free port",
		type: "string",
		default: "0",
	});
	pi.registerFlag("provider-gate-no-open", {
		description: "Do not open the provider authorization UI at startup",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			const saved = [...ctx.sessionManager.getBranch()]
				.reverse()
				.find((entry) => entry.type === "custom" && entry.customType === PROJECTION_ENTRY);
			if (saved?.type === "custom" && isProjectionSnapshot(saved.data)) ledger.restore(saved.data);
			server = new ProviderGateServer(queue, validPort(pi.getFlag("provider-gate-port")));
			updateMetrics(ctx);
			url = await server.start();
			startupError = undefined;
			if (!pi.getFlag("provider-gate-no-open")) openBrowser(url);
			if (ctx.hasUI) {
				ctx.ui.setStatus("provider-gate", statusText());
				ctx.ui.notify(`Provider authorization UI: ${url}`, "info");
			}
		} catch (error) {
			startupError = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(`Provider gate audit UI unavailable: ${startupError}`, "error");
		}
	});

	// Pi espera este handler antes de entregar el payload serializado al provider.
	pi.on("before_provider_request", async (event, ctx) => {
		updateMetrics(ctx);
		const projection = ledger.project(event.payload);
		if (!shouldGatePayload(projection.payload)) return projection.changed ? projection.payload : undefined;
		if (!enabled) {
			queue.observe(projection);
			return projection.changed ? projection.payload : undefined;
		}
		if (!server || !url || startupError) {
			ctx.abort();
			if (ctx.hasUI) ctx.ui.notify(`Provider request rejected: ${startupError ?? "gate is unavailable"}`, "error");
			return undefined;
		}

		const handle = queue.request(event.payload, ctx.signal);
		if (ctx.hasUI) ctx.ui.setStatus("provider-gate", `approval pending: ${handle.review.id.slice(0, 8)}`);
		const resolution = await handle.decision;

		if (resolution.decision === "approved") {
			if (ctx.hasUI) ctx.ui.setStatus("provider-gate", statusText());
			return resolution.modified ? resolution.payload : undefined;
		}

		if (resolution.decision === "rejected") ctx.abort();
		if (ctx.hasUI) {
			ctx.ui.setStatus("provider-gate", statusText());
			ctx.ui.notify(
				resolution.decision === "rejected" ? "Provider request rejected" : "Provider review cancelled",
				"warning",
			);
		}
		return undefined;
	});

	pi.on("turn_end", (_event, ctx) => updateMetrics(ctx));
	pi.on("session_compact", (_event, ctx) => updateMetrics(ctx));
	pi.on("session_tree", (_event, ctx) => updateMetrics(ctx));
	pi.on("model_select", (_event, ctx) => updateMetrics(ctx));

	// El comando de Pi vuelve a abrir la URL efímera de esta sesión.
	pi.registerCommand("provider-gate", {
		description: "Open the provider authorization UI",
		handler: async (_args, ctx) => {
			if (!url) {
				ctx.ui.notify(`Provider gate is unavailable${startupError ? `: ${startupError}` : ""}`, "error");
				return;
			}
			openBrowser(url);
			ctx.ui.notify(`Provider authorization UI: ${url}`, "info");
		},
	});

	// Estos comandos de Pi alternan la compuerta durante la sesión actual.
	pi.registerCommand("gate-off", {
		description: "Log provider requests without waiting for approval",
		handler: async (_args, ctx) => {
			enabled = false;
			const released = queue.approveAll();
			ctx.ui.setStatus("provider-gate", statusText());
			ctx.ui.notify(
				`Provider gate disabled; requests remain visible in the audit UI${released > 0 ? `; released ${released} pending request(s)` : ""}`,
				"warning",
			);
		},
	});

	pi.registerCommand("gate-on", {
		description: "Require provider request approval for this session",
		handler: async (_args, ctx) => {
			enabled = true;
			ctx.ui.setStatus("provider-gate", statusText());
			ctx.ui.notify("Provider gate enabled", "info");
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		queue.close();
		await server?.stop();
		server = undefined;
		url = undefined;
		if (ctx.hasUI) ctx.ui.setStatus("provider-gate", undefined);
	});
}

function isProjectionSnapshot(value: unknown): value is ProjectionSnapshot {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ProjectionSnapshot>;
	return Array.isArray(candidate.dropped) && Array.isArray(candidate.replacements);
}
