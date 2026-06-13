import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDefinedDistillerToolNames, getDistillerDefinition } from "../src/tools/distillerRegistry.ts";
import { ScanSummarySchema } from "../src/tools/summaries/outputSchemas.ts";
import { managedBlockContent, preserveMarkdownTableCells, renderMarkdownTable, replaceManagedBlock } from "./lib/managed-blocks.mjs";
import { walkFiles } from "./lib/repo-introspection.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const DOC = "docs/reference/concept-ownership.md";

const DISTILLER_SCHEMA_LABELS = Object.freeze({
	browser_evidence: "EvidenceSummarySchema",
	browser_hook: "HookDomFlowSummarySchema",
	browser_memory: "MemorySummarySchema",
	browser_network: "NetworkSummarySchema",
});

const FIELD_NOTES = Object.freeze({
	"EvidenceSummarySchema.tabId": "Target tab metadata; keep correlation-safe and optional for aggregate evidence.",
	"EvidenceSummarySchema.collected_at": "Collection timestamp from evidence capture; do not treat as ordering authority across tools.",
	"EvidenceSummarySchema.event_types": "Legacy/open event distribution; prefer structured source summaries when present.",
	"EvidenceSummarySchema.source_count": "Fast diagnostic count of evidence source families included in this capture.",
	"EvidenceSummarySchema.sources": "Per-source compact counts; raw evidence stays in artifacts when large or sensitive.",

	"NetworkSummarySchema.entryCount": "Primary count for captured network entries in the current recorder result.",
	"NetworkSummarySchema.total": "Compatibility total; compare with entryCount before changing summary wording.",
	"NetworkSummarySchema.statusCounts": "Top status buckets from recorder entries; bounded count array, not a record map.",
	"NetworkSummarySchema.methodCounts": "Top HTTP method buckets; keep small and deterministic.",
	"NetworkSummarySchema.typeCounts": "Resource type buckets from native network events.",
	"NetworkSummarySchema.hostCounts": "Host buckets; avoid leaking full sensitive URLs in this summary column.",
	"NetworkSummarySchema.failed": "Compact table of failed requests; full request/response evidence belongs in artifacts.",
	"NetworkSummarySchema.samples": "Representative rows for triage; bounded table shape may evolve with recorder fields.",
	"NetworkSummarySchema.tabId": "Target tab metadata from native/network command context.",
	"NetworkSummarySchema.sessionId": "Recorder session correlation handle for follow-up list/get/body calls.",
	"NetworkSummarySchema.active": "Recorder lifecycle state; keep as diagnostic, not success proof.",

	"HookDomFlowSummarySchema.nodeCount": "Number of nodes with listener/sink data in the summarized hook result.",
	"HookDomFlowSummarySchema.listenerCount": "Total listener count across returned nodes.",
	"HookDomFlowSummarySchema.nodes": "Loose node samples; preserve bounded sample semantics.",
	"HookDomFlowSummarySchema.rows": "Open-tail row samples for table-style hook commands.",
	"HookDomFlowSummarySchema.sinkHints": "Sink hint samples; keep as triage hints, not vulnerability claims.",
	"HookDomFlowSummarySchema.items": "DOM-flow item list for listener-chain style commands.",
	"HookDomFlowSummarySchema.total": "Compatibility total for commands that return paged or table results.",
	"HookDomFlowSummarySchema.truncated": "Signals capped hook output; follow artifact nextActions for full data.",

	"MemorySummarySchema.action": "Memory subcommand/action label; required so all memory outputs stay diagnosable.",
	"MemorySummarySchema.ok": "Boolean success diagnostic for memory operations that expose one.",
	"MemorySummarySchema.scopeKind": "Scope classifier for task/project/origin memory routing.",
	"MemorySummarySchema.scopeKey": "Scope key; do not expose unredacted sensitive local paths.",
	"MemorySummarySchema.query": "Recall query text after normal memory input handling.",
	"MemorySummarySchema.id": "Memory entry id for read/update/record follow-up.",
	"MemorySummarySchema.uri": "Resource-style memory URI when the operation returns one.",
	"MemorySummarySchema.mode": "Read/recall mode selector, not a browser observe mode.",
	"MemorySummarySchema.count": "General result count for list/recall style operations.",
	"MemorySummarySchema.superseded": "Number of entries superseded by a write/validate flow.",
	"MemorySummarySchema.supersedeCandidates": "Candidate count before supersede decision; useful for duplicate diagnostics.",
	"MemorySummarySchema.entryCount": "Stored/returned memory entry count.",
	"MemorySummarySchema.error_code": "Structured failure code; keep aligned with memory recovery contract.",
	"MemorySummarySchema.message": "Short model-facing diagnostic; sensitive evidence remains in artifacts.",
	"MemorySummarySchema.error": "Compatibility error text for older memory paths.",
	"MemorySummarySchema.recovery": "Factual remediation object; keep actionable and non-strategic.",

	"ScanSummarySchema.summaryVersion": "Version of scan summary contract; bump only with explicit migration.",
	"ScanSummarySchema.url": "Observed page URL after navigation/cache handling.",
	"ScanSummarySchema.title": "Observed document title; not a stable identity key.",
	"ScanSummarySchema.readyState": "DOM readiness signal from page-world scan.",
	"ScanSummarySchema.text_only": "Compatibility flag for text-oriented scans.",
	"ScanSummarySchema.contentChars": "Top-level content length for quick budget diagnostics.",
	"ScanSummarySchema.lineCount": "Top-level visible text line count.",
	"ScanSummarySchema.truncated": "Signals capped page text/structure; use artifact_hints for full reads.",
	"ScanSummarySchema.node_count": "Approximate scanned DOM node count from page-world extraction.",
	"ScanSummarySchema.iframe_notes": "Frame visibility/access notes; detailed frame work belongs in browser_frame.",
	"ScanSummarySchema.top_layer": "Top-layer/dialog hint from scan extraction.",
	"ScanSummarySchema.tabs_count": "Bridge tab count mirrored into scan summary for context.",
	"ScanSummarySchema.page": "Nested page metrics; keep consistent with top-level count fields.",
	"ScanSummarySchema.focus": "Primary action/entity and ABML-derived focus block.",
	"ScanSummarySchema.artifact_hints": "Preferred local artifact reads; never require opening raw artifact blindly.",
	"ScanSummarySchema.list_hints": "Table of repeated/list-like structures for agent scanning.",
	"ScanSummarySchema.media_candidates": "Visible media candidates; bounded table, optional on sparse pages.",
	"ScanSummarySchema.rows": "DOM-ordered visible rows; preserve sibling order semantics.",
	"ScanSummarySchema.collections": "Collection completeness and continuation model; rows are not authoritative membership.",
	"ScanSummarySchema.actionables": "Primary actionable table; refs and jsonPaths must stay stable enough for follow-up.",
	"ScanSummarySchema.interactive": "Compact interactive text/ref list for quick triage.",
	"ScanSummarySchema.headings": "Visible heading list for orientation.",
	"ScanSummarySchema.textPreview": "Budgeted text preview; not the full page body.",
	"ScanSummarySchema.summaryOmitted": "Budget omission disclosure; update when renderer hides new classes of data.",

	"DistilledEnvelope.tool": "Tool name from the shared result middleware; first field for cross-tool diagnosis.",
	"DistilledEnvelope.command": "Native or logical subcommand when available.",
	"DistilledEnvelope.browserSessionId": "Browser-session correlation; optional when the tool is not session-scoped.",
	"DistilledEnvelope.detailLevel": "Normalized detail level that selected envelope rendering behavior.",
	"DistilledEnvelope.summary": "Budget-fitted distiller summary; schema depends on the tool/subcommand.",
	"DistilledEnvelope.diagnostics": "High-signal status/warning block assembled by normalizedDiagnostics().",
	"DistilledEnvelope.diagnostics.artifact": "Compact descriptor for saved raw result when diagnostics includes one.",
	"DistilledEnvelope.target": "Normalized browser/tab/frame/url target metadata from summary and options.",
	"DistilledEnvelope.limits": "Budget/truncation/request-count limits visible to the agent.",
	"DistilledEnvelope.privacy": "Redaction/sensitive-evidence disclosure; raw sensitive values stay local.",
	"DistilledEnvelope.entities": "Lifted entity subset for cheap follow-up refs.",
	"DistilledEnvelope.abmlIntegrated": "Boolean disclosure that ABML data was integrated into the observation.",
	"DistilledEnvelope.gist": "L0 page overview lifted so budget squeeze does not hide it.",
	"DistilledEnvelope.outline": "L1 container fold lifted from scan focus when present.",
	"DistilledEnvelope.relations": "Relationship graph summary lifted from scan focus.",
	"DistilledEnvelope.inference": "Declared compatibility field; current response path does not lift it by default.",
	"DistilledEnvelope.diff": "Temporal entity diff lifted from summary/focus when baseline exists.",
	"DistilledEnvelope.causal": "Passive network/event delta lifted from summary when baseline exists.",
	"DistilledEnvelope.templates": "Declared compatibility field; current response path keeps template data in summary/artifact.",
	"DistilledEnvelope.treeDiff": "Template-level living diff lifted from summary/focus.",
	"DistilledEnvelope.snapshotProjection": "Persisted living snapshot projection lifted from summary/focus.",
	"DistilledEnvelope.collections": "Collection completeness and read-only continuation evidence lifted from scan summary.",
	"DistilledEnvelope.error": "Compact structured error block when summary or explicit error indicates failure.",
	"DistilledEnvelope.nextActions": "Factual follow-up hints, capped and deduped; no hidden strategy chaining.",
	"DistilledEnvelope.correlation": "Cross-tool ids copied from summary/operation/snapshot for artifact reads.",
	"DistilledEnvelope.operation": "Tracked operation metadata from toolAdapter/driver registries.",
	"DistilledEnvelope.snapshot": "Observation snapshot metadata from observe/runtime snapshot registries.",
	"DistilledEnvelope.saved": "Local artifact descriptor returned by saveTextArtifact().",
	"DistilledEnvelope.memory": "Optional browser_memory auto-surface block injected after base envelope fitting.",
	"DistilledEnvelope.renderer": "Self-marking salience renderer marker.",
	"DistilledEnvelope.delta": "Session-delta marker for P-frame observe results.",
	"DistilledEnvelope.baselineSnapshotId": "Prior snapshot id used as the delta baseline.",
});

