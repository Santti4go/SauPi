import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";

export const PROTOCOL_VERSION = 1;
export const HEARTBEAT_MS = 5_000;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_SOCKET_PATH_BYTES = 100;
const REQUEST_TIMEOUT_MS = 3_000;
const STALE_MS = 60_000;
const MESSAGE_CACHE_MS = 10 * 60_000;

export type LiveStatus =
	| "starting"
	| "idle"
	| "running"
	| "waiting_user"
	| "compacting"
	| "retrying"
	| "shutting_down"
	| "unreachable";
export type EndpointMethod = "ping" | "get_info" | "deliver" | "notify" | "abort" | "stop";

export interface LiveSession {
	protocolVersion: 1;
	revision: number;
	endpointId: string;
	transport: "tui-socket" | "rpc-proxy";
	managedBy: string | null;
	pid: number;
	processUptimeSeconds: number;
	sessionId: string;
	sessionName: string | null;
	sessionFile: string | null;
	cwd: string;
	socketPath: string;
	model: { provider: string; id: string } | null;
	thinkingLevel: string | null;
	status: Exclude<LiveStatus, "unreachable">;
	startedAt: number;
	updatedAt: number;
	heartbeatAt: number;
	lastActivityAt: number;
	piVersion: string;
	capabilities: EndpointMethod[];
	statusPrecision: "tui-best-effort" | "rpc-events";
	pendingMessageCount: number | null;
}

export interface DiscoveredSession extends Omit<LiveSession, "status"> {
	status: LiveStatus;
	reachable: boolean;
}

export interface MessageSource {
	endpointId?: string;
	sessionId?: string;
	name?: string;
}

export interface EndpointActions {
	deliver?: (input: { text: string; delivery: "steer" | "followUp"; messageId: string; source?: MessageSource }) => Promise<object> | object;
	notify?: (text: string, source?: MessageSource) => Promise<object> | object;
	abort?: () => Promise<object> | object;
	stop?: () => Promise<object> | object;
}

export class ProtocolError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
	}
}

function uid(): number {
	if (process.platform !== "linux" || !process.getuid) throw new Error("pi-session-network supports Linux only");
	return process.getuid();
}

function fallbackRoot(): string {
	return `/tmp/pi-session-network-${uid()}`;
}

export function runtimeRoots(env: NodeJS.ProcessEnv = process.env): string[] {
	const roots = [fallbackRoot()];
	if (env.XDG_RUNTIME_DIR && isAbsolute(env.XDG_RUNTIME_DIR)) roots.unshift(join(env.XDG_RUNTIME_DIR, "pi-session-network"));
	return [...new Set(roots)];
}

