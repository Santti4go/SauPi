import assert from "node:assert/strict";
import test from "node:test";
import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import instructionStrip, { stripInstructionMarkdown, stripInstructionOptions } from "../extensions/instruction-strip/index.ts";

test("removes heading markers and folds real line endings into spaces", () => {
	assert.equal(stripInstructionMarkdown("# Rol\r\n\r\n## Reglas ##\nUna regla.\rOtra regla.\n"), "Rol Reglas Una regla. Otra regla.");
});

test("keeps literal escapes, inline hashes, links and non-heading markers", () => {
	const input = String.raw`C# y \`##\` https://example.org/#anchor literal \n`;
	assert.equal(stripInstructionMarkdown(input), input);
	assert.equal(stripInstructionMarkdown("##sin espacio\n####### No heading\nTexto ###"), "##sin espacio ####### No heading Texto ###");
});

test("preserves fenced and indented code, including hashes and newlines", () => {
	for (const code of [
		"```python\n# comment\nprint(1)\n```",
		"~~~~text\n## data\n~~~\n~~~~",
		"    # comment\n    print(1)",
		"```\n## unclosed",
	]) {
		assert.equal(stripInstructionMarkdown("## Antes\n" + code), "Antes\n" + code);
	}
});

test("is idempotent", () => {
	const input = "# Rol\n\n## Reglas\n- Uno\n- Dos\n```ts\n// x\n```\nFin";
	const stripped = stripInstructionMarkdown(input);
	assert.equal(stripInstructionMarkdown(stripped), stripped);
});

test("compacts instruction options without changing file objects or other sections", () => {
	const file = { path: "/project/AGENTS.md", content: "## Rol\nHacer cosas." };
	const options: BuildSystemPromptOptions & { sections: Record<string, string> } = {
		cwd: "/project", customPrompt: "# Sistema\nRegla.",
		appendSystemPrompt: "## Worker\nTarea.",
		contextFiles: [file, { path: "/project/context.txt", content: "# Raw\nText" }],
		sections: { other: "# Otro\nTexto" },
	};
	stripInstructionOptions(options);
	assert.equal(options.customPrompt, "Sistema Regla.");
	assert.equal(options.appendSystemPrompt, "Worker Tarea.");
	assert.equal(options.contextFiles?.[0]?.content, "Rol Hacer cosas.");
	assert.equal(file.content, "## Rol\nHacer cosas.");
	assert.equal(options.contextFiles?.[1]?.content, "# Raw\nText");
	assert.equal(options.sections?.other, "# Otro\nTexto");
});

test("registers the structured before_agent_start hook", () => {
	let handler: ((event: { systemPromptOptions: BuildSystemPromptOptions; systemPrompt: string }) => { systemPrompt: string } | undefined) | undefined;
	instructionStrip({
		on: (name: string, callback: typeof handler) => {
			assert.equal(name, "before_agent_start");
			handler = callback;
		},
	} as unknown as ExtensionAPI);
	const options = { cwd: "/project", appendSystemPrompt: "## Agent\nRule" };
	const result = handler!({ systemPromptOptions: options, systemPrompt: "Default\n## Agent\nRule\nTools" });
	assert.equal(options.appendSystemPrompt, "Agent Rule");
	assert.equal(result?.systemPrompt, "Default\nAgent Rule\nTools");
});
