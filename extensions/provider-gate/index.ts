import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ApprovalQueue } from "./approval-queue.ts";
import { openBrowser, ProviderGateServer } from "./server.ts";

function validPort(value: boolean | string | undefined): number {
	const port = typeof value === "string" ? Number(value) : 0;
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`Invalid provider gate port: ${String(value)}`);
	}
	return port;
}

export default function providerGate(pi: ExtensionAPI): void {
	const queue = new ApprovalQueue();
	let server: ProviderGateServer | undefined;
	let url: string | undefined;
	let startupError: string | undefined;

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
			server = new ProviderGateServer(queue, validPort(pi.getFlag("provider-gate-port")));
			url = await server.start();
			startupError = undefined;
			if (!pi.getFlag("provider-gate-no-open")) openBrowser(url);
			if (ctx.hasUI) {
				ctx.ui.setStatus("provider-gate", "provider gate: armed");
				ctx.ui.notify(`Provider authorization UI: ${url}`, "info");
			}
		} catch (error) {
			startupError = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) ctx.ui.notify(`Provider gate failed closed: ${startupError}`, "error");
		}
	});

	// Pi espera este handler antes de entregar el payload serializado al provider.
	pi.on("before_provider_request", async (event, ctx) => {
		if (!server || !url || startupError) {
			ctx.abort();
			if (ctx.hasUI) ctx.ui.notify(`Provider request rejected: ${startupError ?? "gate is unavailable"}`, "error");
			return undefined;
		}

		const handle = queue.request(event.payload, ctx.signal);
		if (ctx.hasUI) ctx.ui.setStatus("provider-gate", `approval pending: ${handle.review.id.slice(0, 8)}`);
		const resolution = await handle.decision;

		if (resolution.decision === "approved") {
			if (ctx.hasUI) ctx.ui.setStatus("provider-gate", "provider gate: armed");
			return resolution.modified ? resolution.payload : undefined;
		}

		if (resolution.decision === "rejected") ctx.abort();
		if (ctx.hasUI) {
			ctx.ui.setStatus("provider-gate", "provider gate: armed");
			ctx.ui.notify(
				resolution.decision === "rejected" ? "Provider request rejected" : "Provider review cancelled",
				"warning",
			);
		}
		return undefined;
	});

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

	pi.on("session_shutdown", async (_event, ctx) => {
		queue.close();
		await server?.stop();
		server = undefined;
		url = undefined;
		if (ctx.hasUI) ctx.ui.setStatus("provider-gate", undefined);
	});
}
