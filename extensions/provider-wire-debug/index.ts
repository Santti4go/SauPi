import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WireDebugProxy } from "./proxy-server.ts";

function port(value: boolean | string | undefined): number {
	const parsed = typeof value === "string" ? Number(value) : 0;
	if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) throw new Error(`Invalid wire debug port: ${String(value)}`);
	return parsed;
}

export default function providerWireDebug(pi: ExtensionAPI): void {
	let proxy: WireDebugProxy | undefined;
	let provider: string | undefined;
	let logPath: string | undefined;
	let upstream: string | undefined;

	// Pi registra el proxy como una función de depuración opt-in.
	pi.registerFlag("wire-debug", {
		description: "Route the active provider through a loopback HTTP wire logger",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("wire-debug-port", {
		description: "Loopback port for the provider wire logger; 0 selects a free port",
		type: "string",
		default: "0",
	});
	pi.registerFlag("wire-debug-log", {
		description: "JSONL path for provider wire captures",
		type: "string",
		default: ".pi/provider-wire-debug.jsonl",
	});
	pi.registerFlag("wire-debug-upstream", {
		description: "Override the upstream URL inferred from the active model",
		type: "string",
	});
	pi.registerFlag("wire-debug-show-secrets", {
		description: "Include authorization and API key headers in the wire log",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!pi.getFlag("wire-debug")) return;
		if (!ctx.model) {
			ctx.ui.notify("Provider wire debug requires an active model", "error");
			return;
		}

		const configuredLog = String(pi.getFlag("wire-debug-log") ?? ".pi/provider-wire-debug.jsonl");
		logPath = isAbsolute(configuredLog) ? configuredLog : resolve(ctx.cwd, configuredLog);
		upstream = String(pi.getFlag("wire-debug-upstream") || ctx.model.baseUrl);
		provider = ctx.model.provider;
		proxy = new WireDebugProxy({
			upstream,
			logPath,
			port: port(pi.getFlag("wire-debug-port")),
			showSecrets: pi.getFlag("wire-debug-show-secrets") === true,
		});

		try {
			const proxyUrl = await proxy.start();
			pi.registerProvider(provider, { baseUrl: proxyUrl });
			const proxiedModel = ctx.modelRegistry.find(provider, ctx.model.id);
			if (!proxiedModel || proxiedModel.baseUrl !== proxyUrl) throw new Error("Could not activate the proxied model");
			ctx.ui.setStatus("wire-debug", "wire debug: recording");
			ctx.ui.notify(`Provider wire debug: ${logPath}`, "warning");
		} catch (error) {
			await proxy.stop();
			proxy = undefined;
			ctx.ui.notify(`Provider wire debug failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	// El comando de Pi muestra el destino de la captura activa.
	pi.registerCommand("wire-debug", {
		description: "Show provider wire debug status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(proxy ? `Wire debug → ${upstream}\nLog: ${logPath}` : "Provider wire debug is disabled", proxy ? "warning" : "info");
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await proxy?.stop();
		if (provider) pi.unregisterProvider(provider);
		proxy = undefined;
		provider = undefined;
		ctx.ui.setStatus("wire-debug", undefined);
	});
}
