import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ApprovalQueue, serializePayload } from "../extensions/provider-gate/approval-queue.ts";
import providerGateExtension from "../extensions/provider-gate/index.ts";
import { extractLatestUserMessage, shouldGatePayload } from "../extensions/provider-gate/payload-inspection.ts";
import { ProjectionLedger } from "../extensions/provider-gate/projection-ledger.ts";
import { ProviderGateServer } from "../extensions/provider-gate/server.ts";
import { collectProviderGateMetrics } from "../extensions/provider-gate/telemetry.ts";

test("serializes complete payloads without failing on cycles or bigint", () => {
	const payload: { count: bigint; self?: unknown } = { count: 12n };
	payload.self = payload;

	const serialized = serializePayload(payload);
	assert.match(serialized, /"12n"/);
	assert.match(serialized, /\[Circular\]/);
});

test("an approval stays pending until an explicit decision", async () => {
	const queue = new ApprovalQueue(new ProjectionLedger());
	const handle = queue.request({ messages: [{ role: "user", content: "private" }] });
	let settled = false;
	void handle.decision.then(() => {
		settled = true;
	});

	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(settled, false);
	assert.equal(queue.snapshot()[0]?.status, "pending");
	assert.deepEqual(queue.approve(handle.review.id, handle.review.sentPayload), { accepted: true });
	assert.deepEqual(await handle.decision, { decision: "approved", modified: false });
});

test("a bypassed request is audited without creating a pending decision", () => {
	const ledger = new ProjectionLedger();
	const queue = new ApprovalQueue(ledger);
	const review = queue.observe(ledger.project({ input: [{ role: "user", content: "inspect later" }] }));

	assert.equal(review.status, "bypassed");
	assert.equal(review.userMessage, "inspect later");
	assert.equal(queue.snapshot()[0]?.id, review.id);
	assert.equal(queue.approve(review.id, review.sentPayload).accepted, false);
});

test("an edited approval resolves with a parsed replacement payload", async () => {
	const ledger = new ProjectionLedger();
	const queue = new ApprovalQueue(ledger);
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
	const next = ledger.project({
		messages: [
			{ role: "user", content: "reviewed" },
			{ role: "assistant", content: "done" },
			{ role: "user", content: "next" },
		],
	});
	assert.equal(next.changed, false);
});

test("message replacements and dropped turns are projected into N+1", async () => {
	const ledger = new ProjectionLedger();
	const queue = new ApprovalQueue(ledger);
	const firstUser = { role: "user", content: "original" };
	const firstAssistant = { role: "assistant", content: "answer" };
	const currentUser = { role: "user", content: "current" };
	const handle = queue.request({ input: [firstUser, firstAssistant, currentUser] });
	const edited = JSON.parse(handle.review.sentPayload) as { input: Array<Record<string, unknown>> };
	edited.input[2]!.content = "edited current";
	assert.equal(queue.dropLastTurn(handle.review.id, JSON.stringify(edited)).accepted, true);
	assert.equal(queue.approve(handle.review.id, queue.snapshot()[0]!.sentPayload).accepted, true);
	await handle.decision;

	const next = ledger.project({
		input: [
			firstUser,
			firstAssistant,
			currentUser,
			{ role: "assistant", content: "new answer" },
			{ role: "user", content: "N+1" },
		],
	});
	assert.deepEqual((next.payload as { input: unknown[] }).input, [
		{ role: "user", content: "edited current" },
		{ role: "assistant", content: "new answer" },
		{ role: "user", content: "N+1" },
	]);
	assert.equal(next.appliedOperations, 3);
	const restored = new ProjectionLedger();
	restored.restore(ledger.snapshot());
	assert.deepEqual(restored.project(next.rawPayload).payload, next.payload);
});

