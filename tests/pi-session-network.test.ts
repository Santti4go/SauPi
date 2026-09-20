import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	callSocket,
	collectGarbage,
	createRuntimeRoot,
	listLiveSessions,
	LiveEndpoint,
	type LiveSession,
} from "../extensions/pi-session-network/network.ts";
import { RpcProcess } from "../extensions/pi-session-network/rpc-process.ts";
import { Coordinator } from "../extensions/pi-session-network/coordinator.ts";

function metadata(root: string, endpointId: string): LiveSession {
	const now = Date.now();
	return {
		protocolVersion: 1,
		revision: 1,
		endpointId,
		transport: "tui-socket",
		managedBy: null,
		pid: process.pid,
		processUptimeSeconds: process.uptime(),
		sessionId: randomUUID(),
		sessionName: "test-session",
		sessionFile: null,
		cwd: process.cwd(),
		socketPath: join(root, "sockets", `${endpointId}.sock`),
		model: { provider: "test", id: "model" },
		thinkingLevel: "off",
		status: "idle",
		startedAt: now,
		updatedAt: now,
		heartbeatAt: now,
		lastActivityAt: now,
		piVersion: "0.85.1",
		capabilities: ["ping", "get_info"],
		statusPrecision: "tui-best-effort",
		pendingMessageCount: null,
	};
}

async function fixture(): Promise<{ parent: string; root: string; endpointId: string }> {
	const parent = await mkdtemp(join(tmpdir(), "psn-"));
	await chmod(parent, 0o700);
	const endpointId = randomUUID();
	const root = await createRuntimeRoot(endpointId, { XDG_RUNTIME_DIR: parent });
	return { parent, root, endpointId };
}

test("discovers a live endpoint and observes updates", async () => {
	const { parent, root, endpointId } = await fixture();
	const endpoint = new LiveEndpoint(root, metadata(root, endpointId));
	try {
		await endpoint.start();
		let sessions = await listLiveSessions([root]);
		assert.equal(sessions.length, 1);
		assert.equal(sessions[0]?.reachable, true);
		assert.equal(sessions[0]?.status, "idle");

		await endpoint.update({ status: "running", heartbeatAt: Date.now() });
		sessions = await listLiveSessions([root]);
		assert.equal(sessions[0]?.status, "running");

		const registryPath = join(root, "registry", `${endpointId}.json`);
		const socketPath = join(root, "sockets", `${endpointId}.sock`);
		const registry = JSON.parse(await readFile(registryPath, "utf8"));
		assert.equal(registry.revision, 2);

		await endpoint.stop();
		assert.deepEqual(await listLiveSessions([root]), []);
		await assert.rejects(lstat(registryPath), { code: "ENOENT" });
		await assert.rejects(lstat(socketPath), { code: "ENOENT" });
	} finally {
		await endpoint.stop();
		await rm(parent, { recursive: true, force: true });
	}
});

