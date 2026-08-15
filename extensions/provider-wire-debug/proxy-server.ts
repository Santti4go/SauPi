import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { Readable } from "node:stream";

const LOOPBACK = "127.0.0.1";
const HOP_BY_HOP = new Set(["connection", "content-length", "host", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const SECRET_HEADER = /authorization|api[-_]?key|cookie|token|secret/i;

export interface WireDebugProxyOptions {
	upstream: string;
	logPath: string;
	port: number;
	showSecrets: boolean;
}

function joinUpstream(base: string, requestUrl: string): URL {
	const incoming = new URL(requestUrl, `http://${LOOPBACK}`);
	const target = new URL(base);
	const prefix = target.pathname.replace(/\/$/, "");
	target.pathname = `${prefix}${incoming.pathname.startsWith("/") ? incoming.pathname : `/${incoming.pathname}`}`;
	target.search = incoming.search;
	return target;
}

function displayHeaders(headers: IncomingHttpHeaders | Headers, showSecrets: boolean): Record<string, string | string[]> {
	const output: Record<string, string | string[]> = {};
	const entries = headers instanceof Headers ? headers.entries() : Object.entries(headers);
	for (const [name, value] of entries) {
		if (value === undefined) continue;
		output[name] = !showSecrets && SECRET_HEADER.test(name) ? "[REDACTED]" : value;
	}
	return output;
}

function forwardHeaders(headers: IncomingHttpHeaders): Headers {
	const output = new Headers();
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
		if (Array.isArray(value)) {
			for (const item of value) output.append(name, item);
		} else {
			output.set(name, value);
		}
	}
	return output;
}

export class WireDebugProxy {
	private server: Server | undefined;
	private proxyUrl: string | undefined;

	constructor(private readonly options: WireDebugProxyOptions) {}

	async start(): Promise<string> {
		if (this.proxyUrl) return this.proxyUrl;
		await mkdir(dirname(this.options.logPath), { recursive: true, mode: 0o700 });

		this.server = createServer(async (request, response) => {
			const id = randomUUID();
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			const body = Buffer.concat(chunks);
			const target = joinUpstream(this.options.upstream, request.url ?? "/");

			await this.writeRecord({
				type: "request",
				id,
				timestamp: new Date().toISOString(),
				method: request.method ?? "GET",
				url: target.toString(),
				headers: displayHeaders(request.headers, this.options.showSecrets),
				body: body.toString("utf8"),
				bodyBytes: body.length,
				bodySha256: createHash("sha256").update(body).digest("hex"),
			});

			const abort = new AbortController();
			response.on("close", () => {
				if (!response.writableEnded) abort.abort();
			});

			try {
				const upstream = await fetch(target, {
					method: request.method ?? "GET",
					headers: forwardHeaders(request.headers),
					...(body.length > 0 ? { body } : {}),
					signal: abort.signal,
					redirect: "manual",
				});
				await this.writeRecord({
					type: "response",
					id,
					timestamp: new Date().toISOString(),
					status: upstream.status,
					headers: displayHeaders(upstream.headers, this.options.showSecrets),
				});

				const responseHeaders: Record<string, string> = {};
				for (const [name, value] of upstream.headers) {
					if (!HOP_BY_HOP.has(name.toLowerCase()) && name !== "content-encoding") responseHeaders[name] = value;
				}
				response.writeHead(upstream.status, responseHeaders);
				if (!upstream.body) {
					response.end();
					return;
				}
				Readable.fromWeb(upstream.body as never).pipe(response);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await this.writeRecord({ type: "error", id, timestamp: new Date().toISOString(), message });
				if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
				response.end(`Provider wire debug proxy error: ${message}`);
			}
		});

		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.options.port, LOOPBACK, () => {
				this.server!.removeListener("error", reject);
				resolve();
			});
		});
		const address = this.server.address() as AddressInfo;
		this.proxyUrl = `http://${LOOPBACK}:${address.port}`;
		return this.proxyUrl;
	}

	async stop(): Promise<void> {
		if (!this.server) return;
		const server = this.server;
		this.server = undefined;
		this.proxyUrl = undefined;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	private async writeRecord(record: Record<string, unknown>): Promise<void> {
		await appendFile(this.options.logPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
	}
}
