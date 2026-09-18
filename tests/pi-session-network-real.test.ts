import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { collectGarbage } from "../extensions/pi-session-network/network.ts";

const exec = promisify(execFile);
const enabled = process.env.PI_REAL_TUI_TESTS === "1";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function waitFor(check: () => Promise<boolean>, message: string): Promise<void> {
	for (let attempt = 0; attempt < 60; attempt++) {
		if (await check()) return;
		await sleep(100);
	}
	throw new Error(message);
}

test("real Pi TUI cleans and rotates endpoints across lifecycle operations", { skip: !enabled, timeout: 30_000 }, async () => {
	await exec("tmux", ["-V"]);
	const runtime = await mkdtemp(join(tmpdir(), "psn-real-"));
	const server = `psn-${process.pid}`;
	const sessionName = "pi-network-lifecycle";
	const registry = join(runtime, "pi-session-network", "registry");
	const sessionDir = join(runtime, "sessions");
	const extension = resolve("extensions/pi-session-network/index.ts");
	const cli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

	const fixture = SessionManager.create(process.cwd(), sessionDir);
	fixture.appendMessage({ role: "user", content: "lifecycle fixture", timestamp: Date.now() });
	fixture.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "fixture" }],
		api: "openai-responses",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	});

	const tmux = (...args: string[]) => exec("tmux", ["-L", server, ...args], { env: { ...process.env, TMUX_TMPDIR: runtime } });
	const files = async () => (await readdir(registry).catch(() => [])).filter((name) => name.endsWith(".json"));
	const current = async () => (await files())[0];
	const rotate = async (command: string, select = false) => {
		const old = await current();
		await tmux("send-keys", "-t", sessionName, command, "Enter");
		if (select) { await sleep(600); await tmux("send-keys", "-t", sessionName, "Enter"); }
		await waitFor(async () => { const next = await files(); return next.length === 1 && next[0] !== old; }, `${command} did not rotate endpoint`);
		assert.equal((await files()).includes(old ?? ""), false);
	};
	const launch = () => tmux(
		"new-session", "-d", "-s", sessionName, "-x", "120", "-y", "40",
		"env", `XDG_RUNTIME_DIR=${runtime}`, `PI_CODING_AGENT_DIR=${runtime}/agent`,
		process.execPath, cli, "--approve", "--no-extensions", "--extension", extension,
		"--session-dir", sessionDir, "--session", fixture.getSessionFile()!,
	);

	try {
		await launch();
		await waitFor(async () => (await files()).length === 1, "TUI endpoint did not start");
		await rotate("/reload");
		await rotate("/new");
		await rotate("/resume", true);
		await rotate("/fork", true);

		const beforeTerm = await current();
		const { stdout } = await tmux("display-message", "-p", "-t", sessionName, "#{pane_pid}");
		process.kill(Number(stdout.trim()), "SIGTERM");
		await waitFor(async () => (await files()).length === 0, "SIGTERM did not clean registry");
		assert.ok(beforeTerm);
		await tmux("kill-session", "-t", sessionName).catch(() => undefined);

		await launch();
		await waitFor(async () => (await files()).length === 1, "second TUI endpoint did not start");
		const { stdout: crashPid } = await tmux("display-message", "-p", "-t", sessionName, "#{pane_pid}");
		const killedPid = Number(crashPid.trim());
		process.kill(killedPid, "SIGKILL");
		await waitFor(async () => {
			try { process.kill(killedPid, 0); return false; }
			catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
		}, "crashed TUI process remained alive");
		await waitFor(async () => (await files()).length === 1, "crash unexpectedly removed stale registry");
		const removed = await collectGarbage([join(runtime, "pi-session-network")], Date.now() + 120_000);
		assert.equal(removed, 1);
		assert.deepEqual(await files(), []);
	} finally {
		await tmux("kill-server").catch(() => undefined);
		await rm(runtime, { recursive: true, force: true });
	}
});
