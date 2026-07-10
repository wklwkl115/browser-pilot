/**
 * Explicit summarySchema definitions for distillers.
 *
 * These are the single source of truth for distillers that declare a structured
 * summary schema and are used by the output-schema-conformance contract test.
 *
 * Schema design rules (per execution contract):
 * - Core counts, status, diagnostics: strict type constraints.
 * - Dynamic arrays (samples, rows): loose items schema — shape may vary per entry.
 * - Sensitive fields (PII, tokens, cookies): marked in descriptions only.
 * - No reflection from TypeScript return types.
 *
 * Spike tools:
 *   browser_evidence  — simple summary (source counts, event type distribution)
 *   browser_network   — dynamic table (network entries with status/method/host counts + samples)
 *   browser_hook      — large/complex output (DOM flow data, potentially large)
 */
import { Type } from "typebox";

// ── Shared helpers ─────────────────────────────────────────────────────────────

const UnknownValue = Type.Unknown();
const LooseObject = Type.Object({}, { additionalProperties: true });

// topCounts() returns {key,count}[] — not a plain Record<string,number>.
const CountItemSchema = Type.Object({ key: Type.String(), count: Type.Number() }, { additionalProperties: true });
const CountsArray = Type.Optional(Type.Array(CountItemSchema));

// summaryTable() returns { columns, rows, count } — a column/row table, not raw objects.
const SummaryTableSchema = Type.Object({
	columns: Type.Array(Type.String()),
	rows: Type.Array(Type.Array(UnknownValue)),
	count: Type.Number(),
	truncated: Type.Optional(Type.Number()),
}, { additionalProperties: true });
const OptionalSummaryTable = Type.Optional(SummaryTableSchema);
const SamplesArray = Type.Optional(Type.Array(LooseObject));

// ── browser_evidence summary schema ──────────────────────────────────────────
//
// Simple summary: compact source-level aggregation.
// Sensitive: sources may contain DOM/screenshot handles; redaction is upstream.

const EvidenceSourceSummarySchema = Type.Object({
	ok: Type.Optional(UnknownValue),
	error_code: Type.Optional(UnknownValue),
	events: Type.Optional(Type.Number()),
	// topCounts() returns an array of {key, count} objects, not a plain Record.
	eventTypes: Type.Optional(UnknownValue),
	items: Type.Optional(Type.Number()),
	entries: Type.Optional(Type.Number()),
	count: Type.Optional(UnknownValue),
	total: Type.Optional(UnknownValue),
}, { additionalProperties: true });

export const EvidenceSummarySchema = Type.Object({
	tabId: Type.Optional(UnknownValue),
	collected_at: Type.Optional(UnknownValue),
	event_types: Type.Optional(UnknownValue),
	source_count: Type.Number({ description: "Number of evidence source types captured" }),
	sources: Type.Record(Type.String(), EvidenceSourceSummarySchema),
}, { additionalProperties: true });

// ── browser_network summary schema ────────────────────────────────────────────
//
// Dynamic table: core counts are strict; samples array is open-tail.

export const NetworkSummarySchema = Type.Object({
	entryCount: Type.Optional(Type.Number({ description: "Total entries captured in this recording" })),
	total: Type.Optional(UnknownValue),
	// topCounts() returns {key,count}[] arrays — not plain Record<string,number>.
	statusCounts: CountsArray,
	methodCounts: CountsArray,
	typeCounts: CountsArray,
	hostCounts: CountsArray,
	// networkRows() returns summaryTable SummaryTable objects.
	failed: OptionalSummaryTable,
	samples: OptionalSummaryTable,
	tabId: Type.Optional(UnknownValue),
	sessionId: Type.Optional(UnknownValue),
	active: Type.Optional(UnknownValue),
}, { additionalProperties: true });

// ── browser_hook (DOM-flow) summary schema ────────────────────────────────────
//
// Large/complex: DOM node listener data; can be large for listener-heavy pages.

const DomFlowRowSchema = Type.Object({}, { additionalProperties: true });

export const HookDomFlowSummarySchema = Type.Object({
	nodeCount: Type.Optional(Type.Number({ description: "Number of nodes with listeners" })),
	listenerCount: Type.Optional(Type.Number({ description: "Total listener count across all nodes" })),
	nodes: SamplesArray,
	rows: SamplesArray,
	sinkHints: SamplesArray,
	items: Type.Optional(Type.Array(DomFlowRowSchema)),
	total: Type.Optional(UnknownValue),
	truncated: Type.Optional(UnknownValue),
}, { additionalProperties: true });

export const MemorySummarySchema = Type.Object({
	action: Type.String(),
	ok: Type.Optional(Type.Boolean()),
	scopeKind: Type.Optional(Type.String()),
	scopeKey: Type.Optional(Type.String()),
	query: Type.Optional(Type.String()),
	id: Type.Optional(Type.String()),
	uri: Type.Optional(Type.String()),
	mode: Type.Optional(Type.String()),
	count: Type.Optional(Type.Number()),
	superseded: Type.Optional(Type.Number()),
	supersedeCandidates: Type.Optional(Type.Number()),
	entryCount: Type.Optional(Type.Number()),
	error_code: Type.Optional(Type.String()),
	message: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
	recovery: Type.Optional(LooseObject),
}, { additionalProperties: true });
