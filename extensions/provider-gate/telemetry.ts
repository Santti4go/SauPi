import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ProviderGateMetrics {
	updatedAt: string;
	model?: {
		provider: string;
		id: string;
	};
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number | null;
	billing: "metered" | "subscription" | "unavailable";
	context?: {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
	};
}

export function collectProviderGateMetrics(ctx: ExtensionContext): ProviderGateMetrics {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		input += entry.message.usage.input;
		output += entry.message.usage.output;
		cacheRead += entry.message.usage.cacheRead;
		cacheWrite += entry.message.usage.cacheWrite;
		cost += entry.message.usage.cost.total;
	}

	const model = ctx.model;
	const subscription = model ? ctx.modelRegistry.isUsingOAuth(model) : false;
	const priced = model ? Object.values(model.cost).some((rate) => rate > 0) : false;
	const contextUsage = ctx.getContextUsage();
	const context = contextUsage ??
		(model && model.contextWindow > 0
			? { tokens: null, contextWindow: model.contextWindow, percent: null }
			: undefined);

	return {
		updatedAt: new Date().toISOString(),
		...(model ? { model: { provider: model.provider, id: model.id } } : {}),
		tokens: {
			input,
			output,
			cacheRead,
			cacheWrite,
			total: input + output + cacheRead + cacheWrite,
		},
		cost: subscription || (!priced && cost === 0) ? null : cost,
		billing: subscription ? "subscription" : priced || cost > 0 ? "metered" : "unavailable",
		...(context ? { context } : {}),
	};
}
