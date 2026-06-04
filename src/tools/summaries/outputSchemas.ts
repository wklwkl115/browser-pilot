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
export const EntityStateSchema = Type.Object({
	visible: Type.Boolean(),
	occluded: Type.Boolean(),
	disabled: Type.Boolean(),
	focused: Type.Boolean(),
	checked: Type.Optional(Type.Boolean()),
	expanded: Type.Optional(Type.Boolean()),
	editable: Type.Boolean(),
	inViewport: Type.Boolean(),
}, { additionalProperties: true });
export const EntityLocatorSchema = Type.Object({ by: Type.String() }, { additionalProperties: true });
export const EntityGeometrySchema = Type.Object({
	box: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number(), w: Type.Number(), h: Type.Number() }, { additionalProperties: true })),
	point: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number() }, { additionalProperties: true })),
}, { additionalProperties: true });
// ABML R1 — a typed relation edge on an entity (targetRef is a materialized pi-ref://).
export const EntityRelationSchema = Type.Object({
	type: Type.String(),
	targetRef: Type.String(),
	source: Type.String(),
	confidence: Type.String(),
	evidence: Type.Optional(LooseObject),
}, { additionalProperties: true });
export const EntitySchema = Type.Object({
	ref: Type.String(),
	kind: Type.String(),
	role: Type.String(),
	name: Type.Optional(Type.String()),
	value: Type.Optional(Type.String()),
	state: EntityStateSchema,
	source: Type.String(),
	locators: Type.Optional(Type.Array(EntityLocatorSchema)),
	geometry: Type.Optional(EntityGeometrySchema),
	relations: Type.Optional(Type.Array(EntityRelationSchema)),
	hints: Type.Optional(LooseObject),
}, { additionalProperties: true });

// ABML R1 — envelope-top-level relation disclosure (also lives in summary.focus.relations).
// summary = type→count (+ tableCells); highlights = deterministic capped sample.
export const RelationSummarySchema = Type.Object({
	summary: Type.Record(Type.String(), Type.Number()),
	highlights: Type.Array(Type.Object({
		type: Type.String(),
		sourceRef: Type.String(),
		targetRef: Type.String(),
		source: Type.String(),
	}, { additionalProperties: true })),
}, { additionalProperties: true });

// ABML R2 — envelope-top-level inference disclosure (also lives in summary.focus.inference).
// intents[]: detected generic ARIA patterns (login/search/filter-panel/single-choice/
// multi-choice/expandable/data-grid/navigation/dialog/tabbed-interface/alert-region/
// form-dependency). reason (optional): short signal/confidence rationale. evidence (optional):
// actionable anchor refs for the pattern (e.g. login.evidence.submitRef, data-grid.gridRef).
export const InferenceSummarySchema = Type.Object({
	intents: Type.Array(Type.Object({
		intent: Type.String(),
		confidence: Type.String(),
		reason: Type.Optional(Type.String()),
		evidence: Type.Optional(LooseObject),
	}, { additionalProperties: true })),
}, { additionalProperties: true });

// ABML R3 — optional temporal diff between a caller-provided baseline entity list and
// the current observe/read result.
export const EntityDiffSchema = Type.Object({
	appeared: Type.Array(Type.String()),
	disappeared: Type.Array(Type.String()),
	changed: Type.Array(Type.Object({
		ref: Type.String(),
		kind: Type.String(),
		before: Type.Optional(LooseObject),
		after: Type.Optional(LooseObject),
	}, { additionalProperties: true })),
	focusedRef: Type.Optional(Type.String()),
}, { additionalProperties: true });

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
	error: Type.Optional(Type.String()),
}, { additionalProperties: true });

export const ScanSummarySchema = Type.Object({
	summaryVersion: Type.Number(),
	url: Type.Optional(UnknownValue),
	title: Type.Optional(UnknownValue),
	readyState: Type.Optional(UnknownValue),
	text_only: Type.Optional(UnknownValue),
	contentChars: Type.Number(),
	lineCount: Type.Number(),
	truncated: Type.Optional(UnknownValue),
	node_count: Type.Optional(UnknownValue),
	iframe_notes: Type.Optional(UnknownValue),
	top_layer: Type.Optional(UnknownValue),
	tabs_count: Type.Number(),
	page: Type.Object({
		contentChars: Type.Number(),
		lineCount: Type.Number(),
		node_count: Type.Optional(UnknownValue),
		truncated: Type.Optional(UnknownValue),
		tabs_count: Type.Number(),
	}, { additionalProperties: true }),
	focus: Type.Object({
		top_layer: Type.Optional(UnknownValue),
		primary_actions: Type.Array(Type.Object({
			i: Type.Number(),
			k: Type.String(),
			name: Type.String(),
			jsonPath: Type.String(),
			sel: Type.Optional(Type.String()),
			at: Type.Optional(Type.Array(Type.Number())),
			ok: Type.Optional(Type.Boolean()),
			flags: Type.Optional(Type.Array(Type.String())),
			why: Type.Optional(Type.String()),
			count: Type.Optional(Type.Number()),
			coveredBy: Type.Optional(LooseObject),
			entity: Type.Optional(EntitySchema),
		}, { additionalProperties: true })),
		forms: Type.Array(LooseObject),
		lists: Type.Array(LooseObject),
		headings: Type.Array(Type.String()),
		text_signals: Type.Array(Type.String()),
		primary_entities: Type.Array(EntitySchema),
		list_entities: Type.Array(EntitySchema),
		referenced_entities: Type.Optional(Type.Array(EntitySchema)),
		visual_regions: Type.Optional(Type.Array(EntitySchema)),
		relations: Type.Optional(RelationSummarySchema),
		inference: Type.Optional(InferenceSummarySchema),
		diff: Type.Optional(EntityDiffSchema),
	}, { additionalProperties: true }),
	artifact_hints: Type.Object({
		jsonPaths: Type.Record(Type.String(), Type.String()),
		preferredReads: Type.Array(LooseObject),
	}, { additionalProperties: true }),
	list_hints: SummaryTableSchema,
	actionables: SummaryTableSchema,
	interactive: Type.Array(Type.String()),
	headings: Type.Array(Type.String()),
	textPreview: Type.String(),
	summaryOmitted: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: true });
