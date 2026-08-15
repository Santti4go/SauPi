interface JsonRecord {
	[key: string]: unknown;
}

export type ConversationKey = "input" | "messages" | "contents";

export interface ConversationItems {
	key: ConversationKey;
	items: unknown[];
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsToolData(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(containsToolData);
	if (!isRecord(value)) return false;
	if (
		value.role === "tool" ||
		value.type === "function_call" ||
		value.type === "function_call_output" ||
		value.type === "tool_call" ||
		value.type === "tool_result" ||
		value.type === "functionResponse"
	) {
		return true;
	}
	return (
		(Array.isArray(value.content) && value.content.some(containsToolData)) ||
		(Array.isArray(value.parts) && value.parts.some(containsToolData))
	);
}

export function isHumanUserItem(value: unknown): boolean {
	return isRecord(value) && value.role === "user" && !containsToolData(value);
}

export function conversationItems(payload: unknown): ConversationItems | undefined {
	if (!isRecord(payload)) return undefined;
	if (Array.isArray(payload.input)) return { key: "input", items: payload.input };
	if (Array.isArray(payload.messages)) return { key: "messages", items: payload.messages };
	if (Array.isArray(payload.contents)) return { key: "contents", items: payload.contents };
	return undefined;
}

function requestItems(payload: unknown): unknown[] | string | undefined {
	if (!isRecord(payload)) return undefined;
	if (typeof payload.input === "string") return payload.input;
	return conversationItems(payload)?.items;
}

export function shouldGatePayload(payload: unknown): boolean {
	const items = requestItems(payload);
	if (typeof items === "string") return items.length > 0;
	if (!items || items.length === 0) return false;
	return isHumanUserItem(items.at(-1));
}

function collectText(value: unknown, output: string[]): void {
	if (typeof value === "string") {
		output.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectText(item, output);
		return;
	}
	if (!isRecord(value)) return;
	if (typeof value.text === "string") output.push(value.text);
	else if (typeof value.content === "string") output.push(value.content);
	else if (Array.isArray(value.content)) collectText(value.content, output);
}

export function extractLatestUserMessage(payload: unknown): string | undefined {
	const items = requestItems(payload);
	if (typeof items === "string") return items;
	if (!items) return undefined;
	const user = [...items].reverse().find(isHumanUserItem);
	if (!isRecord(user)) return undefined;
	const output: string[] = [];
	collectText(user.content ?? user.parts ?? user.text, output);
	return output.length > 0 ? output.join("\n") : JSON.stringify(user, null, 2);
}
