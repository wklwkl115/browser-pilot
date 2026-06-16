// Intent ref registry — maps semantic anchor keys to their most recent bp-ref across navigation
// boundaries. Pure in-memory lookup layer; does not change how refs are minted or stored.

export type IntentRefEntry = {
	anchorKey: string;          // "list/products/Product A/listitem/element"
	currentRef: string;         // Current bp-ref:// (most recent observation)
	previousRefs: string[];     // Up to 3 prior bp-ref:// values (older observations/navigations)
	origin: string;             // Top-level origin (e.g., "example.com")
	lastSeenAt: number;         // Timestamp of last observation containing this anchor
	navigationCount: number;    // How many navigations this anchor has survived
};

export type IntentRefRegistry = {
	register(entries: Array<{ anchorKey: string; ref: string; origin: string; seenAt: number }>): void;
	resolve(anchorKey: string, origin: string): IntentRefEntry | undefined;
	resolveByPreviousRef(previousRef: string): IntentRefEntry | undefined;
	snapshot(): IntentRefEntry[];
	prune(maxAge: number): number;
};

const MAX_PREVIOUS_REFS = 3;
const MAX_REGISTRY_SIZE = 2000;

function compositeKey(anchorKey: string, origin: string): string {
	return `${origin}\0${anchorKey}`;
}

export function createIntentRefRegistry(): IntentRefRegistry {
	const byAnchorKey = new Map<string, IntentRefEntry>();
	const byRef = new Map<string, IntentRefEntry>();

	function evictIfOverCapacity(): void {
		if (byAnchorKey.size <= MAX_REGISTRY_SIZE) return;
		// Sort entries by lastSeenAt ascending (oldest first), evict until at capacity.
		const sorted = Array.from(byAnchorKey.entries()).sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
		const toEvict = sorted.slice(0, byAnchorKey.size - MAX_REGISTRY_SIZE);
		for (const [key, entry] of toEvict) {
			byAnchorKey.delete(key);
			// Remove reverse-lookup entries for evicted entry's refs.
			byRef.delete(entry.currentRef);
			for (const prev of entry.previousRefs) {
				if (byRef.get(prev) === entry) byRef.delete(prev);
			}
		}
	}

	function rebuildRefIndex(entry: IntentRefEntry): void {
		byRef.set(entry.currentRef, entry);
		for (const prev of entry.previousRefs) {
			byRef.set(prev, entry);
		}
	}

	return {
		register(entries) {
			for (const { anchorKey, ref, origin, seenAt } of entries) {
				if (!anchorKey || !ref || !origin) continue;
				const key = compositeKey(anchorKey, origin);
				const existing = byAnchorKey.get(key);
				if (existing) {
					if (existing.currentRef === ref) {
						// Same ref observed again — just bump the timestamp.
						existing.lastSeenAt = seenAt;
						continue;
					}
					// Ref changed — push old currentRef into previousRefs, increment navigationCount.
					// Remove old reverse-lookup for the currentRef that's being displaced.
					const prevRefs = [existing.currentRef, ...existing.previousRefs].slice(0, MAX_PREVIOUS_REFS);
					existing.previousRefs = prevRefs;
					existing.currentRef = ref;
					existing.lastSeenAt = seenAt;
					existing.navigationCount += 1;
					rebuildRefIndex(existing);
				} else {
					const entry: IntentRefEntry = {
						anchorKey,
						currentRef: ref,
						previousRefs: [],
						origin,
						lastSeenAt: seenAt,
						navigationCount: 0,
					};
					byAnchorKey.set(key, entry);
					byRef.set(ref, entry);
				}
			}
			evictIfOverCapacity();
		},

		resolve(anchorKey, origin) {
			const entry = byAnchorKey.get(compositeKey(anchorKey, origin));
			return entry ? { ...entry, previousRefs: [...entry.previousRefs] } : undefined;
		},

		resolveByPreviousRef(previousRef) {
			const entry = byRef.get(previousRef);
			if (!entry) return undefined;
			// Only return if the queried ref is NOT the current ref (caller wants to find
			// what an OLD ref resolved to now).
			if (entry.currentRef === previousRef) return undefined;
			return { ...entry, previousRefs: [...entry.previousRefs] };
		},

		snapshot() {
			return Array.from(byAnchorKey.values())
				.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
				.map((entry) => ({ ...entry, previousRefs: [...entry.previousRefs] }));
		},

		prune(maxAge) {
			const cutoff = Date.now() - maxAge;
			let pruned = 0;
			for (const [key, entry] of Array.from(byAnchorKey.entries())) {
				if (entry.lastSeenAt < cutoff) {
					byAnchorKey.delete(key);
					byRef.delete(entry.currentRef);
					for (const prev of entry.previousRefs) {
						if (byRef.get(prev) === entry) byRef.delete(prev);
					}
					pruned++;
				}
			}
			return pruned;
		},
	};
}
