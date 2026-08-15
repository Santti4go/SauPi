import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import themeMapExtension from "../extensions/theme-map/index.ts";
import { mkdtemp } from "node:fs/promises";
import {
	explicitExtensionNames,
	parseThemeMapConfig,
	selectInitialProfile,
} from "../extensions/theme-map/config.ts";

test("parses short and expanded theme profiles", () => {
	const config = parseThemeMapConfig({
		activeProfile: "signal",
		fallbackTheme: "dark",
		profiles: {
			signal: { theme: "cyberpunk", title: "π - signal" },
			safety: "gruvbox",
		},
	});

	assert.deepEqual(config.profiles.signal, { theme: "cyberpunk", title: "π - signal" });
	assert.deepEqual(config.profiles.safety, { theme: "gruvbox" });
});

test("rejects a selected profile that does not exist", () => {
	assert.throws(
		() => parseThemeMapConfig({ activeProfile: "missing", profiles: { signal: "dark" } }),
		/unknown profile/,
	);
});

test("extracts explicit extension names across supported CLI forms", () => {
	assert.deepEqual(
		explicitExtensionNames(["pi", "-e", "extensions/agent-team.ts", "--extension=C:\\pi\\pure-focus.ts"]),
		["agent-team", "pure-focus"],
	);
});

test("selects profiles by CLI, config, explicit extension, then default", () => {
	const base = parseThemeMapConfig({ defaultProfile: "focus", profiles: { focus: "dark", signal: "light" } });
	assert.equal(selectInitialProfile(base, "signal", ["pi"]), "signal");
	assert.equal(selectInitialProfile({ ...base, activeProfile: "focus" }, undefined, ["pi", "-e", "signal.ts"]), "focus");
	assert.equal(selectInitialProfile(base, undefined, ["pi", "-e", "signal.ts"]), "signal");
	assert.equal(selectInitialProfile(base, undefined, ["pi"]), "focus");
});

test("applies a Theme instance without persisting a theme name", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-theme-map-"));
	await mkdir(join(cwd, ".pi"));
	await writeFile(join(cwd, ".pi", "theme-map.yaml"), "activeProfile: signal\nprofiles:\n  signal: dark\n");

	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const flags = new Map<string, boolean | string | undefined>();
	const pi = {
		registerFlag(name: string, options: { default?: boolean | string }) {
			flags.set(name, options.default);
		},
		getFlag(name: string) {
			return flags.get(name);
		},
		registerCommand() {},
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	const originalTheme = { name: "original" };
	const darkTheme = { name: "dark" };
	const applied: unknown[] = [];
	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			theme: originalTheme,
			getAllThemes: () => [{ name: "dark", path: undefined }],
			getTheme: (name: string) => (name === "dark" ? darkTheme : undefined),
			setTheme: (theme: unknown) => {
				applied.push(theme);
				return { success: true };
			},
			setStatus() {},
			setTitle() {},
			notify() {},
		},
	} as unknown as ExtensionContext;

	themeMapExtension(pi);
	const sessionStart = handlers.get("session_start");
	assert.ok(sessionStart);
	await sessionStart({}, ctx);

	assert.deepEqual(applied, [darkTheme]);
	assert.notEqual(applied[0], "dark");
});

test("stays inactive without a project config", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-theme-map-missing-"));
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const flags = new Map<string, boolean | string | undefined>();
	const notifications: string[] = [];
	const pi = {
		registerFlag(name: string, options: { default?: boolean | string }) {
			flags.set(name, options.default);
		},
		getFlag(name: string) {
			return flags.get(name);
		},
		registerCommand() {},
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			theme: { name: "dark" },
			getAllThemes: () => [{ name: "dark", path: undefined }],
			notify: (text: string) => notifications.push(text),
		},
	} as unknown as ExtensionContext;

	themeMapExtension(pi);
	const sessionStart = handlers.get("session_start");
	assert.ok(sessionStart);
	await sessionStart({}, ctx);

	assert.deepEqual(notifications, []);
});
