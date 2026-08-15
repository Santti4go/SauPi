import assert from "node:assert/strict";
import test from "node:test";
import { renderSineFrame } from "../extensions/pi-anim/index.ts";

const identity = {
	signal: (text: string) => text,
	ghost: (text: string) => text,
	glitch: (text: string) => text,
};

test("renders a bounded moving sine wave", () => {
	const first = renderSineFrame(40, 0, identity);
	const second = renderSineFrame(40, 1, identity);

	assert.equal(first.length, 5);
	assert.ok(first.every((line) => line.length === 40));
	assert.notDeepEqual(first, second);
});

test("does not render in unusably narrow terminals", () => {
	assert.deepEqual(renderSineFrame(7, 0, identity), []);
});
