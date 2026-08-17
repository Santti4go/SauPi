import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import protectedPathsExtension from "../extensions/protected-paths/index.ts";
import { mkdtemp } from "node:fs/promises";
import {
	collectPathArguments,
	findProtectedTarget,
	loadProtectionPolicy,
} from "../extensions/protected-paths/policy.ts";

async function fixture(): Promise<{ cwd: string; configPath: string }> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-protected-paths-"));
	await mkdir(join(cwd, ".pi"));
	await mkdir(join(cwd, "secrets"));
	await writeFile(join(cwd, ".env"), "TOKEN=test\n");
	const configPath = join(cwd, ".pi", "protected-paths.yaml");
	await writeFile(configPath, "protectedPaths:\n  - .env\n  - secrets/\n");
	return { cwd, configPath };
}

test("loads file and directory rules and protects its own config", async () => {
	const { cwd, configPath } = await fixture();
	const policy = await loadProtectionPolicy(configPath, cwd);

	assert.ok(policy);
	assert.equal(policy.rules.length, 3);
	assert.ok(findProtectedTarget(policy, { path: ".env" }, cwd));
	assert.ok(findProtectedTarget(policy, { path: "secrets/token.txt" }, cwd));
	assert.ok(findProtectedTarget(policy, { path: ".pi/protected-paths.yaml" }, cwd));
	assert.equal(findProtectedTarget(policy, { path: ".env.example" }, cwd), undefined);
});

test("finds nested and array path arguments", () => {
	assert.deepEqual(collectPathArguments({ options: { files: ["a", "b"] }, content: "ignored" }), ["a", "b"]);
});

test("detects a protected path referenced by bash", async () => {
	const { cwd, configPath } = await fixture();
	const policy = await loadProtectionPolicy(configPath, cwd);

	assert.ok(policy);
	assert.ok(findProtectedTarget(policy, { command: "printf x > .env" }, cwd, "printf x > .env"));
	assert.equal(findProtectedTarget(policy, { command: "printf x > output.txt" }, cwd, "printf x > output.txt"), undefined);
});

test("detects Git access through a protected worktree", async () => {
	const { cwd, configPath } = await fixture();
	await mkdir(join(cwd, ".git"));
	await mkdir(join(cwd, "backend"));
	await writeFile(configPath, "protectedPaths:\n  - .git/\n");
	const policy = await loadProtectionPolicy(configPath, cwd);

	assert.ok(policy);
	assert.ok(findProtectedTarget(policy, { command: "git -C . status" }, cwd, "git -C . status"));
	assert.ok(findProtectedTarget(policy, { command: "git -C backend status" }, cwd, "git -C backend status"));
});

test("accepts a top-level YAML list", async () => {
	const { cwd, configPath } = await fixture();
	await writeFile(configPath, "- .env\n");
	const policy = await loadProtectionPolicy(configPath, cwd);

	assert.ok(policy);
	assert.equal(policy.rules.length, 2);
});

test("the tool hook allows read and blocks other tools", async () => {
	const { cwd } = await fixture();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const flags = new Map<string, boolean | string | undefined>();
	const pi = {
		registerFlag(name: string, options: { default?: boolean | string }) {
			flags.set(name, options.default);
		},
		getFlag(name: string) {
			return flags.get(name);
		},
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	const ctx = { cwd, hasUI: false } as ExtensionContext;

	protectedPathsExtension(pi);
	const hook = handlers.get("tool_call");
	assert.ok(hook);

	const readResult = await hook({ toolName: "read", input: { path: ".env" } }, ctx);
	const writeResult = await hook({ toolName: "write", input: { path: ".env" } }, ctx);
	const bashResult = await hook({ toolName: "bash", input: { command: "rm .env" } }, ctx);

	assert.equal(readResult, undefined);
	assert.deepEqual(writeResult, { block: true, reason: 'Tool "write" cannot access protected path ".env"' });
	assert.deepEqual(bashResult, { block: true, reason: 'Tool "bash" cannot access protected path ".env"' });
});
