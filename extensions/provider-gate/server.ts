import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ApprovalQueue, type ProviderReview } from "./approval-queue.ts";
import { PROVIDER_GATE_HTML } from "./web-ui.ts";

const LOOPBACK = "127.0.0.1";
const MAX_EDIT_BYTES = 64 * 1024 * 1024;

function send(response: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
	response.writeHead(status, {
		"content-type": contentType,
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	response.end(body);
}

function sse(response: ServerResponse, event: string, value: unknown): void {
	response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function secureEqual(left: string | null, right: string): boolean {
	if (!left) return false;
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > MAX_EDIT_BYTES) throw new Error("Edited payload exceeds 64 MiB");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export class ProviderGateServer {
	private readonly token = randomBytes(24).toString("hex");
	private readonly clients = new Set<ServerResponse>();
	private server: Server | undefined;
	private unsubscribe: (() => void) | undefined;
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	private publicUrl: string | undefined;

	constructor(
		private readonly queue: ApprovalQueue,
		private readonly port: number,
	) {}

	async start(): Promise<string> {
		if (this.publicUrl) return this.publicUrl;

		this.server = createServer(async (request, response) => {
			const url = new URL(request.url ?? "/", `http://${LOOPBACK}`);
			if (!secureEqual(url.searchParams.get("token"), this.token)) {
				send(response, 403, "Forbidden");
				return;
			}

			if (request.method === "GET" && url.pathname === "/") {
				response.setHeader(
					"content-security-policy",
					"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
				);
				send(response, 200, PROVIDER_GATE_HTML, "text/html; charset=utf-8");
				return;
			}

			if (request.method === "GET" && url.pathname === "/events") {
				response.writeHead(200, {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-store",
					connection: "keep-alive",
					"x-accel-buffering": "no",
				});
				this.clients.add(response);
				sse(response, "snapshot", this.queue.snapshot());
				request.on("close", () => this.clients.delete(response));
				return;
			}

			if (request.method === "GET" && url.pathname === "/state") {
				send(response, 200, JSON.stringify(this.queue.snapshot()), "application/json; charset=utf-8");
				return;
			}

			const decision = url.pathname.match(/^\/requests\/([^/]+)\/(approve|reject)$/);
			if (request.method === "POST" && decision) {
				const id = decodeURIComponent(decision[1]!);
				if (decision[2] === "reject") {
					const accepted = this.queue.reject(id);
					send(response, accepted ? 200 : 409, accepted ? "OK" : "Request is no longer pending");
					return;
				}

				try {
					const attempt = this.queue.approve(id, await readBody(request));
					if (attempt.error) {
						send(response, 400, `Invalid JSON: ${attempt.error}`);
						return;
					}
					send(response, attempt.accepted ? 200 : 409, attempt.accepted ? "OK" : "Request is no longer pending");
				} catch (error) {
					send(response, 413, error instanceof Error ? error.message : "Payload too large");
				}
				return;
			}

			send(response, 404, "Not found");
		});

		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.port, LOOPBACK, () => {
				this.server!.removeListener("error", reject);
				resolve();
			});
		});

		const address = this.server.address() as AddressInfo;
		this.publicUrl = `http://${LOOPBACK}:${address.port}/?token=${this.token}`;
		this.unsubscribe = this.queue.subscribe((review) => this.broadcast(review));
		this.heartbeat = setInterval(() => {
			for (const client of this.clients) client.write(": keepalive\n\n");
		}, 15_000);
		this.heartbeat.unref?.();
		return this.publicUrl;
	}

	async stop(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = undefined;
		for (const client of this.clients) client.end();
		this.clients.clear();
		if (!this.server) return;

		const server = this.server;
		this.server = undefined;
		this.publicUrl = undefined;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	private broadcast(review: ProviderReview): void {
		for (const client of this.clients) sse(client, "review", review);
	}
}

function isWsl(): boolean {
	if (process.env.WSL_DISTRO_NAME) return true;
	try {
		return readFileSync("/proc/sys/kernel/osrelease", "utf8").toLowerCase().includes("microsoft");
	} catch {
		return false;
	}
}

export function openBrowser(url: string): void {
	let command: string;
	let args: string[];
	if (process.platform === "win32") {
		command = "cmd.exe";
		args = ["/c", "start", "", url];
	} else if (process.platform === "darwin") {
		command = "open";
		args = [url];
	} else if (isWsl()) {
		command = "cmd.exe";
		args = ["/c", "start", "", url];
	} else {
		command = "xdg-open";
		args = [url];
	}

	const child = spawn(command, args, { detached: true, stdio: "ignore" });
	child.once("error", () => undefined);
	child.unref();
}
