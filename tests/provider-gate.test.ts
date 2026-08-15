import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ApprovalQueue, serializePayload } from "../extensions/provider-gate/approval-queue.ts";
import providerGateExtension from "../extensions/provider-gate/index.ts";
import { extractLatestUserMessage, shouldGatePayload } from "../extensions/provider-gate/payload-inspection.ts";
import { ProviderGateServer } from "../extensions/provider-gate/server.ts";

test("serializes complete payloads without failing on cycles or bigint", () => {
	const payload: { count: bigint; self?: unknown } = { count: 12n };
	payload.self = payload;

	const serialized = serializePayload(payload);
	assert.match(serialized, /"12n"/);
	assert.match(serialized, /\[Circular\]/);
});

test("an approval stays pending until an explicit decision", async () => {
	const queue = new ApprovalQueue();
	const handle = queue.request({ messages: [{ role: "user", content: "private" }] });
	let settled = false;
	void handle.decision.then(() => {
		settled = true;
	});

	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, false);
	assert.equal(queue.snapshot()[0]?.status, "pending");
	assert.deepEqual(queue.approve(handle.review.id, handle.review.payload), { accepted: true });
	assert.deepEqual(await handle.decision, { decision: "approved", modified: false });
});

test("an edited approval resolves with a parsed replacement payload", async () => {
	const queue = new ApprovalQueue();
	const handle = queue.request({ temperature: 1, messages: [] });
	const edited = JSON.stringify({ temperature: 0, messages: [{ role: "user", content: "reviewed" }] }, null, 2);

	assert.deepEqual(queue.approve(handle.review.id, edited), { accepted: true });
	assert.deepEqual(await handle.decision, {
		decision: "approved",
		modified: true,
		payload: { temperature: 0, messages: [{ role: "user", content: "reviewed" }] },
	});
	assert.equal(queue.snapshot()[0]?.modified, true);
	assert.equal(queue.snapshot()[0]?.userMessage, "reviewed");
});

test("only provider payloads ending in a human user input require approval", () => {
	const user = { role: "user", content: [{ type: "input_text", text: "ship it" }] };
	assert.equal(shouldGatePayload({ input: [user] }), true);
	assert.equal(extractLatestUserMessage({ input: [user] }), "ship it");
	assert.equal(shouldGatePayload({ input: [user, { type: "function_call", name: "read" }] }), false);
	assert.equal(
		shouldGatePayload({ input: [user, { type: "function_call_output", call_id: "1", output: "ok" }] }),
		false,
	);
	assert.equal(
		shouldGatePayload({ messages: [user, { role: "user", content: [{ type: "tool_result", content: "ok" }] }] }),
		false,
	);
	assert.equal(
		shouldGatePayload({ contents: [user, { role: "user", parts: [{ type: "functionResponse", response: {} }] }] }),
		false,
	);
});

test("the loopback server requires its token and accepts browser decisions", async () => {
	const queue = new ApprovalQueue();
	const server = new ProviderGateServer(queue, 0);
	const url = await server.start();

	try {
		const unauthorized = await fetch(new URL("/state", url));
		assert.equal(unauthorized.status, 403);

		const page = await fetch(url);
		assert.equal(page.status, 200);
		const html = await page.text();
		assert.match(html, /ACCEPT/);
		assert.match(html, /REJECT/);
		assert.match(html, /COPY/);
		assert.match(html, /EDIT/);
		assert.match(html, /USER/);
		assert.match(html, /DROP LAST TURN/);
		assert.match(html, /HISTORY/);
		assert.match(html, /EventSource/);

		const handle = queue.request({ tools: [{ name: "read" }] });
		const stateUrl = new URL("/state", url);
		stateUrl.search = new URL(url).search;
		const state = (await (await fetch(stateUrl)).json()) as Array<{ id: string; payload: string }>;
		assert.equal(state[0]?.id, handle.review.id);
		assert.match(state[0]?.payload ?? "", /"tools"/);

		const approveUrl = new URL(`/requests/${handle.review.id}/approve`, url);
		approveUrl.search = new URL(url).search;
		assert.equal((await fetch(approveUrl, { method: "POST", body: "{" })).status, 400);
		assert.equal(queue.snapshot()[0]?.status, "pending");

		const edited = JSON.stringify({ tools: [], temperature: 0 }, null, 2);
		assert.equal((await fetch(approveUrl, { method: "POST", body: edited })).status, 200);
		assert.deepEqual(await handle.decision, {
			decision: "approved",
			modified: true,
			payload: { tools: [], temperature: 0 },
		});
		const updated = (await (await fetch(stateUrl)).json()) as Array<{
			payload: string;
			modified: boolean;
		}>;
		assert.equal(updated[0]?.payload, edited);
		assert.equal(updated[0]?.modified, true);
	} finally {
		queue.close();
		await server.stop();
	}
});

