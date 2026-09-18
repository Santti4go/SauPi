import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	collectGarbage,
	createRuntimeRoot,
	HEARTBEAT_MS,
	listLiveSessions,
	LiveEndpoint,
	ProtocolError,
	sendToSession,
	type DiscoveredSession,
	type LiveSession,
	type LiveStatus,
	type MessageSource,
} from "./network.ts";

function clean(value: string, max = 80): string {
	const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function label(session: DiscoveredSession): string {
	return session.sessionName || basename(session.cwd) || session.endpointId.slice(0, 8);
}

function table(sessions: DiscoveredSession[]): string {
	if (sessions.length === 0) return "No live Pi sessions found.";
	return [
		["NAME", "TYPE", "STATUS", "PID", "CWD", "MODEL", "ENDPOINT"],
		...sessions.map((session) => [
			clean(label(session), 24),
			session.transport === "tui-socket" ? "TUI" : "RPC",
			session.status,
			String(session.pid),
			clean(session.cwd),
			session.model ? clean(`${session.model.provider}/${session.model.id}`, 48) : "-",
			session.endpointId.slice(0, 8),
		]),
	].map((row) => row.join("  ")).join("\n");
}

function resolveSession(sessions: DiscoveredSession[], target: string): DiscoveredSession[] {
	return sessions.filter((session) => session.endpointId === target || session.endpointId.startsWith(target) || session.sessionName === target);
}

function origin(source?: MessageSource): string {
	return clean(source?.name || source?.endpointId || "external Pi session", 128);
}

export default function piSessionNetwork(pi: ExtensionAPI): void {
	let endpoint: LiveEndpoint | undefined;
	let heartbeat: NodeJS.Timeout | undefined;
	let activeContext: ExtensionContext | undefined;
	let waitingForUser = false;
	let compacting = false;

	pi.registerFlag("session-network-deliver", {
		description: "Allow other local Pi sessions to send prompts to this TUI",
		type: "boolean",
		default: false,
	});

	const status = (ctx: ExtensionContext): Exclude<LiveStatus, "unreachable"> => {
		if (waitingForUser) return "waiting_user";
		if (compacting) return "compacting";
		return ctx.isIdle() ? "idle" : "running";
	};

	const identity = (): MessageSource | undefined => {
		const info = endpoint?.snapshot();
		return info ? { endpointId: info.endpointId, sessionId: info.sessionId, name: info.sessionName ?? basename(info.cwd) } : undefined;
	};

	const refresh = async (ctx: ExtensionContext, options: { activity?: boolean; heartbeat?: boolean } = {}) => {
		const current = endpoint;
		if (!current) return;
		activeContext = ctx;
		const previous = current.snapshot();
		const now = Date.now();
		const model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
		const values = { sessionName: pi.getSessionName() ?? null, model, thinkingLevel: ctx.thinkingLevel ?? null, status: status(ctx) };
		const changed = previous.sessionName !== values.sessionName || previous.model?.provider !== model?.provider || previous.model?.id !== model?.id || previous.thinkingLevel !== values.thinkingLevel || previous.status !== values.status;
		await current.update({
			...values,
			processUptimeSeconds: process.uptime(),
			...(options.heartbeat ? { heartbeatAt: now } : {}),
			...(options.activity ? { lastActivityAt: now } : {}),
			...(changed ? { updatedAt: now } : {}),
		});
	};

	const update = (ctx: ExtensionContext, options?: { activity?: boolean; heartbeat?: boolean }) => {
		void refresh(ctx, options).catch(() => undefined);
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		activeContext = ctx;
		waitingForUser = false;
		compacting = false;
		try {
			const endpointId = randomUUID();
			const root = await createRuntimeRoot(endpointId);
			const now = Date.now();
			const allowDelivery = Boolean(pi.getFlag("session-network-deliver"));
			const info: LiveSession = {
				protocolVersion: 1,
				revision: 1,
				endpointId,
				transport: "tui-socket",
				managedBy: null,
				pid: process.pid,
				processUptimeSeconds: process.uptime(),
				sessionId: ctx.sessionManager.getSessionId(),
				sessionName: pi.getSessionName() ?? null,
				sessionFile: ctx.sessionManager.getSessionFile() ?? null,
				cwd: ctx.cwd,
				socketPath: `${root}/sockets/${endpointId}.sock`,
				model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
				thinkingLevel: ctx.thinkingLevel ?? null,
				status: status(ctx),
				startedAt: now,
				updatedAt: now,
				heartbeatAt: now,
				lastActivityAt: now,
				piVersion: VERSION,
				capabilities: ["ping", "get_info", "notify", "abort", "stop", ...(allowDelivery ? ["deliver" as const] : [])],
				statusPrecision: "tui-best-effort",
				pendingMessageCount: null,
			};
			endpoint = new LiveEndpoint(root, info, {
				...(allowDelivery ? {
					deliver: ({ text, delivery, messageId, source }) => {
						const current = activeContext;
						if (!current) throw new ProtocolError("BUSY", "Session is changing");
						if (waitingForUser || compacting) throw new ProtocolError("BUSY", "Session cannot accept messages now");
						pi.sendUserMessage(
							`[Message from Pi session: ${origin(source)}]\nMessage ID: ${messageId}\n\n${text}`,
							{ deliverAs: delivery, expandPromptTemplates: false },
						);
						return { accepted: true, stage: "bridge_dispatched", messageId };
					},
				} : {}),
				notify: (text, source) => {
					activeContext?.ui.notify(`[Pi: ${origin(source)}] ${text}`, "info");
					return { accepted: true };
				},
				abort: () => { activeContext?.abort(); return { accepted: true }; },
				stop: () => { activeContext?.shutdown(); return { accepted: true }; },
			});
			await endpoint.start();
			heartbeat = setInterval(() => update(ctx, { heartbeat: true }), HEARTBEAT_MS);
			heartbeat.unref();
			ctx.ui.setStatus("pi-session-network", allowDelivery ? "session network: writable" : "session network: read-only");
		} catch (error) {
			endpoint = undefined;
			ctx.ui.notify(`Session network unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("agent_start", (_event, ctx) => update(ctx, { activity: true }));
	pi.on("agent_settled", (_event, ctx) => update(ctx, { activity: true }));
	pi.on("ui_prompt_start", (_event, ctx) => { waitingForUser = true; update(ctx, { activity: true }); });
	pi.on("ui_prompt_end", (_event, ctx) => { waitingForUser = false; update(ctx, { activity: true }); });
	pi.on("session_before_compact", (_event, ctx) => { compacting = true; update(ctx, { activity: true }); });
	pi.on("session_compact", (_event, ctx) => { compacting = false; update(ctx, { activity: true }); });
	pi.on("session_compact_failed", (_event, ctx) => { compacting = false; update(ctx, { activity: true }); });
	pi.on("model_select", (_event, ctx) => update(ctx));
	pi.on("thinking_level_select", (_event, ctx) => update(ctx));
	pi.on("session_info_changed", (_event, ctx) => update(ctx));

	pi.registerCommand("pi-sessions", {
		description: "List live Pi TUI and RPC sessions",
		handler: async (_args, ctx) => ctx.ui.notify(table(await listLiveSessions()), "info"),
	});

	pi.registerCommand("pi-send", {
		description: "Send a message to another Pi session",
		handler: async (args, ctx) => {
			const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
			if (!match) return ctx.ui.notify("Usage: /pi-send <endpoint|name> <message>", "warning");
			const [, target = "", message = ""] = match;
			let matches = resolveSession(await listLiveSessions(), target).filter((item) => item.endpointId !== endpoint?.snapshot().endpointId);
			if (matches.length > 1) {
				const choice = await ctx.ui.select("Select Pi session", matches.map((item) => `${item.endpointId.slice(0, 8)}  ${label(item)}  ${item.cwd}`));
				matches = choice ? matches.filter((item) => choice.startsWith(item.endpointId.slice(0, 8))) : [];
			}
			if (matches.length !== 1) return ctx.ui.notify(matches.length ? "Ambiguous session" : `Session not found: ${clean(target)}`, "warning");
			try {
				await sendToSession(matches[0]!, message, "followUp", identity());
				ctx.ui.notify(`Message dispatched to ${label(matches[0]!)}`, "info");
			} catch (error) {
				ctx.ui.notify(`Message rejected: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("pi-whoami", {
		description: "Show this live Pi endpoint",
		handler: async (_args, ctx) => ctx.ui.notify(endpoint ? JSON.stringify(endpoint.snapshot(), null, 2) : "This session is not registered.", "info"),
	});

	pi.registerCommand("pi-inspect", {
		description: "Inspect a live Pi endpoint by ID, prefix, or name",
		handler: async (args, ctx) => {
			const target = args.trim();
			if (!target) return ctx.ui.notify("Usage: /pi-inspect <endpoint|name>", "warning");
			const matches = resolveSession(await listLiveSessions(), target);
			ctx.ui.notify(matches.length === 1 ? JSON.stringify(matches[0], null, 2) : matches.length === 0 ? `Session not found: ${clean(target)}` : `Ambiguous session: ${matches.map((item) => item.endpointId.slice(0, 8)).join(", ")}`, matches.length === 1 ? "info" : "warning");
		},
	});

	pi.registerCommand("pi-gc", {
		description: "Remove proven orphan Pi session registrations",
		handler: async (_args, ctx) => ctx.ui.notify(`Removed ${await collectGarbage()} orphan registration(s).`, "info"),
	});

	pi.registerTool({
		name: "list_live_pi_sessions",
		label: "List Live Pi Sessions",
		description: "List active Pi TUI and managed RPC sessions registered for the current Unix user.",
		promptSnippet: "List active Pi sessions, their state, model, and working directory",
		parameters: Type.Object({}),
		async execute() {
			const sessions = await listLiveSessions();
			const output = truncateHead(JSON.stringify(sessions, null, 2), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
			return { content: [{ type: "text", text: output.content + (output.truncated ? "\n[Output truncated]" : "") }], details: { count: sessions.length } };
		},
	});

	pi.registerTool({
		name: "send_to_pi_session",
		label: "Send to Pi Session",
		description: "Send one message to a specific live Pi session. Broadcast and self-send are rejected.",
		parameters: Type.Object({ target: Type.String(), message: Type.String(), delivery: Type.Optional(Type.String()) }),
		async execute(_id, params) {
			const sessions = await listLiveSessions();
			const matches = resolveSession(sessions, params.target).filter((item) => item.endpointId !== endpoint?.snapshot().endpointId);
			if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous target: ${matches.map((item) => item.endpointId).join(", ")}` : "Target not found");
			const delivery = params.delivery ?? "followUp";
			if (delivery !== "steer" && delivery !== "followUp") throw new Error("delivery must be steer or followUp");
			const result = await sendToSession(matches[0]!, params.message, delivery, identity());
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = undefined;
		activeContext = undefined;
		const current = endpoint;
		endpoint = undefined;
		if (current) {
			await current.update({ status: "shutting_down", updatedAt: Date.now() }).catch(() => undefined);
			await current.stop();
		}
		ctx.ui.setStatus("pi-session-network", undefined);
	});
}
