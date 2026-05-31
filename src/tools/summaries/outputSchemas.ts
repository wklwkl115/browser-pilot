/**
 * Explicit summarySchema definitions for the Phase-2 distiller spike.
 *
 * These are the single source of truth for the structured output shape of each
 * spiked tool's distiller. They serve as the MCP outputSchema (structuredContent)
 * and are used by the output-schema-conformance contract test.
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

const AnyValue = Type.Any();
const LooseObject = Type.Object({}, { additionalProperties: true });

// topCounts() returns {key,count}[] — not a plain Record<string,number>.
const CountItemSchema = Type.Object({ key: Type.String(), count: Type.Number() }, { additionalProperties: true });
const CountsArray = Type.Optional(Type.Array(CountItemSchema));

// summaryTable() returns { columns, rows, count } — a column/row table, not raw objects.
const SummaryTableSchema = Type.Object({
	columns: Type.Array(Type.String()),
	rows: Type.Array(Type.Array(AnyValue)),
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
	ok: Type.Optional(AnyValue),
	error_code: Type.Optional(AnyValue),
	events: Type.Optional(Type.Number()),
	// topCounts() returns an array of {key, count} objects, not a plain Record.
	eventTypes: Type.Optional(AnyValue),
	items: Type.Optional(Type.Number()),
	entries: Type.Optional(Type.Number()),
	count: Type.Optional(AnyValue),
	total: Type.Optional(AnyValue),
}, { additionalProperties: true });

export const EvidenceSummarySchema = Type.Object({
	tabId: Type.Optional(AnyValue),
	collected_at: Type.Optional(AnyValue),
	event_types: Type.Optional(AnyValue),
	source_count: Type.Number({ description: "Number of evidence source types captured" }),
	sources: Type.Record(Type.String(), EvidenceSourceSummarySchema),
}, { additionalProperties: true });

// ── browser_network summary schema ────────────────────────────────────────────
//
// Dynamic table: core counts are strict; samples array is open-tail.

export const NetworkSummarySchema = Type.Object({
	entryCount: Type.Optional(Type.Number({ description: "Total entries captured in this recording" })),
	total: Type.Optional(AnyValue),
	// topCounts() returns {key,count}[] arrays — not plain Record<string,number>.
	statusCounts: CountsArray,
	methodCounts: CountsArray,
	typeCounts: CountsArray,
	hostCounts: CountsArray,
	// networkRows() returns summaryTable SummaryTable objects.
	failed: OptionalSummaryTable,
	samples: OptionalSummaryTable,
	tabId: Type.Optional(AnyValue),
	sessionId: Type.Optional(AnyValue),
	active: Type.Optional(AnyValue),
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
	total: Type.Optional(AnyValue),
	truncated: Type.Optional(AnyValue),
}, { additionalProperties: true });