test("the Pi hook replaces edited approvals and aborts rejected requests", async () => {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const commands = new Map<string, (...args: unknown[]) => unknown>();
	const flags = new Map<string, boolean | string | undefined>();
	const notifications: string[] = [];
	const pi = {
		registerFlag(name: string, options: { default?: boolean | string }) {
			flags.set(name, name === "provider-gate-no-open" ? true : options.default);
		},
		getFlag(name: string) {
			return flags.get(name);
		},
		registerCommand(name: string, options: { handler: (...args: unknown[]) => unknown }) {
			commands.set(name, options.handler);
		},
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	const controller = new AbortController();
	let abortCount = 0;
	const ctx = {
		hasUI: true,
		signal: controller.signal,
		abort() {
			abortCount++;
			controller.abort();
		},
		ui: {
			setStatus() {},
			notify(text: string) {
				notifications.push(text);
			},
		},
	} as unknown as ExtensionContext;

	providerGateExtension(pi);
	const sessionStart = handlers.get("session_start");
	const beforeRequest = handlers.get("before_provider_request");
	const shutdown = handlers.get("session_shutdown");
	assert.ok(sessionStart && beforeRequest && shutdown);
	await sessionStart({}, ctx);

	const browserUrl = notifications.find((item) => item.startsWith("Provider authorization UI: "))?.slice(
		"Provider authorization UI: ".length,
	);
	assert.ok(browserUrl);
	assert.equal(await beforeRequest({ payload: { input: [{ role: "user", content: "hello" }, { type: "function_call" }] } }, ctx), undefined);
	const stateBeforeCommands = new URL("/state", browserUrl);
	stateBeforeCommands.search = new URL(browserUrl).search;
	assert.deepEqual(await (await fetch(stateBeforeCommands)).json(), []);

	const gateOff = commands.get("gate-off");
	const gateOn = commands.get("gate-on");
	assert.ok(gateOff && gateOn);
	await gateOff("", ctx);
	assert.equal(await beforeRequest({ payload: { input: [{ role: "user", content: "bypassed" }] } }, ctx), undefined);
	assert.deepEqual(await (await fetch(stateBeforeCommands)).json(), []);
	await gateOn("", ctx);

	const editedPending = beforeRequest({ payload: { input: [{ role: "user", content: "secret" }], temperature: 1 } }, ctx);
	await new Promise((resolve) => setImmediate(resolve));

	const stateUrl = new URL("/state", browserUrl);
	stateUrl.search = new URL(browserUrl).search;
	let reviews = (await (await fetch(stateUrl)).json()) as Array<{ id: string }>;
	const approveUrl = new URL(`/requests/${reviews[0]!.id}/approve`, browserUrl);
	approveUrl.search = new URL(browserUrl).search;
	await fetch(approveUrl, {
		method: "POST",
		body: JSON.stringify({ messages: ["reviewed"], temperature: 0 }),
	});
	assert.deepEqual(await editedPending, { messages: ["reviewed"], temperature: 0 });
	assert.equal(abortCount, 0);

	const rejectedPending = beforeRequest({ payload: { input: [{ role: "user", content: "reject me" }] } }, ctx);
	await new Promise((resolve) => setImmediate(resolve));
	reviews = (await (await fetch(stateUrl)).json()) as Array<{ id: string }>;
	const rejectUrl = new URL(`/requests/${reviews[0]!.id}/reject`, browserUrl);
	rejectUrl.search = new URL(browserUrl).search;
	await fetch(rejectUrl, { method: "POST" });

	assert.equal(await rejectedPending, undefined);
	assert.equal(abortCount, 1);
	await shutdown({}, ctx);
});