const ENVELOPE_PRODUCERS = Object.freeze({
	tool: "src/tools/resultMiddleware.ts:responseEnvelope() from options.toolName",
	command: "src/tools/resultMiddleware.ts:responseEnvelope() from options.command",
	browserSessionId: "src/tools/resultMiddleware.ts:responseEnvelope() from options.browserSessionId",
	detailLevel: "src/tools/resultMiddleware.ts:normalizeDetailLevel()",
	summary: "src/tools/resultMiddleware.ts + src/tools/distillerRegistry.ts",
	diagnostics: "src/tools/resultMiddleware.ts:normalizedDiagnostics()",
	"diagnostics.artifact": "src/tools/resultMiddleware.ts:compactArtifactDescriptor()",
	target: "src/tools/resultMiddleware.ts:normalizedTarget()",
	limits: "src/tools/resultMiddleware.ts:normalizedLimits()",
	privacy: "src/tools/resultMiddleware.ts:normalizedPrivacy()",
	entities: "src/tools/resultMiddleware.ts:envelopeEntities()",
	abmlIntegrated: "src/tools/resultMiddleware.ts from summary.abmlIntegrated",
	gist: "src/tools/resultMiddleware.ts:envelopeGist()",
	outline: "src/tools/resultMiddleware.ts:envelopeOutline()",
	relations: "src/tools/resultMiddleware.ts:envelopeRelations()",
	inference: "src/tools/resultMiddleware.ts type only / compatibility",
	diff: "src/tools/resultMiddleware.ts:envelopeDiff()",
	causal: "src/tools/resultMiddleware.ts:envelopeCausal()",
	templates: "src/tools/resultMiddleware.ts type only / compatibility",
	treeDiff: "src/tools/resultMiddleware.ts:envelopeTreeDiff()",
	snapshotProjection: "src/tools/resultMiddleware.ts:envelopeSnapshotProjection()",
	collections: "src/tools/resultMiddleware.ts:envelopeCollections()",
	error: "src/tools/resultMiddleware.ts:envelopeError()",
	nextActions: "src/tools/resultMiddleware.ts:normalizedNextActions()",
	correlation: "src/tools/resultMiddleware.ts:responseEnvelope() correlation assembly",
	operation: "src/tools/toolAdapter.ts + src/driver/BrowserOperationRegistry.ts",
	snapshot: "src/tools/observe/scanRunner.ts + src/driver/BrowserObservationSnapshotRegistry.ts",
	saved: "src/tools/resultMiddleware.ts:executeArtifactPlan()",
	memory: "src/tools/memory/autoSurface.ts via appendMemoryAutoSurface()",
	renderer: "src/tools/resultMiddleware.ts:rendererMarker()",
	delta: "src/tools/resultMiddleware.ts from summary.delta",
	baselineSnapshotId: "src/tools/resultMiddleware.ts from summary.baselineSnapshotId",
});

