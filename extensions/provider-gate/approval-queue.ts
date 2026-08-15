import { randomUUID } from "node:crypto";
import { extractLatestUserMessage } from "./payload-inspection.ts";
import {
	mergeProjectedConversation,
	ProjectionLedger,
	type ProjectionResult,
	type ProjectionSnapshot,
} from "./projection-ledger.ts";

export type ReviewDecision = "approved" | "rejected" | "cancelled";
export type ReviewStatus = "pending" | ReviewDecision;

export interface ReviewResolution {
	decision: ReviewDecision;
	modified: boolean;
	payload?: unknown;
}

export interface ApprovalAttempt {
	accepted: boolean;
	error?: string;
}

export interface ProviderReview {
	id: string;
	sequence: number;
	createdAt: string;
	rawPayload: string;
	sentPayload: string;
	userMessage: string | undefined;
	rawBytes: number;
	sentBytes: number;
	status: ReviewStatus;
	modified: boolean;
	appliedOperations: number;
	requestOnlyChanges: boolean;
	persistenceWarning: string | undefined;
}

export interface ReviewHandle {
	review: ProviderReview;
	decision: Promise<ReviewResolution>;
}

type Listener = (review: ProviderReview) => void;

interface PendingDecision {
	resolve(resolution: ReviewResolution): void;
	removeAbortListener(): void;
	rawPayload: unknown;
	draftPayload: unknown;
	draftLedger: ProjectionLedger;
	projection: ProjectionResult;
}

const HISTORY_LIMIT = 12;

export function serializePayload(payload: unknown): string {
	const ancestors: unknown[] = [];
	const serialized = JSON.stringify(
		payload,
		function (_key, value: unknown) {
			if (typeof value === "bigint") return `${value}n`;
			if (!value || typeof value !== "object") return value;

			while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop();
			if (ancestors.includes(value)) return "[Circular]";
			ancestors.push(value);
			return value;
		},
		2,
	);
	return serialized ?? String(payload);
}

export class ApprovalQueue {
	private readonly reviews: ProviderReview[] = [];
	private readonly pending = new Map<string, PendingDecision>();
	private readonly listeners = new Set<Listener>();
	private nextSequence = 1;

	constructor(
		private readonly ledger: ProjectionLedger,
		private readonly onProjectionCommit?: (snapshot: ProjectionSnapshot) => void,
	) {}

	request(rawPayload: unknown, signal?: AbortSignal): ReviewHandle {
		const draftLedger = this.ledger.clone();
		const projection = draftLedger.project(rawPayload);
		const rawSerialized = serializePayload(rawPayload);
		const sentSerialized = serializePayload(projection.payload);
		const review: ProviderReview = {
			id: randomUUID(),
			sequence: this.nextSequence++,
			createdAt: new Date().toISOString(),
			rawPayload: rawSerialized,
			sentPayload: sentSerialized,
			userMessage: extractLatestUserMessage(projection.payload),
			rawBytes: Buffer.byteLength(rawSerialized),
			sentBytes: Buffer.byteLength(sentSerialized),
			status: "pending",
			modified: projection.changed,
			appliedOperations: projection.appliedOperations,
			requestOnlyChanges: false,
			persistenceWarning: undefined,
		};

		let resolveDecision!: (resolution: ReviewResolution) => void;
		const decision = new Promise<ReviewResolution>((resolve) => {
			resolveDecision = resolve;
		});
		const onAbort = () => this.finish(review.id, { decision: "cancelled", modified: false });
		if (signal?.aborted) {
			review.status = "cancelled";
			resolveDecision({ decision: "cancelled", modified: false });
		} else {
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(review.id, {
				resolve: resolveDecision,
				removeAbortListener: () => signal?.removeEventListener("abort", onAbort),
				rawPayload,
				draftPayload: projection.payload,
				draftLedger,
				projection,
			});
		}

		this.reviews.unshift(review);
		this.pruneHistory();
		this.emit(review);
		return { review, decision };
	}

