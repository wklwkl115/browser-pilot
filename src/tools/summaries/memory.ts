import type { Summary } from "./common.js";
import { isRecord } from "./common.js";

export function summarizeMemoryResult(value: unknown): Summary {
	if (!isRecord(value)) return { action: "unknown", type: typeof value };
	const action = typeof value.action === "string" ? value.action : Array.isArray(value.cards) ? "recall" : value.entry ? "record" : value.mode ? "read" : value.ok === true && value.supersedeCandidates !== undefined ? "validate" : "unknown";
	const summary: Summary = { action };
	if (typeof value.ok === "boolean") summary.ok = value.ok;
	if (typeof value.scopeKind === "string") summary.scopeKind = value.scopeKind;
	if (typeof value.scopeKey === "string") summary.scopeKey = value.scopeKey;
	if (typeof value.query === "string") summary.query = value.query;
	if (typeof value.id === "string") summary.id = value.id;
	if (typeof value.uri === "string") summary.uri = value.uri;
	if (typeof value.mode === "string") summary.mode = value.mode;
	if (Array.isArray(value.cards)) summary.count = value.cards.length;
	if (Array.isArray(value.supersededIds)) summary.superseded = value.supersededIds.length;
	if (Array.isArray(value.supersedeCandidates)) summary.supersedeCandidates = value.supersedeCandidates.length;
	if (isRecord(value.index) && typeof value.index.entryCount === "number") summary.entryCount = value.index.entryCount;
	if (isRecord(value.entry)) {
		if (typeof value.entry.id === "string") summary.id = value.entry.id;
		if (typeof value.entry.scopeKind === "string") summary.scopeKind = value.entry.scopeKind;
		if (typeof value.entry.scopeKey === "string") summary.scopeKey = value.entry.scopeKey;
	}
	if (typeof value.error === "string") summary.error = value.error;
	return summary;
}