function read(rel) {
	return readFileSync(path.join(root, rel), "utf8");
}

function writeOrCheck(rel, next) {
	const target = path.join(root, rel);
	const current = readFileSync(target, "utf8");
	if (current === next) return;
	if (checkOnly) throw new Error(`${rel} concept ownership blocks are stale; run npm run docs:sync`);
	writeFileSync(target, next, "utf8");
}

function escapeCell(value) {
	return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function schemaType(schema) {
	if (!schema || typeof schema !== "object") return "unknown";
	if (schema.const !== undefined) return `literal:${String(schema.const)}`;
	if (Array.isArray(schema.anyOf)) return schema.anyOf.map(schemaType).join("/");
	if (Array.isArray(schema.oneOf)) return schema.oneOf.map(schemaType).join("/");
	if (schema.type === "array") return `array<${schemaType(schema.items)}>`;
	if (schema.type === "object") return schema.additionalProperties ? "object+" : "object";
	return schema.type || "unknown";
}

function topLevelFields(schema) {
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	return Object.entries(schema.properties || {}).map(([field, prop]) => ({
		field,
		required: required.has(field),
		type: schemaType(prop),
		description: typeof prop?.description === "string" ? prop.description : "",
	}));
}

function sourceSearchFiles() {
	const roots = ["src/tools/summaries", "src/tools/observe"];
	const files = roots.flatMap((rel) => walkFiles(rel, (file) => /\.(?:ts|mjs|js)$/.test(file), root));
	return files.filter((file) => !file.endsWith("outputSchemas.ts") && !file.endsWith("registerBuiltinDistillers.ts"));
}

const producerFiles = sourceSearchFiles();
const producerText = new Map(producerFiles.map((file) => [file, read(file)]));

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function producerCandidates(field) {
	const escaped = escapeRegExp(field);
	const pattern = new RegExp(`(?:\\b${escaped}\\s*:|\\.${escaped}\\b|\\[["']${escaped}["']\\])`);
	const hits = [];
	for (const [file, text] of producerText.entries()) {
		if (!pattern.test(text)) continue;
		const count = (text.match(new RegExp(escaped, "g")) || []).length;
		hits.push({ file, count });
	}
	hits.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
	return hits.length
		? hits.slice(0, 4).map((hit) => `\`${hit.file}\``).join("<br>")
		: "`src/tools/summaries/outputSchemas.ts` (schema only)";
}

function assertNoEmptyNotes(rows, keyIndex, notesIndex, label) {
	if (!checkOnly) return;
	const missing = rows.filter((row) => !String(row[notesIndex] || "").trim()).map((row) => row[keyIndex]);
	if (missing.length) throw new Error(`${label} missing hand notes: ${missing.join(", ")}`);
}

function renderSchemaTable(schemaName, schema, existing) {
	const rows = topLevelFields(schema).map((item) => {
		const key = `${schemaName}.${item.field}`;
		return [
			`\`${key}\``,
			item.required ? "yes" : "no",
			escapeCell(item.type),
			escapeCell(item.description || "-"),
			producerCandidates(item.field),
			escapeCell(FIELD_NOTES[key] || ""),
		];
	});
	const preserved = preserveMarkdownTableCells(existing, rows, { keyColumn: 0, preserveColumns: [5] });
	assertNoEmptyNotes(preserved, 0, 5, schemaName);
	return renderMarkdownTable(["Field", "Required", "Type", "Schema description", "Producer candidates", "Hand notes"], preserved);
}

function parseEnvelopeFields() {
	const text = read("src/tools/resultMiddleware.ts");
	const match = text.match(/export type DistilledEnvelope = \{([\s\S]*?)\n\};/);
	if (!match) throw new Error("DistilledEnvelope type not found in src/tools/resultMiddleware.ts");
	const fields = [];
	for (const line of match[1].split(/\r?\n/)) {
		const item = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\??:/);
		if (item) fields.push(item[1]);
	}
	const ordered = [...fields];
	if (ordered.includes("diagnostics") && !ordered.includes("diagnostics.artifact")) {
		ordered.splice(ordered.indexOf("diagnostics") + 1, 0, "diagnostics.artifact");
	}
	return ordered;
}