	approve(id: string, candidate: string): ApprovalAttempt {
		const review = this.review(id);
		const pending = this.pending.get(id);
		if (!review || review.status !== "pending" || !pending) return { accepted: false };

		let payload: unknown;
		try {
			payload = candidate === review.sentPayload ? pending.draftPayload : JSON.parse(candidate);
		} catch (error) {
			return { accepted: false, error: error instanceof Error ? error.message : "Invalid JSON" };
		}

		const attempt = pending.draftLedger.stageCandidate(pending.projection, payload);
		const committed = this.ledger.mergeFrom(pending.draftLedger);
		if (committed) this.onProjectionCommit?.(this.ledger.snapshot());
		this.updateReview(review, pending.rawPayload, payload, {
			appliedOperations: pending.draftLedger.project(pending.rawPayload).appliedOperations,
			requestOnlyChanges: attempt.requestOnlyChanges,
			persistenceWarning: attempt.warning,
		});
		return {
			accepted: this.finish(id, {
				decision: "approved",
				modified: review.modified,
				...(review.modified ? { payload } : {}),
			}),
		};
	}

	dropLastTurn(id: string, candidate: string): ApprovalAttempt {
		const review = this.review(id);
		const pending = this.pending.get(id);
		if (!review || review.status !== "pending" || !pending) return { accepted: false };

		let payload: unknown;
		try {
			payload = candidate === review.sentPayload ? pending.draftPayload : JSON.parse(candidate);
		} catch (error) {
			return { accepted: false, error: error instanceof Error ? error.message : "Invalid JSON" };
		}

		const staged = pending.draftLedger.stageCandidate(pending.projection, payload);
		if (staged.warning) return { accepted: false, error: staged.warning };
		try {
			const beforeDrop = pending.draftLedger.project(pending.rawPayload);
			pending.draftLedger.dropLastCompletedTurn(beforeDrop);
			const afterDrop = pending.draftLedger.project(pending.rawPayload);
			pending.projection = afterDrop;
			pending.draftPayload = mergeProjectedConversation(payload, afterDrop);
			this.updateReview(review, pending.rawPayload, pending.draftPayload, {
				appliedOperations: afterDrop.appliedOperations,
				requestOnlyChanges: staged.requestOnlyChanges,
				persistenceWarning: undefined,
			});
			this.emit(review);
			return { accepted: true };
		} catch (error) {
			return { accepted: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	reject(id: string): boolean {
		return this.finish(id, { decision: "rejected", modified: false });
	}

	approveAll(): number {
		let approved = 0;
		for (const review of this.reviews) {
			if (review.status === "pending" && this.approve(review.id, review.sentPayload).accepted) approved++;
		}
		return approved;
	}

	snapshot(): ProviderReview[] {
		return this.reviews.map((review) => ({ ...review }));
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	close(): void {
		for (const id of [...this.pending.keys()]) this.finish(id, { decision: "cancelled", modified: false });
		this.listeners.clear();
	}

	private review(id: string): ProviderReview | undefined {
		return this.reviews.find((candidate) => candidate.id === id);
	}

	private updateReview(
		review: ProviderReview,
		rawPayload: unknown,
		sentPayload: unknown,
		options: Pick<ProviderReview, "appliedOperations" | "requestOnlyChanges" | "persistenceWarning">,
	): void {
		const rawSerialized = serializePayload(rawPayload);
		const sentSerialized = serializePayload(sentPayload);
		review.rawPayload = rawSerialized;
		review.sentPayload = sentSerialized;
		review.userMessage = extractLatestUserMessage(sentPayload);
		review.rawBytes = Buffer.byteLength(rawSerialized);
		review.sentBytes = Buffer.byteLength(sentSerialized);
		review.modified = rawSerialized !== sentSerialized;
		review.appliedOperations = options.appliedOperations;
		review.requestOnlyChanges = options.requestOnlyChanges;
		review.persistenceWarning = options.persistenceWarning;
	}

	private finish(id: string, resolution: ReviewResolution): boolean {
		const pending = this.pending.get(id);
		const review = this.review(id);
		if (!pending || !review || review.status !== "pending") return false;

		this.pending.delete(id);
		pending.removeAbortListener();
		review.status = resolution.decision;
		pending.resolve(resolution);
		this.emit(review);
		return true;
	}

	private emit(review: ProviderReview): void {
		const copy = { ...review };
		for (const listener of this.listeners) listener(copy);
	}

	private pruneHistory(): void {
		for (let index = this.reviews.length - 1; index >= HISTORY_LIMIT; index--) {
			if (this.reviews[index]?.status !== "pending") this.reviews.splice(index, 1);
		}
	}
}
