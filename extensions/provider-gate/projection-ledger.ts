import { createHash } from "node:crypto";
import { conversationItems, type ConversationKey, isHumanUserItem } from "./payload-inspection.ts";

interface JsonRecord {
	[key: string]: unknown;
}

export interface ProjectionItem {
	identity: string;
	value: unknown;
}

export interface ProjectionResult {
	rawPayload: unknown;
	payload: unknown;
	container: ConversationKey | undefined;
	items: ProjectionItem[];
	appliedOperations: number;
	changed: boolean;
}

export interface ProjectionSnapshot {
	dropped: string[];
	replacements: Array<[string, unknown]>;
}

export interface ProjectionAttempt {
	changedOperations: number;
	requestOnlyChanges: boolean;
	warning?: string;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encoded(value: unknown): string {
	return JSON.stringify(value) ?? String(value);
}

function same(left: unknown, right: unknown): boolean {
	return encoded(left) === encoded(right);
}

function identityBase(value: unknown): string {
	if (isRecord(value)) {
		for (const field of ["id", "call_id", "tool_call_id", "toolCallId"] as const) {
			if (typeof value[field] === "string") return `${field}:${value[field]}`;
		}
	}
	return `sha256:${createHash("sha256").update(encoded(value)).digest("hex")}`;
}

function identities(key: ConversationKey, items: unknown[]): string[] {
	const occurrences = new Map<string, number>();
	return items.map((item) => {
		const base = `${key}:${identityBase(item)}`;
		const occurrence = occurrences.get(base) ?? 0;
		occurrences.set(base, occurrence + 1);
		return `${base}:${occurrence}`;
	});
}

function replaceConversation(payload: unknown, key: ConversationKey, items: unknown[]): unknown {
	return isRecord(payload) ? { ...payload, [key]: items } : payload;
}

function withoutConversation(payload: unknown, key: ConversationKey): unknown {
	if (!isRecord(payload)) return payload;
	const copy = { ...payload };
	delete copy[key];
	return copy;
}

export class ProjectionLedger {
	private readonly dropped = new Set<string>();
	private readonly replacements = new Map<string, unknown>();

	project(rawPayload: unknown): ProjectionResult {
		const conversation = conversationItems(rawPayload);
		if (!conversation) {
			return {
				rawPayload,
				payload: rawPayload,
				container: undefined,
				items: [],
				appliedOperations: 0,
				changed: false,
			};
		}

		const sourceIdentities = identities(conversation.key, conversation.items);
		const projected: ProjectionItem[] = [];
		let appliedOperations = 0;
		for (let index = 0; index < conversation.items.length; index++) {
			const identity = sourceIdentities[index]!;
			if (this.dropped.has(identity)) {
				appliedOperations++;
				continue;
			}
			const replaced = this.replacements.has(identity);
			if (replaced) appliedOperations++;
			projected.push({ identity, value: replaced ? this.replacements.get(identity) : conversation.items[index] });
		}

		const changed = appliedOperations > 0;
		return {
			rawPayload,
			payload: changed ? replaceConversation(rawPayload, conversation.key, projected.map((item) => item.value)) : rawPayload,
			container: conversation.key,
			items: projected,
			appliedOperations,
			changed,
		};
	}

	stageCandidate(projection: ProjectionResult, candidate: unknown): ProjectionAttempt {
		if (!projection.container) {
			return { changedOperations: 0, requestOnlyChanges: !same(projection.payload, candidate) };
		}
		const candidateConversation = conversationItems(candidate);
		if (!candidateConversation || candidateConversation.key !== projection.container) {
			return {
				changedOperations: 0,
				requestOnlyChanges: !same(projection.payload, candidate),
				warning: `Edited payload does not preserve the ${projection.container} array`,
			};
		}
		if (candidateConversation.items.length !== projection.items.length) {
			return {
				changedOperations: 0,
				requestOnlyChanges: true,
				warning: "Changing conversation length manually is request-only; use DROP LAST TURN for persistent removal",
			};
		}

		let changedOperations = 0;
		for (let index = 0; index < projection.items.length; index++) {
			const projected = projection.items[index]!;
			const candidateItem = candidateConversation.items[index];
			if (same(projected.value, candidateItem)) continue;
			this.replacements.set(projected.identity, candidateItem);
			changedOperations++;
		}
		return {
			changedOperations,
			requestOnlyChanges: !same(
				withoutConversation(projection.payload, projection.container),
				withoutConversation(candidate, projection.container),
			),
		};
	}

	dropLastCompletedTurn(projection: ProjectionResult): number {
		if (!projection.container) throw new Error("This payload has no input/messages/contents array");
		const users = projection.items
			.map((item, index) => (isHumanUserItem(item.value) ? index : -1))
			.filter((index) => index >= 0);
		if (users.length < 2) throw new Error("There is no previous complete user/assistant turn to remove");
		const currentUser = users.at(-1)!;
		const previousUser = users.at(-2)!;
		if (currentUser !== projection.items.length - 1) throw new Error("The final payload item is not the current user message");

		let dropped = 0;
		for (let index = previousUser; index < currentUser; index++) {
			const identity = projection.items[index]!.identity;
			if (!this.dropped.has(identity)) dropped++;
			this.dropped.add(identity);
			this.replacements.delete(identity);
		}
		return dropped;
	}

	mergeFrom(source: ProjectionLedger): boolean {
		const before = encoded(this.snapshot());
		for (const identity of source.dropped) this.dropped.add(identity);
		for (const [identity, replacement] of source.replacements) this.replacements.set(identity, replacement);
		return before !== encoded(this.snapshot());
	}

	clone(): ProjectionLedger {
		const clone = new ProjectionLedger();
		clone.restore(this.snapshot());
		return clone;
	}

	snapshot(): ProjectionSnapshot {
		return { dropped: [...this.dropped], replacements: [...this.replacements] };
	}

	restore(snapshot: ProjectionSnapshot): void {
		this.dropped.clear();
		this.replacements.clear();
		for (const identity of snapshot.dropped) this.dropped.add(identity);
		for (const [identity, replacement] of snapshot.replacements) this.replacements.set(identity, replacement);
	}

	get operationCount(): number {
		return this.dropped.size + this.replacements.size;
	}
}

export function mergeProjectedConversation(candidate: unknown, projected: ProjectionResult): unknown {
	if (!projected.container) return candidate;
	return replaceConversation(candidate, projected.container, projected.items.map((item) => item.value));
}
