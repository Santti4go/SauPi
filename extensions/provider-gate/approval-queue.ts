import { randomUUID } from "node:crypto";

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
	payload: string;
	bytes: number;
	status: ReviewStatus;
}

export interface ReviewHandle {
	review: ProviderReview;
	decision: Promise<ReviewResolution>;
}

type Listener = (review: ProviderReview) => void;

interface PendingDecision {
	resolve(resolution: ReviewResolution): void;
	removeAbortListener(): void;
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

	request(payload: unknown, signal?: AbortSignal): ReviewHandle {
		const serialized = serializePayload(payload);
		const review: ProviderReview = {
			id: randomUUID(),
			sequence: this.nextSequence++,
			createdAt: new Date().toISOString(),
			payload: serialized,
			bytes: Buffer.byteLength(serialized),
			status: "pending",
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
			});
		}

		this.reviews.unshift(review);
		this.pruneHistory();
		this.emit(review);
		return { review, decision };
	}

	approve(id: string, candidate: string): ApprovalAttempt {
		const review = this.reviews.find((item) => item.id === id);
		if (!review || review.status !== "pending" || !this.pending.has(id)) return { accepted: false };

		if (candidate === review.payload) {
			return { accepted: this.finish(id, { decision: "approved", modified: false }) };
		}

		let payload: unknown;
		try {
			payload = JSON.parse(candidate);
		} catch (error) {
			return { accepted: false, error: error instanceof Error ? error.message : "Invalid JSON" };
		}

		review.payload = candidate;
		review.bytes = Buffer.byteLength(candidate);
		return { accepted: this.finish(id, { decision: "approved", modified: true, payload }) };
	}

	reject(id: string): boolean {
		return this.finish(id, { decision: "rejected", modified: false });
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

	private finish(id: string, resolution: ReviewResolution): boolean {
		const pending = this.pending.get(id);
		const review = this.reviews.find((candidate) => candidate.id === id);
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
