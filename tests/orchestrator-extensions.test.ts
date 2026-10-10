import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { stringify } from "yaml";
import { loadOrchestratorConfig } from "../extensions/orchestrator/config.ts";
import { ephemeralAgentArgs } from "../extensions/orchestrator/ephemeral-runner.ts";

async function fixture(t: TestContext, defaults: unknown, agents: unknown[]) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-orchestrator-extensions-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await mkdir(join(cwd, ".pi"));
	await writeFile(join(cwd, ".pi", "agent.md"), "# Agent\n");
	const path = join(cwd, ".pi", "orchestrator.yaml");
	await writeFile(path, stringify({ version: 1, defaults, agents }));
	return { cwd, path };
}

function agent(extensions?: unknown, name = "developer") {
	return { name, description: "Builds features", prompt: ".pi/agent.md", ...(extensions === undefined ? {} : { extensions }) };
}

const cases: Array<{ name: string; selection?: unknown; expected: string[] }> = [
	{ name: "omission inherits defaults", expected: ["common.ts"] },
	{ name: "plain scalar replaces defaults", selection: "own.ts", expected: ["own.ts"] },
	{ name: "plain list replaces defaults", selection: ["own.ts", "other.ts"], expected: ["own.ts", "other.ts"] },
	{ name: "empty list clears defaults", selection: [], expected: [] },
	{ name: "plus scalar appends to defaults", selection: "+voice.ts", expected: ["common.ts", "voice.ts"] },
	{ name: "plus list appends in order", selection: ["+voice.ts", "+audit.ts"], expected: ["common.ts", "voice.ts", "audit.ts"] },
	{ name: "reset then append matches requested YAML", selection: [[], "+voice.ts", "+audit.ts"], expected: ["voice.ts", "audit.ts"] },
	{ name: "reset alone clears defaults", selection: [[]], expected: [] },
	{ name: "reset discards earlier appends", selection: ["+voice.ts", [], "+audit.ts"], expected: ["audit.ts"] },
	{ name: "trailing reset clears all configured paths", selection: ["+voice.ts", []], expected: [] },
	{ name: "multiple resets evaluate left to right", selection: [[], "+voice.ts", [], "+audit.ts"], expected: ["audit.ts"] },
	{ name: "normalized paths deduplicate", selection: ["+./common.ts", "+dir/../voice.ts", "+voice.ts"], expected: ["common.ts", "voice.ts"] },
	{ name: "whitespace is trimmed", selection: [" + voice.ts "], expected: ["common.ts", "voice.ts"] },
	{ name: "plain first path opts into replacement", selection: ["own.ts", "+voice.ts"], expected: ["own.ts", "voice.ts"] },
	{ name: "plain later path appends in additive mode", selection: ["+voice.ts", "audit.ts"], expected: ["common.ts", "voice.ts", "audit.ts"] },
];

for (const scenario of cases) {
	test(`extension selection: ${scenario.name}`, async (t) => {
		const { cwd, path } = await fixture(t, { extensions: ["common.ts"] }, [agent(scenario.selection)]);
		const config = await loadOrchestratorConfig(path, cwd);
		assert.deepEqual(config.agents[0]?.extensionPaths, scenario.expected.map((p) => join(cwd, p)));
	});
}

test("additive defaults work without an inherited list", async (t) => {
	const { cwd, path } = await fixture(t, { extensions: ["+common.ts", [], "+voice.ts"] }, [agent()]);
	const config = await loadOrchestratorConfig(path, cwd);
	assert.deepEqual(config.agents[0]?.extensionPaths, [join(cwd, "voice.ts")]);
});

test("omitted defaults and agent selection preserve undefined", async (t) => {
	const { cwd, path } = await fixture(t, {}, [agent()]);
	assert.equal((await loadOrchestratorConfig(path, cwd)).agents[0]?.extensionPaths, undefined);
});

test("append works without defaults and resolves absolute paths", async (t) => {
	const absolute = join(tmpdir(), "pi-voice", "index.ts");
	const { cwd, path } = await fixture(t, {}, [agent([`+${absolute}`])]);
	assert.deepEqual((await loadOrchestratorConfig(path, cwd)).agents[0]?.extensionPaths, [absolute]);
});

test("one agent's reset does not mutate defaults or another agent", async (t) => {
	const { cwd, path } = await fixture(t, { extensions: ["common.ts"] }, [
		agent([[], "+voice.ts"], "reset"), agent(undefined, "inherit"), agent(["+audit.ts"], "append"),
	]);
	const config = await loadOrchestratorConfig(path, cwd);
	assert.deepEqual(config.agents.map((a) => a.extensionPaths), [
		[join(cwd, "voice.ts")], [join(cwd, "common.ts")], [join(cwd, "common.ts"), join(cwd, "audit.ts")],
	]);
});

for (const invalid of [null, true, 42, {}, "", " ", "+", "+  ", [null], [42], [true], [["voice.ts"]]]) {
	for (const scope of ["defaults", "agent"] as const) {
		test(`rejects invalid ${scope} extensions: ${JSON.stringify(invalid)}`, async (t) => {
			const { cwd, path } = await fixture(t,
				scope === "defaults" ? { extensions: invalid } : {},
				[agent(scope === "agent" ? invalid : undefined)],
			);
			await assert.rejects(loadOrchestratorConfig(path, cwd), scope === "defaults" ? /defaults\.extensions/ : /agents\[0\]\.extensions/);
		});
	}
}

for (const selection of [["+voice.ts"], [[], "+voice.ts"], []]) {
	test(`ephemeral CLI forwards resolved extensions and preserves mandatory guards: ${JSON.stringify(selection)}`, async (t) => {
		const { cwd, path } = await fixture(t, { extensions: ["common.ts"] }, [agent(selection)]);
		const definition = (await loadOrchestratorConfig(path, cwd)).agents[0]!;
		const guard = {
			role: definition.name, projectRoot: cwd, workspaceRoot: cwd,
			policyConfig: join(cwd, ".pi", "orchestrator-policy.yaml"),
			globalProtectedConfig: join(cwd, ".pi", "protected-paths.yaml"),
			extensionPath: join(cwd, "role-guard.ts"),
			instructionInspectorPath: join(cwd, "instruction-inspector.ts"),
		};
		const args = ephemeralAgentArgs(definition, "smoke", guard);
		assert.ok(args.includes("--no-extensions"));
		assert.deepEqual(args.flatMap((arg, i) => arg === "--extension" ? [args[i + 1]] : []), [
			guard.extensionPath, guard.instructionInspectorPath,
			fileURLToPath(new URL("../extensions/instruction-strip/index.ts", import.meta.url)),
			...definition.extensionPaths!,
		]);
		assert.equal(args.at(-1), "Task: smoke");
	});
}
