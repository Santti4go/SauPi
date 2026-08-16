import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { loadThemeMapConfig } from "../extensions/theme-map/config.ts";

test("the default map exposes dark and pixel-green", async () => {
	const config = await loadThemeMapConfig(resolve(".pi/theme-map.yaml"));

	assert.equal(config.activeProfile, "dark");
	assert.deepEqual(Object.keys(config.profiles), ["dark", "pixel-green"]);
	assert.equal(config.profiles["pixel-green"]?.theme, "pixel-green");
});

test("pixel-green is a valid loadable Pi theme", async () => {
	const path = resolve("themes/pixel-green.json");
	const document = JSON.parse(await readFile(path, "utf8")) as { name?: string };
	const theme = loadThemeFromPath(path);

	assert.equal(document.name, "pixel-green");
	assert.equal(theme.name, "pixel-green");
	assert.match(theme.fg("accent", "signal"), /signal/);
});

test("orchestrator role themes are valid and loadable", async () => {
	for (const name of ["pixel-cyan", "pixel-magenta"]) {
		const path = resolve(`themes/${name}.json`);
		const document = JSON.parse(await readFile(path, "utf8")) as { name?: string };
		const theme = loadThemeFromPath(path);
		assert.equal(document.name, name);
		assert.equal(theme.name, name);
		assert.match(theme.fg("accent", "signal"), /signal/);
	}
});
