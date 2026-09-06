/**
 * Structural JSON safety without content filtering: break cycles, bound depth, and turn Errors
 * into plain records so any value can cross a JSON boundary (WebSocket, storage, tool result).
 * Content is passed through verbatim; Browser Pilot does not redact page or network data.
 */

export type SafeCloneOptions = { maxDepth?: number };

const DEFAULT_MAX_DEPTH = 24;

function cloneInner(value: unknown, depth: number, maxDepth: number, seen: WeakSet<object>): unknown {
	if (value === null || typeof value !== "object") {
		if (typeof value === "bigint") return value.toString();
		if (typeof value === "function" || typeof value === "symbol") return undefined;
		return value;
	}
	if (value instanceof Error) return { name: value.name, message: value.message };
	if (depth > maxDepth) return "[depth limit]";
	if (seen.has(value)) return "[Circular]";
	seen.add(value);
	const out = Array.isArray(value)
		? value.map((item) => cloneInner(item, depth + 1, maxDepth, seen))
		: Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([key, item]) => [
					key,
					cloneInner(item, depth + 1, maxDepth, seen),
				]),
			);
	seen.delete(value);
	return out;
}

export function safeJsonClone<T = unknown>(value: T, options: SafeCloneOptions = {}): T {
	return cloneInner(value, 0, options.maxDepth ?? DEFAULT_MAX_DEPTH, new WeakSet<object>()) as T;
}