function renderEnvelopeTable(existing) {
	const rows = parseEnvelopeFields().map((field) => {
		const key = `DistilledEnvelope.${field}`;
		return [
			`\`${key}\``,
			escapeCell(ENVELOPE_PRODUCERS[field] || "src/tools/resultMiddleware.ts"),
			escapeCell(FIELD_NOTES[key] || ""),
		];
	});
	const preserved = preserveMarkdownTableCells(existing, rows, { keyColumn: 0, preserveColumns: [2] });
	assertNoEmptyNotes(preserved, 0, 2, "DistilledEnvelope");
	return renderMarkdownTable(["Envelope field", "Producer path", "Hand notes"], preserved);
}

function distillerEntries() {
	return getDefinedDistillerToolNames().map((toolName) => {
		const def = getDistillerDefinition(toolName);
		if (!def?.summarySchema) throw new Error(`missing distiller definition for ${toolName}`);
		const schemaName = DISTILLER_SCHEMA_LABELS[toolName];
		if (!schemaName) throw new Error(`missing schema label for ${toolName}`);
		return { toolName, schemaName, schema: def.summarySchema };
	}).sort((a, b) => a.schemaName.localeCompare(b.schemaName));
}

function blockId(schemaName) {
	return `concept-fields-${schemaName.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`;
}

function syncDoc() {
	if (!existsSync(path.join(root, DOC))) throw new Error(`${DOC} missing`);
	let text = read(DOC);
	text = replaceManagedBlock(text, "concept-envelope-fields", renderEnvelopeTable(managedBlockContent(text, "concept-envelope-fields")));
	for (const entry of [...distillerEntries(), { toolName: "browser_observe mode=scan", schemaName: "ScanSummarySchema", schema: ScanSummarySchema }]) {
		const id = blockId(entry.schemaName);
		text = replaceManagedBlock(text, id, renderSchemaTable(entry.schemaName, entry.schema, managedBlockContent(text, id)));
	}
	writeOrCheck(DOC, text);
}

try {
	syncDoc();
	console.log(checkOnly ? "concept ownership doc ok" : "concept ownership doc synced");
} catch (error) {
	console.error(error.message);
	process.exit(1);
}