export function endpointSocketPath(root: string, endpointId: string): string {
	return join(root, "sockets", `${endpointId}.sock`);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	try {
		await mkdir(path, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const stat = await lstat(path);
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid()) throw new Error(`Unsafe runtime directory: ${path}`);
	await chmod(path, 0o700);
}

export async function createRuntimeRoot(endpointId: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const errors: string[] = [];
	for (const root of runtimeRoots(env)) {
		if (Buffer.byteLength(endpointSocketPath(root, endpointId)) + 1 > MAX_SOCKET_PATH_BYTES) continue;
		try {
			await ensurePrivateDirectory(root);
			await ensurePrivateDirectory(join(root, "registry"));
			await ensurePrivateDirectory(join(root, "sockets"));
			return root;
		} catch (error) {
			errors.push(`${root}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`No safe runtime directory available${errors.length ? ` (${errors.join("; ")})` : ""}`);
}

function isLiveSession(value: unknown): value is LiveSession {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<LiveSession>;
	return (
		item.protocolVersion === PROTOCOL_VERSION &&
		Number.isInteger(item.revision) &&
		typeof item.endpointId === "string" && /^[0-9a-f-]{36}$/.test(item.endpointId) &&
		(item.transport === "tui-socket" || item.transport === "rpc-proxy") &&
		(item.managedBy === null || typeof item.managedBy === "string") &&
		Number.isInteger(item.pid) &&
		typeof item.processUptimeSeconds === "number" &&
		typeof item.sessionId === "string" &&
		(item.sessionName === null || typeof item.sessionName === "string") &&
		(item.sessionFile === null || typeof item.sessionFile === "string") &&
		typeof item.cwd === "string" && typeof item.socketPath === "string" &&
		(item.model === null || (typeof item.model === "object" && typeof item.model.provider === "string" && typeof item.model.id === "string")) &&
		(item.thinkingLevel === null || typeof item.thinkingLevel === "string") &&
		["starting", "idle", "running", "waiting_user", "compacting", "retrying", "shutting_down"].includes(item.status ?? "") &&
		["startedAt", "updatedAt", "heartbeatAt", "lastActivityAt"].every((key) => typeof (item as Record<string, unknown>)[key] === "number") &&
		typeof item.piVersion === "string" &&
		Array.isArray(item.capabilities) && item.capabilities.every((method) => ["ping", "get_info", "deliver", "notify", "abort", "stop"].includes(method)) &&
		(item.statusPrecision === "tui-best-effort" || item.statusPrecision === "rpc-events") &&
		(item.pendingMessageCount === null || Number.isInteger(item.pendingMessageCount))
	);
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

function response(id: string | null, ok: boolean, body: object): string {
	return `${JSON.stringify({ v: PROTOCOL_VERSION, id, ok, ...body })}\n`;
}

export class LiveEndpoint {
	private readonly registryPath: string;
	private readonly connections = new Set<Socket>();
	private readonly messages = new Map<string, { hash: string; result: Promise<object>; at: number }>();
	private server: Server | undefined;
	private info: LiveSession;
	private dirty = false;
	private writeTask: Promise<void> | undefined;
	private closed = false;

	constructor(private readonly root: string, info: LiveSession, private readonly actions: EndpointActions = {}) {
		this.info = info;
		this.registryPath = join(root, "registry", `${info.endpointId}.json`);
	}

	snapshot(): LiveSession {
		return { ...this.info, model: this.info.model ? { ...this.info.model } : null, capabilities: [...this.info.capabilities] };
	}

	async start(): Promise<void> {
		const server = createServer((connection) => this.accept(connection));
		this.server = server;
		server.on("error", () => undefined);
		try {
			await new Promise<void>((resolve, reject) => {
				const fail = (error: Error) => reject(error);
				server.once("error", fail);
				server.listen(this.info.socketPath, () => {
					server.off("error", fail);
					resolve();
				});
			});
			await chmod(this.info.socketPath, 0o600);
			await this.queueWrite();
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	update(changes: Partial<LiveSession>): Promise<void> {
		if (this.closed) return Promise.resolve();
		this.info = { ...this.info, ...changes, revision: this.info.revision + 1 };
		return this.queueWrite();
	}

	async stop(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.dirty = false;
		await this.writeTask?.catch(() => undefined);
		for (const connection of this.connections) connection.destroy();
		if (this.server?.listening) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 500);
				this.server?.close(() => { clearTimeout(timer); resolve(); });
			});
		}
		await Promise.all([unlink(this.info.socketPath).catch(() => undefined), unlink(this.registryPath).catch(() => undefined)]);
	}

	private queueWrite(): Promise<void> {
		this.dirty = true;
		if (!this.writeTask) this.writeTask = this.drainWrites().finally(() => { this.writeTask = undefined; });
		return this.writeTask;
	}

	private async drainWrites(): Promise<void> {
		while (this.dirty && !this.closed) {
			this.dirty = false;
			await writeAtomic(this.registryPath, this.info);
		}
	}

	private accept(connection: Socket): void {
		if (this.closed || this.connections.size >= 32) {
			connection.end(response(null, false, { error: { code: "BUSY", message: "Endpoint is busy" } }));
			return;
		}
		this.connections.add(connection);
		let buffer = Buffer.alloc(0);
		let handled = false;
		connection.setTimeout(REQUEST_TIMEOUT_MS, () => connection.destroy());
		connection.on("close", () => this.connections.delete(connection));
		connection.on("data", (chunk: Buffer) => {
			if (handled) return;
			buffer = Buffer.concat([buffer, chunk]);
			const newline = buffer.indexOf(0x0a);
			if (newline < 0) {
				if (buffer.length >= MAX_FRAME_BYTES) connection.destroy();
				return;
			}
			handled = true;
			if (newline + 1 > MAX_FRAME_BYTES) {
				connection.end(response(null, false, { error: { code: "TOO_LARGE", message: "Frame is too large" } }));
				return;
			}
			void this.handleRequest(buffer.subarray(0, newline).toString("utf8").replace(/\r$/, ""), connection);
		});
	}

	private async handleRequest(line: string, connection: Socket): Promise<void> {
		let item: Record<string, unknown>;
		try {
			item = JSON.parse(line) as Record<string, unknown>;
			if (!item || typeof item !== "object") throw new Error();
		} catch {
			connection.end(response(null, false, { error: { code: "INVALID_REQUEST", message: "Invalid JSON request" } }));
			return;
		}
		const id = typeof item.id === "string" && item.id.length <= 128 ? item.id : null;
		try {
			if (item.v !== PROTOCOL_VERSION) throw new ProtocolError("UNSUPPORTED_VERSION", "Unsupported protocol");
			if (!id || typeof item.method !== "string") throw new ProtocolError("INVALID_REQUEST", "Invalid request ID or method");
			const method = item.method as EndpointMethod;
			if (!this.info.capabilities.includes(method)) throw new ProtocolError("FORBIDDEN", `Method is disabled: ${method}`);
			const params = item.params && typeof item.params === "object" ? item.params as Record<string, unknown> : {};
			const result = await this.dispatch(method, params);
			connection.end(response(id, true, { result }));
		} catch (error) {
			const code = error instanceof ProtocolError ? error.code : "INTERNAL_ERROR";
			connection.end(response(id, false, { error: { code, message: error instanceof Error ? error.message : String(error) } }));
		}
	}

	private async dispatch(method: EndpointMethod, params: Record<string, unknown>): Promise<object> {
		if (method === "ping") return { endpointId: this.info.endpointId };
		if (method === "get_info") return { info: this.snapshot() };
		if (params.targetEndpointId !== this.info.endpointId) throw new ProtocolError("ENDPOINT_CHANGED", "Target endpoint changed");
		if (method === "deliver") return this.deliver(params);
		if (method === "notify") {
			if (typeof params.text !== "string" || params.text.length === 0 || Buffer.byteLength(params.text) > 32_768) throw new ProtocolError("INVALID_REQUEST", "Invalid notification text");
			return await this.actions.notify?.(params.text, source(params.source)) ?? { accepted: true };
		}
		if (method === "abort") return await this.actions.abort?.() ?? { accepted: true };
		return await this.actions.stop?.() ?? { accepted: true };
	}

	private async deliver(params: Record<string, unknown>): Promise<object> {
		if (!this.actions.deliver) throw new ProtocolError("FORBIDDEN", "Message delivery is disabled");
		if (typeof params.messageId !== "string" || params.messageId.length > 128 || typeof params.text !== "string" || params.text.length === 0 || Buffer.byteLength(params.text) > 32_768) {
			throw new ProtocolError("INVALID_REQUEST", "Invalid message");
		}
		if (params.delivery !== "steer" && params.delivery !== "followUp") throw new ProtocolError("INVALID_REQUEST", "Invalid delivery mode");
		if (!Number.isInteger(params.hopCount) || (params.hopCount as number) < 0 || (params.hopCount as number) > 3) throw new ProtocolError("INVALID_REQUEST", "Invalid hop count");
		const hash = createHash("sha256").update(JSON.stringify(params)).digest("hex");
		const previous = this.messages.get(params.messageId);
		if (previous) {
			if (previous.hash !== hash) throw new ProtocolError("ID_CONFLICT", "Message ID was reused with different content");
			return previous.result;
		}
		for (const [id, entry] of this.messages) if (Date.now() - entry.at > MESSAGE_CACHE_MS) this.messages.delete(id);
		if (this.messages.size >= 1_000) this.messages.delete(this.messages.keys().next().value as string);
		const messageSource = source(params.source);
		const text = params.text;
		const delivery = params.delivery;
		const messageId = params.messageId;
		const result = Promise.resolve().then(() => this.actions.deliver!({
			text,
			delivery,
			messageId,
			...(messageSource ? { source: messageSource } : {}),
		}));
		this.messages.set(params.messageId, { hash, result, at: Date.now() });
		try {
			return await result;
		} catch (error) {
			this.messages.delete(params.messageId);
			throw error;
		}
	}
}

function source(value: unknown): MessageSource | undefined {
	if (!value || typeof value !== "object") return undefined;
	const item = value as Record<string, unknown>;
	return {
		...(typeof item.endpointId === "string" ? { endpointId: item.endpointId.slice(0, 128) } : {}),
		...(typeof item.sessionId === "string" ? { sessionId: item.sessionId.slice(0, 128) } : {}),
		...(typeof item.name === "string" ? { name: item.name.slice(0, 128) } : {}),
	};
}

type Candidate = { root: string; info: LiveSession };

async function readRoot(root: string): Promise<Candidate[]> {
	const registry = join(root, "registry");
	try {
		for (const directory of [root, registry]) {
			const stat = await lstat(directory);
			if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid() || (stat.mode & 0o077) !== 0) return [];
		}
		const sessions: Candidate[] = [];
		for (const name of await readdir(registry)) {
			if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
			try {
				const path = join(registry, name);
				const stat = await lstat(path);
				if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid() || (stat.mode & 0o077) !== 0 || stat.size > MAX_FRAME_BYTES) continue;
				const value: unknown = JSON.parse(await readFile(path, "utf8"));
				if (isLiveSession(value) && name === `${value.endpointId}.json`) sessions.push({ root, info: value });
			} catch {}
		}
		return sessions;
	} catch {
		return [];
	}
}

export async function callSocket<T extends object = object>(path: string, method: string, params: object = {}): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const id = randomUUID();
		const connection = createConnection(path);
		let done = false;
		let data = Buffer.alloc(0);
		const finish = (error?: Error, result?: T) => {
			if (done) return;
			done = true;
			connection.destroy();
			error ? reject(error) : resolve(result as T);
		};
		connection.setTimeout(REQUEST_TIMEOUT_MS, () => finish(new Error("Request timed out")));
		connection.on("error", (error) => finish(error));
		connection.on("close", () => finish(new Error("Connection closed")));
		connection.on("connect", () => connection.write(`${JSON.stringify({ v: PROTOCOL_VERSION, id, method, params })}\n`));
		connection.on("data", (chunk: Buffer) => {
			data = Buffer.concat([data, chunk]);
			const newline = data.indexOf(0x0a);
			if (newline < 0) {
				if (data.length >= MAX_FRAME_BYTES) finish(new Error("Response is too large"));
				return;
			}
			try {
				const reply = JSON.parse(data.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
				if (reply.v !== PROTOCOL_VERSION || reply.id !== id) throw new Error("Invalid response identity");
				if (!reply.ok) {
					const error = reply.error as Record<string, unknown> | undefined;
					throw new ProtocolError(typeof error?.code === "string" ? error.code : "REQUEST_FAILED", String(error?.message ?? "Request failed"));
				}
				finish(undefined, reply.result as T);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
	});
}

async function probe(root: string, info: LiveSession): Promise<boolean> {
	const path = endpointSocketPath(root, info.endpointId);
	try {
		const stat = await lstat(path);
		if (!stat.isSocket() || stat.uid !== uid() || (stat.mode & 0o077) !== 0) return false;
		const result = await callSocket<{ endpointId: string }>(path, "ping");
		return result.endpointId === info.endpointId;
	} catch {
		return false;
	}
}

export async function listLiveSessions(roots: string[] = runtimeRoots()): Promise<DiscoveredSession[]> {
	const unique = new Map<string, Candidate>();
	for (const candidate of (await Promise.all(roots.map(readRoot))).flat()) {
		const previous = unique.get(candidate.info.endpointId);
		if (!previous || previous.info.heartbeatAt < candidate.info.heartbeatAt) unique.set(candidate.info.endpointId, candidate);
	}
	const sessions = await Promise.all([...unique.values()].map(async ({ root, info }): Promise<DiscoveredSession> => {
		const reachable = await probe(root, info);
		return { ...info, socketPath: endpointSocketPath(root, info.endpointId), status: reachable ? info.status : "unreachable", reachable };
	}));
	return sessions.sort((a, b) => (a.sessionName ?? a.cwd).localeCompare(b.sessionName ?? b.cwd));
}

function processMissing(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

async function withGcLock<T>(root: string, action: () => Promise<T>): Promise<T | undefined> {
	const lock = join(root, ".gc.lock");
	let handle;
	try {
		handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		try {
			const stat = await lstat(lock);
			const owner = JSON.parse(await readFile(lock, "utf8")) as { pid?: number };
			if (stat.uid !== uid() || Date.now() - stat.mtimeMs < STALE_MS || !owner.pid || !processMissing(owner.pid)) return undefined;
			await unlink(lock);
			return withGcLock(root, action);
		} catch {
			return undefined;
		}
	}
	try {
		return await action();
	} finally {
		await handle?.close();
		await unlink(lock).catch(() => undefined);
	}
}

export async function collectGarbage(roots: string[] = runtimeRoots(), now = Date.now()): Promise<number> {
	let removed = 0;
	for (const root of roots) {
		const rootStat = await lstat(root).catch(() => undefined);
		if (!rootStat?.isDirectory() || rootStat.uid !== uid() || (rootStat.mode & 0o077) !== 0) continue;
		removed += await withGcLock(root, async () => {
			let count = 0;
			for (const candidate of await readRoot(root)) {
				const { info } = candidate;
				if (now - info.heartbeatAt < STALE_MS || !processMissing(info.pid) || await probe(root, info)) continue;
				const path = join(root, "registry", `${info.endpointId}.json`);
				try {
					const current = JSON.parse(await readFile(path, "utf8")) as LiveSession;
					if (current.revision !== info.revision || current.heartbeatAt !== info.heartbeatAt || await probe(root, info)) continue;
					await unlink(path);
					const socket = endpointSocketPath(root, info.endpointId);
					const stat = await lstat(socket).catch(() => undefined);
					if (stat?.isSocket() && stat.uid === uid()) await unlink(socket).catch(() => undefined);
					count++;
				} catch {}
			}
			for (const name of await readdir(join(root, "registry")).catch(() => [])) {
				if (name.endsWith(".tmp")) {
					const path = join(root, "registry", name);
					const stat = await lstat(path).catch(() => undefined);
					if (stat?.isFile() && stat.uid === uid() && now - stat.mtimeMs > STALE_MS) await rm(path, { force: true });
				}
			}
			return count;
		}) ?? 0;
	}
	return removed;
}

export async function sendToSession(
	session: DiscoveredSession,
	text: string,
	delivery: "steer" | "followUp" = "followUp",
	sourceInfo?: MessageSource,
): Promise<object> {
	return callSocket(session.socketPath, "deliver", {
		targetEndpointId: session.endpointId,
		messageId: randomUUID(),
		text,
		delivery,
		source: sourceInfo,
		hopCount: 0,
	});
}
