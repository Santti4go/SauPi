import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WireDebugProxy } from "../extensions/provider-wire-debug/proxy-server.ts";

test("the wire debug proxy records the serialized body and forwards the request", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-wire-debug-"));
	const logPath = join(directory, "wire.jsonl");
	let receivedPath = "";
	let receivedBody = "";
	let receivedAuthorization = "";
	const upstream = createServer(async (request, response) => {
		receivedPath = request.url ?? "";
		receivedAuthorization = request.headers.authorization ?? "";
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		receivedBody = Buffer.concat(chunks).toString("utf8");
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end("data: done\n\n");
	});
	await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
	const upstreamPort = (upstream.address() as AddressInfo).port;
	const proxy = new WireDebugProxy({
		upstream: `http://127.0.0.1:${upstreamPort}/v1`,
		logPath,
		port: 0,
		showSecrets: false,
	});
	const proxyUrl = await proxy.start();
	const body = JSON.stringify({ input: [{ role: "user", content: "edited message" }] });

	try {
		const response = await fetch(`${proxyUrl}/responses?stream=true`, {
			method: "POST",
			headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
			body,
		});
		assert.equal(response.status, 200);
		assert.equal(await response.text(), "data: done\n\n");
		assert.equal(receivedPath, "/v1/responses?stream=true");
		assert.equal(receivedBody, body);
		assert.equal(receivedAuthorization, "Bearer test-secret");

		const records = (await readFile(logPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		assert.equal(records[0]?.type, "request");
		assert.equal(records[0]?.body, body);
		assert.equal((records[0]?.headers as Record<string, string>).authorization, "[REDACTED]");
		assert.equal(records[1]?.type, "response");
		assert.equal(records[1]?.status, 200);
	} finally {
		await proxy.stop();
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
});
