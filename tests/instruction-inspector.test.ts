import assert from "node:assert/strict";
import test from "node:test";
import { formatInstructionSnapshot } from "../extensions/instruction-inspector/index.ts";

test("formats instruction file names, advertised skills, and skills read on demand", () => {
	const cwd = "/project";
	const output = formatInstructionSnapshot({
		role: "backend-eng",
		instructionFiles: ["/project/.pi/SYSTEM.md", "/project/.pi/agents/backend-eng.md"],
		contextFiles: ["/project/AGENTS.md", "/project/backend/AGENTS.md"],
		advertisedSkills: [
			{ name: "backend-eng", path: "/project/.pi/skills/backend-eng/SKILL.md" },
			{ name: "docker-tester", path: "/project/.pi/skills/docker-tester/SKILL.md" },
		],
		readSkills: ["/project/.pi/skills/backend-eng/SKILL.md"],
		tools: ["read", "bash"],
		promptChars: 1200,
		promptFingerprint: "abc123",
	}, cwd);

	assert.match(output, /\.pi\/SYSTEM\.md/);
	assert.match(output, /backend\/AGENTS\.md/);
	assert.match(output, /backend-eng: \.pi\/skills\/backend-eng\/SKILL\.md/);
	assert.match(output, /Effective prompt: 1200 chars · abc123/);
});

test("full instruction view uses absolute paths", () => {
	const output = formatInstructionSnapshot({
		role: "session",
		instructionFiles: ["/project/.pi/SYSTEM.md"],
		contextFiles: [],
		advertisedSkills: [],
		readSkills: [],
		tools: [],
	}, "/project", true);
	assert.match(output, /\/project\/\.pi\/SYSTEM\.md/);
});
