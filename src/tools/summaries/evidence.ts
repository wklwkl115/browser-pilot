import { asArray, increment, isRecord, topCounts, type Summary } from "./common.js";

export function summarizeEvidenceData(data: unknown): Summary {
	if (!isRecord(data)) return { type: typeof data };
	const sources = isRecord(data.sources) ? data.sources : {};
	const sourceSummary = Object.fromEntries(Object.entries(sources).map(([name, value]) => {
		const source = isRecord(value) ? value : {};
		const payload = isRecord(source.data) ? source.data : {};
		const events = asArray(payload.events);
		const eventTypes: Record<string, number> = {};
		for (const event of events) if (isRecord(event)) increment(eventTypes, event.type);
		const summary: Summary = {
			ok: source.ok,
			error_code: source.error_code,
			events: events.length || undefined,
			eventTypes: topCounts(eventTypes, 8),
			items: asArray(payload.items).length || undefined,
			entries: asArray(payload.entries).length || undefined,
			count: payload.count,
			total: payload.total ?? payload.total_available ?? payload.count,
		};
		if (name === "hook_status") {
			const stats = isRecord(payload.stats) ? payload.stats : {};
			summary.state = payload.state;
			summary.session_id = payload.session_id;
			summary.installed_at = payload.installed_at;
			summary.dispatcher_version = payload.dispatcher_version;
			summary.pi_browser_version = payload.pi_browser_version;
			summary.install_epoch = payload.install_epoch;
			summary.buffer_used = payload.buffer_used ?? stats.buffer_used;
			summary.buffer_count = payload.buffer_count ?? stats.buffer_count;
		}
		return [name, summary];
	}));
	return {
		tabId: data.tabId,
		collected_at: data.collected_at,
		event_types: data.event_types,
		source_count: Object.keys(sources).length,
		sources: sourceSummary,
	};
}
