export interface CostVector {
	chars: number;
	bytes: number;
	estimatedTokens: number;
}

const UTF8 = new TextEncoder();

/** Deterministic compact JSON used by observation rendering and its benchmark. */
export function renderStableJson(value: unknown): string {
	return JSON.stringify(value, (_key, item) => {
		if (typeof item === "bigint") return item.toString();
		if (item instanceof Error) return { name: item.name, message: item.message };
		return item;
	});
}

export function costOfRenderedJson(rendered: string): CostVector {
	const bytes = UTF8.encode(rendered).byteLength;
	return { chars: rendered.length, bytes, estimatedTokens: Math.ceil(bytes / 4) };
}

export function jsonCost(value: unknown): CostVector {
	return costOfRenderedJson(renderStableJson(value));
}

/**
 * Cost fields contribute to their own serialization length. Iterate to the
 * fixed point so the committed vector exactly describes the returned bytes.
 */
export function renderWithExactCost<T>(value: T, apply: (current: T, cost: CostVector) => T): { value: T; rendered: string; cost: CostVector } {
	let current = value;
	let rendered = renderStableJson(current);
	let cost = costOfRenderedJson(rendered);
	for (let index = 0; index < 32; index += 1) {
		const next = apply(current, cost);
		const nextRendered = renderStableJson(next);
		const nextCost = costOfRenderedJson(nextRendered);
		current = next;
		rendered = nextRendered;
		if (nextCost.chars === cost.chars && nextCost.bytes === cost.bytes && nextCost.estimatedTokens === cost.estimatedTokens) {
			return { value: current, rendered, cost: nextCost };
		}
		cost = nextCost;
	}
	throw new Error("JSON cost vector did not converge");
}