test("marks valid registry metadata unreachable when no socket responds", async () => {
	const { parent, root, endpointId } = await fixture();
	try {
		const info = metadata(root, endpointId);
		await writeFile(join(root, "registry", `${endpointId}.json`), JSON.stringify(info), { mode: 0o600 });
		const sessions = await listLiveSessions([root]);
		assert.equal(sessions.length, 1);
		assert.equal(sessions[0]?.reachable, false);
		assert.equal(sessions[0]?.status, "unreachable");
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test("deduplicates delivered messages and rejects ID conflicts", async () => {
	const { parent, root, endpointId } = await fixture();
	let deliveries = 0;
	const info = metadata(root, endpointId);
	info.capabilities.push("deliver");
	const endpoint = new LiveEndpoint(root, info, {
		deliver: ({ messageId }) => ({ accepted: true, messageId, deliveryNumber: ++deliveries }),
	});
	try {
		await endpoint.start();
		const params = {
			targetEndpointId: endpointId,
			messageId: "message-1",
			text: "hello",
			delivery: "followUp",
			hopCount: 0,
		};
		const path = join(root, "sockets", `${endpointId}.sock`);
		await Promise.all([
			callSocket(path, "deliver", params),
			callSocket(path, "deliver", params),
			callSocket(path, "deliver", params),
		]);
		assert.equal(deliveries, 1);
		await assert.rejects(callSocket(path, "deliver", { ...params, text: "different" }), { code: "ID_CONFLICT" });
	} finally {
		await endpoint.stop();
		await rm(parent, { recursive: true, force: true });
	}
});

test("garbage collection is locked and removes only proven stale endpoints", async () => {
	const { parent, root, endpointId } = await fixture();
	try {
		const info = metadata(root, endpointId);
		info.pid = 99_999_999;
		info.heartbeatAt = Date.now() - 120_000;
		await writeFile(join(root, "registry", `${endpointId}.json`), JSON.stringify(info), { mode: 0o600 });
		const counts = await Promise.all([collectGarbage([root]), collectGarbage([root])]);
		assert.equal(counts.reduce((sum, count) => sum + count, 0), 1);
		assert.deepEqual(await listLiveSessions([root]), []);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test("supervises a real Pi RPC process", async () => {
	const parent = await mkdtemp(join(tmpdir(), "psn-rpc-"));
	const cli = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
	const worker = new RpcProcess(process.cwd(), "rpc-lifecycle-test", process.execPath, [
		cli,
		"--no-extensions",
		"--no-tools",
		"--session-dir",
		join(parent, "sessions"),
	]);
	try {
		const state = await worker.start();
		assert.equal(state.sessionName, "rpc-lifecycle-test");
		assert.equal(state.isStreaming, false);
		assert.ok(worker.pid > 0);
	} finally {
		await worker.stop();
		await rm(parent, { recursive: true, force: true });
	}
});

test("publishes and controls an RPC worker through the unified proxy", async () => {
	const parent = await mkdtemp(join(tmpdir(), "psn-coord-"));
	const oldRuntime = process.env.XDG_RUNTIME_DIR;
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.XDG_RUNTIME_DIR = parent;
	process.env.PI_CODING_AGENT_DIR = join(parent, "agent");
	const coordinator = new Coordinator();
	try {
		await coordinator.start();
		const info = await coordinator.spawn(process.cwd(), "proxy-test");
		const sessions = await listLiveSessions([join(parent, "pi-session-network")]);
		assert.equal(sessions[0]?.transport, "rpc-proxy");
		assert.equal(sessions[0]?.endpointId, info.endpointId);
		await callSocket(info.socketPath, "abort", { targetEndpointId: info.endpointId });
		await callSocket(info.socketPath, "stop", { targetEndpointId: info.endpointId });
		for (let attempt = 0; attempt < 30 && (await listLiveSessions([join(parent, "pi-session-network")])).length; attempt++) {
			await new Promise((done) => setTimeout(done, 100));
		}
		assert.deepEqual(await listLiveSessions([join(parent, "pi-session-network")]), []);
	} finally {
		await coordinator.stop();
		if (oldRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = oldRuntime;
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		await rm(parent, { recursive: true, force: true });
	}
});

test("ignores malformed and insecure registry entries", async () => {
	const { parent, root, endpointId } = await fixture();
	try {
		await writeFile(join(root, "registry", `${endpointId}.json`), "not json", { mode: 0o600 });
		const otherId = randomUUID();
		await writeFile(join(root, "registry", `${otherId}.json`), JSON.stringify(metadata(root, otherId)), { mode: 0o644 });
		const linkedId = randomUUID();
		await writeFile(join(parent, "linked.json"), JSON.stringify(metadata(root, linkedId)), { mode: 0o600 });
		await symlink(join(parent, "linked.json"), join(root, "registry", `${linkedId}.json`));
		assert.deepEqual(await listLiveSessions([root]), []);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});
