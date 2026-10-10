import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import instructionInspector from "../extensions/instruction-inspector/index.ts";
import { stripProviderInstructions } from "../extensions/instruction-inspector/compact.ts";

const wrapped = 'Identity\n\n<addendum>\n## Worker\nRules\n</addendum>\n\n<skills>\n<available_skills>\n  <skill>\n    <name>docs</name>\n    <description>Review docs.</description>\n  </skill>\n</available_skills>\n</skills>\n\nDoc impact pendiente:\n- Revisar docs.';
const compact = 'Identity <addendum> Worker Rules </addendum> <skills> <available_skills> <skill> <name>docs</name> <description>Review docs.</description> </skill> </available_skills> </skills> Doc impact pendiente: - Revisar docs.';

test("compacts assembled Responses instructions including XML and late additions", () => {
	const payload = { instructions: wrapped, input: [{ role: "user", content: "## User\nKeep me" }], tools: [{ description: "## Tool\nKeep me" }] };
	const output = stripProviderInstructions(payload) as typeof payload;
	assert.equal(output.instructions, compact);
	assert.equal(output.input[0], payload.input[0]);
	assert.equal(output.tools, payload.tools);
	assert.equal(payload.instructions, wrapped);
	assert.deepEqual(stripProviderInstructions(output), output);
});

test("supports Chat system/developer messages, Anthropic blocks and Gemini parts", () => {
	const user = { role: "user", content: wrapped };
	const assistant = { role: "assistant", content: wrapped };
	const payload = {
		messages: [{ role: "system", content: wrapped }, { role: "developer", content: [{ type: "text", text: wrapped }] }, user, assistant],
		system: [{ type: "text", text: wrapped, cache_control: { type: "ephemeral" } }],
		systemInstruction: { parts: [{ text: wrapped }] },
	};
	const output = stripProviderInstructions(payload) as typeof payload;
	assert.equal(output.messages[0]?.content, compact);
	assert.deepEqual(output.messages[1]?.content, [{ type: "text", text: compact }]);
	assert.equal(output.messages[2], user);
	assert.equal(output.messages[3], assistant);
	assert.equal(output.system[0]?.text, compact);
	assert.deepEqual(output.system[0]?.cache_control, { type: "ephemeral" });
	assert.equal(output.systemInstruction.parts[0]?.text, compact);
});

test("preserves code and literal escaped newlines at the provider boundary", () => {
	const code = '```python\n# comment\nprint(1)\n```';
	const output = stripProviderInstructions({ instructions: '## Role\n' + code + '\nEnd' }) as { instructions: string };
	assert.equal(output.instructions, 'Role\n' + code + '\nEnd');
	assert.deepEqual(stripProviderInstructions({ instructions: String.raw`Literal \n` }), { instructions: String.raw`Literal \n` });
	assert.equal(stripProviderInstructions(null), null);
});

test("provider hook compacts the actual serialized payload", () => {
	let handler: ((event: { payload: unknown }) => unknown) | undefined;
	instructionInspector({ registerCommand: () => {}, on: (name: string, callback: typeof handler) => {
		if (name === "before_provider_request") handler = callback;
	} } as unknown as ExtensionAPI);
	assert.deepEqual(handler!({ payload: { instructions: wrapped } }), { instructions: compact });
});