test("rejected projection drafts do not affect later requests", async () => {
	const ledger = new ProjectionLedger();
	const queue = new ApprovalQueue(ledger);
	const handle = queue.request({
		input: [
			{ role: "user", content: "old" },
			{ role: "assistant", content: "old answer" },
			{ role: "user", content: "current" },
		],
	});
	assert.equal(queue.dropLastTurn(handle.review.id, handle.review.sentPayload).accepted, true);
	assert.equal(queue.reject(handle.review.id), true);
	assert.deepEqual(await handle.decision, { decision: "rejected", modified: false });
	assert.equal(ledger.operationCount, 0);
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

test("collects current branch token, context, model, and cost telemetry", () => {
	const ctx = {
		sessionManager: {
			getBranch: () => [
				{
					type: "message",
					message: {
						role: "assistant",
						usage: {
							input: 1_000,
							output: 200,
							cacheRead: 500,
							cacheWrite: 100,
							cost: { total: 0.012 },
						},
					},
				},
			],
		},
		model: {
			provider: "test-provider",
			id: "test-model",
			contextWindow: 128_000,
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
		},
		modelRegistry: { isUsingOAuth: () => false },
		getContextUsage: () => ({ tokens: 32_000, contextWindow: 128_000, percent: 25 }),
	} as unknown as ExtensionContext;

	const metrics = collectProviderGateMetrics(ctx);
	assert.deepEqual(metrics.model, { provider: "test-provider", id: "test-model" });
	assert.deepEqual(metrics.tokens, {
		input: 1_000,
		output: 200,
		cacheRead: 500,
		cacheWrite: 100,
		total: 1_800,
	});
	assert.equal(metrics.cost, 0.012);
	assert.equal(metrics.billing, "metered");
	assert.deepEqual(metrics.context, { tokens: 32_000, contextWindow: 128_000, percent: 25 });
});

test("the loopback server requires its token and accepts browser decisions", async () => {
	const queue = new ApprovalQueue(new ProjectionLedger());
	const server = new ProviderGateServer(queue, 0);
	server.updateMetrics({
		updatedAt: new Date(0).toISOString(),
		model: { provider: "test-provider", id: "test-model" },
		tokens: { input: 1_000, output: 200, cacheRead: 500, cacheWrite: 100, total: 1_800 },
		cost: 0.012,
		billing: "metered",
		context: { tokens: 32_000, contextWindow: 128_000, percent: 25 },
	});
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
		assert.match(html, /RAW PI/);
		assert.match(html, /SENT/);
		assert.match(html, /HISTORY/);
		assert.match(html, /PI CONTEXT/);
		assert.match(html, /SESSION TOKENS/);
		assert.match(html, /COST/);
		assert.match(html, /EventSource/);

		const metricsUrl = new URL("/metrics", url);
		metricsUrl.search = new URL(url).search;
		const metrics = (await (await fetch(metricsUrl)).json()) as { tokens: { total: number }; context: { percent: number } };
		assert.equal(metrics.tokens.total, 1_800);
		assert.equal(metrics.context.percent, 25);

		const handle = queue.request({ tools: [{ name: "read" }] });
		const stateUrl = new URL("/state", url);
		stateUrl.search = new URL(url).search;
		const state = (await (await fetch(stateUrl)).json()) as Array<{ id: string; sentPayload: string }>;
		assert.equal(state[0]?.id, handle.review.id);
		assert.match(state[0]?.sentPayload ?? "", /"tools"/);

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
			sentPayload: string;
			modified: boolean;
		}>;
		assert.equal(updated[0]?.sentPayload, edited);
		assert.equal(updated[0]?.modified, true);

		const dropHandle = queue.request({
			input: [
				{ role: "user", content: "old" },
				{ role: "assistant", content: "old answer" },
				{ role: "user", content: "current" },
			],
		});
		const dropUrl = new URL(`/requests/${dropHandle.review.id}/drop-last-turn`, url);
		dropUrl.search = new URL(url).search;
		assert.equal((await fetch(dropUrl, { method: "POST", body: dropHandle.review.sentPayload })).status, 200);
		const droppedState = (await (await fetch(stateUrl)).json()) as Array<{ id: string; sentPayload: string }>;
		assert.doesNotMatch(droppedState.find((item) => item.id === dropHandle.review.id)!.sentPayload, /old answer/);
		const dropRejectUrl = new URL(`/requests/${dropHandle.review.id}/reject`, url);
		dropRejectUrl.search = new URL(url).search;
		await fetch(dropRejectUrl, { method: "POST" });
		await dropHandle.decision;
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
	const customEntries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
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
		appendEntry(customType: string, data: unknown) {
			customEntries.push({ type: "custom", customType, data });
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
		sessionManager: {
			getBranch() {
				return customEntries;
			},
		},
		model: {
			provider: "test-provider",
			id: "test-model",
			contextWindow: 128_000,
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
		},
		modelRegistry: { isUsingOAuth: () => false },
		getContextUsage: () => ({ tokens: 8_000, contextWindow: 128_000, percent: 6.25 }),
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
	const metricsUrl = new URL("/metrics", browserUrl);
	metricsUrl.search = new URL(browserUrl).search;
	const metrics = (await (await fetch(metricsUrl)).json()) as { model: { id: string }; context: { tokens: number } };
	assert.equal(metrics.model.id, "test-model");
	assert.equal(metrics.context.tokens, 8_000);
	assert.equal(await beforeRequest({ payload: { input: [{ role: "user", content: "hello" }, { type: "function_call" }] } }, ctx), undefined);
	const stateBeforeCommands = new URL("/state", browserUrl);
	stateBeforeCommands.search = new URL(browserUrl).search;
	assert.deepEqual(await (await fetch(stateBeforeCommands)).json(), []);

	const gateOff = commands.get("gate-off");
	const gateOn = commands.get("gate-on");
	assert.ok(gateOff && gateOn);
	assert.equal(await beforeRequest({ payload: { input: [{ role: "user", content: "bypassed" }] } }, ctx), undefined);
	const bypassedAtStartup = (await (await fetch(stateBeforeCommands)).json()) as Array<{
		status: string;
		userMessage?: string;
	}>;
	assert.equal(bypassedAtStartup[0]?.status, "bypassed");
	assert.equal(bypassedAtStartup[0]?.userMessage, "bypassed");
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
		body: JSON.stringify({ input: [{ role: "user", content: "reviewed" }], temperature: 0 }),
	});
	assert.deepEqual(await editedPending, { input: [{ role: "user", content: "reviewed" }], temperature: 0 });
	assert.equal(abortCount, 0);
	assert.equal(customEntries.length, 1);

	const toolContinuation = await beforeRequest(
		{ payload: { input: [{ role: "user", content: "secret" }, { type: "function_call", id: "call-1" }] } },
		ctx,
	);
	assert.deepEqual(toolContinuation, {
		input: [{ role: "user", content: "reviewed" }, { type: "function_call", id: "call-1" }],
	});

	await gateOff("", ctx);
	const bypassedProjection = await beforeRequest(
		{
			payload: {
				input: [
					{ role: "user", content: "secret" },
					{ role: "assistant", content: "answer" },
					{ role: "user", content: "next" },
				],
			},
		},
		ctx,
	);
	assert.deepEqual(bypassedProjection, {
		input: [
			{ role: "user", content: "reviewed" },
			{ role: "assistant", content: "answer" },
			{ role: "user", content: "next" },
		],
	});
	const bypassedReviews = (await (await fetch(stateUrl)).json()) as Array<{
		status: string;
		rawPayload: string;
		sentPayload: string;
	}>;
	assert.equal(bypassedReviews[0]?.status, "bypassed");
	assert.match(bypassedReviews[0]!.rawPayload, /secret/);
	assert.match(bypassedReviews[0]!.sentPayload, /reviewed/);
	assert.doesNotMatch(bypassedReviews[0]!.sentPayload, /secret/);
	await gateOn("", ctx);

	const projectedPending = beforeRequest(
		{
			payload: {
				input: [
					{ role: "user", content: "secret" },
					{ role: "assistant", content: "answer" },
					{ role: "user", content: "N+1" },
				],
			},
		},
		ctx,
	);
	await new Promise((resolve) => setImmediate(resolve));
	const projectedReviews = (await (await fetch(stateUrl)).json()) as Array<{
		id: string;
		rawPayload: string;
		sentPayload: string;
	}>;
	assert.match(projectedReviews[0]!.rawPayload, /secret/);
	assert.match(projectedReviews[0]!.sentPayload, /reviewed/);
	assert.doesNotMatch(projectedReviews[0]!.sentPayload, /secret/);
	const projectedApproveUrl = new URL(`/requests/${projectedReviews[0]!.id}/approve`, browserUrl);
	projectedApproveUrl.search = new URL(browserUrl).search;
	await fetch(projectedApproveUrl, { method: "POST", body: projectedReviews[0]!.sentPayload });
	assert.deepEqual(await projectedPending, {
		input: [
			{ role: "user", content: "reviewed" },
			{ role: "assistant", content: "answer" },
			{ role: "user", content: "N+1" },
		],
	});

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
