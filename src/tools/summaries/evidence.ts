import { asArray, increment, isRecord, topCounts, type Summary } from "./common";

export function summarizeEvidenceData(data: unknown): Summary {
	if (!isRecord(data)) return { type: typeof data };
	const sources = isRecord(data.sources) ? data.sources : {};
	const sourceSummary = Object.fromEntries(Object.entries(sources).map(([name, value]) => {
		const source = isRecord(value) ? value : {};
		const payload = isRecord(source.data) ? source.data : {};
		const events = asArray(payload.events);
		const eventTypes: Record<string, number> = {};
		for (const event of events) if (isRecord(event)) increment(eventTypes, event.type);
		return [name, {
			ok: source.ok,
			error_code: source.error_code,
			events: events.length || undefined,
			eventTypes: topCounts(eventTypes, 8),
			items: asArray(payload.items).length || undefined,
			entries: asArray(payload.entries).length || undefined,
			total: payload.total ?? payload.total_available,
		}];
	}));
	return {
		tabId: data.tabId,
		collected_at: data.collected_at,
		event_types: data.event_types,
		source_count: Object.keys(sources).length,
		sources: sourceSummary,
	};
}
