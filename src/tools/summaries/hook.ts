import { artifactHints, asArray, increment, isRecord, summaryTable, topCounts, type Summary } from "./common.js";

// Salient per-event field for the compact sample row — the one detail an agent most wants to see at a
// glance (the storage key, the request url, the console message, …) without opening the artifact.
function eventDetail(event: Record<string, unknown>): unknown {
	const args = Array.isArray(event.args) ? event.args[0] : undefined;
	return event.key ?? event.url ?? event.name ?? event.message ?? args ?? event.selector ?? event.storage ?? undefined;
}

/**
 * Distiller for `browser_hook collect`. Without it the collect result fell through to the generic
 * summarizer, which collapsed the events array to `{type:object,keyCount}` stubs (unreadable even at
 * detailLevel:full) and emitted no `data.events` artifact hint — so the captured events, the headline
 * result, were absent from the headline (blind-eval H3). This surfaces event-type counts + a compact
 * per-event sample inline, and points the agent at the full events via a data-rooted artifact hint.
 */
export function summarizeHookCollectData(data: unknown): Summary {
	if (!isRecord(data)) return { type: typeof data };
	const events = asArray(data.events).filter(isRecord);
	const eventTypes: Record<string, number> = {};
	for (const event of events) increment(eventTypes, event.type);
	const summary: Summary = {
		ok: data.ok,
		error_code: data.error_code,
		sessionId: data.sessionId ?? data.session_id,
		total: data.total ?? data.total_available ?? events.length,
		returned: events.length || undefined,
		dropped: data.dropped ?? data.dropped_count,
		bufferUsed: data.buffer_used ?? (isRecord(data.stats) ? data.stats.buffer_used : undefined),
		eventTypes: topCounts(eventTypes, 12),
		samples: summaryTable(events, [
			{ key: "seq", value: (event) => event.seq },
			{ key: "type", value: (event) => event.type },
			{ key: "detail", value: (event) => eventDetail(event) },
		], 8),
		// data-rooted: the saved artifact is the bridge result `{id,tabId,data,…}` (same class as N1/E1).
		...(events.length ? artifactHints([{ label: "all hook events", jsonPath: "data.events", kind: "hook-event", count: events.length }]) : {}),
	};
	return summary;
}
