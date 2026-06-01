/**
 * Output schema conformance contract (Phase 2 distiller spike).
 *
 * For each spiked tool, runs the registered distiller with representative
 * fixture data and verifies the output passes the summarySchema.
 *
 * Design rules verified here:
 * - summarySchema is the single source of truth (registered alongside distiller)
 * - Real distill output must pass schema validation (not just type-level)
 * - Core count/status fields must be present when data contains them
 * - Dynamic arrays (samples, rows) are allowed to be loose
 * - Schema coverage: browser_evidence, browser_network, browser_hook, browser_memory
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

// ── Source-level contracts ────────────────────────────────────────────────────

const registrySrc = read("src/tools/distillerRegistry.ts");
assert(registrySrc.includes("DistillerDefinition"), "distillerRegistry.ts must define DistillerDefinition type");
assert(registrySrc.includes("registerDistillerDefinition"), "distillerRegistry.ts must export registerDistillerDefinition");
assert(registrySrc.includes("getDistillerDefinition"), "distillerRegistry.ts must export getDistillerDefinition");
assert(registrySrc.includes("summarySchema"), "DistillerDefinition must include summarySchema field");

const registerBuiltinSrc = read("src/tools/summaries/registerBuiltinDistillers.ts");
assert(registerBuiltinSrc.includes("registerDistillerDefinition"), "registerBuiltinDistillers.ts must use registerDistillerDefinition for spike tools");
assert(registerBuiltinSrc.includes("EvidenceSummarySchema"), "registerBuiltinDistillers.ts must use EvidenceSummarySchema");
assert(registerBuiltinSrc.includes("NetworkSummarySchema"), "registerBuiltinDistillers.ts must use NetworkSummarySchema");
assert(registerBuiltinSrc.includes("HookDomFlowSummarySchema"), "registerBuiltinDistillers.ts must use HookDomFlowSummarySchema");

const outputSchemasSrc = read("src/tools/summaries/outputSchemas.ts");
assert(outputSchemasSrc.includes("EvidenceSummarySchema"), "outputSchemas.ts must define EvidenceSummarySchema");
assert(outputSchemasSrc.includes("NetworkSummarySchema"), "outputSchemas.ts must define NetworkSummarySchema");
assert(outputSchemasSrc.includes("HookDomFlowSummarySchema"), "outputSchemas.ts must define HookDomFlowSummarySchema");
assert(!outputSchemasSrc.includes("ReturnType<"), "outputSchemas.ts must NOT derive schemas from TypeScript return types");

// ── Runtime conformance ───────────────────────────────────────────────────────

const { getDistillerDefinition, getDefinedDistillerToolNames } = await import(
	new URL("../../../src/tools/distillerRegistry.ts", import.meta.url).href
);

// Phase-2 spike must cover exactly these 3 tool names
const definedTools = getDefinedDistillerToolNames();
assert(definedTools.includes("browser_evidence"), "browser_evidence must have a DistillerDefinition with summarySchema");
assert(definedTools.includes("browser_network"), "browser_network must have a DistillerDefinition with summarySchema");
assert(definedTools.includes("browser_hook"), "browser_hook must have a DistillerDefinition with summarySchema");
assert(definedTools.includes("browser_memory"), "browser_memory must have a DistillerDefinition with summarySchema");

// ── browser_evidence fixture ──────────────────────────────────────────────────

const evidenceDef = getDistillerDefinition("browser_evidence");
assert(evidenceDef, "browser_evidence must have a registered DistillerDefinition");

const evidenceFixture = {
	tabId: 42,
	collected_at: "2026-06-01T00:00:00Z",
	sources: {
		dom: { ok: true, data: { events: [{ type: "click" }, { type: "input" }], items: [{ tag: "DIV" }] } },
		screenshot: { ok: true, data: { count: 1 } },
		hook_status: { ok: true, data: { state: "active", session_id: "sess-1", buffer_used: 512 } },
	},
};

const evidenceResult = evidenceDef.distill(evidenceFixture);
assert.equal(typeof evidenceResult, "object", "evidence distill must return an object");
assert(typeof evidenceResult.source_count === "number", "evidence distill must return source_count as number");
assert.equal(Value.Check(evidenceDef.summarySchema, evidenceResult), true,
	`browser_evidence distill output must pass summarySchema. Errors: ${
		JSON.stringify([...Value.Errors(evidenceDef.summarySchema, evidenceResult)].map(e => e.message))
	}`);

// ── browser_network fixture ───────────────────────────────────────────────────

const networkDef = getDistillerDefinition("browser_network");
assert(networkDef, "browser_network must have a registered DistillerDefinition");

const networkFixture = {
	tabId: 7,
	sessionId: "net-sess-1",
	active: false,
	total: 3,
	entries: [
		{ requestId: "r1", url: "https://example.com/api", method: "GET", status: 200, type: "fetch" },
		{ requestId: "r2", url: "https://example.com/api/data", method: "POST", status: 201, type: "xhr" },
		{ requestId: "r3", url: "https://example.com/missing", method: "GET", status: 404, type: "fetch", errorText: "Not Found" },
	],
};

const networkResult = networkDef.distill(networkFixture);
assert.equal(typeof networkResult, "object", "network distill must return an object");
// networkRows() wraps rows in SummaryTable {columns, rows, count} — not a plain array
assert(networkResult.samples !== null && typeof networkResult.samples === "object",
	"network distill must return samples as a SummaryTable object");
assert.equal(Value.Check(networkDef.summarySchema, networkResult), true,
	`browser_network distill output must pass summarySchema. Errors: ${
		JSON.stringify([...Value.Errors(networkDef.summarySchema, networkResult)].map(e => e.message))
	}`);

// ── browser_hook (DOM-flow) fixture ───────────────────────────────────────────

const hookDef = getDistillerDefinition("browser_hook");
assert(hookDef, "browser_hook must have a registered DistillerDefinition");

// DOM flow data — hook.getNodeListeners style payload
const hookFixture = {
	nodes: [
		{ nodeId: 1, selector: "#btn", listeners: [{ type: "click", once: false }] },
		{ nodeId: 2, selector: "form", listeners: [{ type: "submit", once: false }] },
	],
	total: 2,
};

// The hook distiller dispatches based on command — use a recognized DOM-flow command
const hookResult = hookDef.distill(hookFixture, "hook.getNodeListeners");
assert.equal(typeof hookResult, "object", "hook distill must return an object");
assert.equal(Value.Check(hookDef.summarySchema, hookResult), true,
	`browser_hook distill output must pass summarySchema. Errors: ${
		JSON.stringify([...Value.Errors(hookDef.summarySchema, hookResult)].map(e => e.message))
	}`);

// ── Schema structure verification ─────────────────────────────────────────────

// Evidence schema must require source_count (core stable field)
const { EvidenceSummarySchema, NetworkSummarySchema, HookDomFlowSummarySchema, MemorySummarySchema } = await import(
	new URL("../../../src/tools/summaries/outputSchemas.ts", import.meta.url).href
);

// Core fields presence
assert(!Value.Check(EvidenceSummarySchema, {}),
	"EvidenceSummarySchema must require source_count (fails on empty object)");
assert(!Value.Check(EvidenceSummarySchema, { source_count: "not-a-number", sources: {} }),
	"EvidenceSummarySchema must type-check source_count as number");

// Dynamic tail: samples is a SummaryTable { columns, rows, count } — rows are unknown[].
// The key invariant is that unknown extra fields in rows do NOT fail schema.
const networkWithSamplesTable = {
	samples: { columns: ["url", "status", "extraCol"], rows: [["https://example.com", 200, "ignored"]], count: 1 },
};
assert(Value.Check(NetworkSummarySchema, networkWithSamplesTable),
	"NetworkSummarySchema samples SummaryTable must accept rows with extra columns (dynamic tail)");

const memoryDef = getDistillerDefinition("browser_memory");
assert(memoryDef, "browser_memory must have a registered DistillerDefinition");
const memoryResult = memoryDef.distill({ action: "recall", scopeKind: "task", scopeKey: "web-recon", cards: [{ id: "task_1", title: "recon route", triggers: ["recon"], scopeKind: "task", scopeKey: "web-recon", kind: "sop", status: "active", confidence: "verified", matchReason: "exact-task", handles: ["browser-memory://sop/task_1?etag=x"] }] });
assert.equal(Value.Check(memoryDef.summarySchema, memoryResult), true,
	`browser_memory distill output must pass summarySchema. Errors: ${JSON.stringify([...Value.Errors(memoryDef.summarySchema, memoryResult)].map(e => e.message))}`);
assert(Value.Check(MemorySummarySchema, memoryResult), "MemorySummarySchema must accept recall summary output");

// ── REAL emission path conformance (not just bare distiller output) ───────────
//
// structuredContent is NOT the raw distill() output — it is envelope.summary
// after responseEnvelope → fitSummaryBudget → redactSensitiveValue. This section
// validates the actual emitted shape, which is what the MCP spec constrains.

const { distilledJsonResult } = await import(
	new URL("../../../src/tools/resultMiddleware.ts", import.meta.url).href
);

// Happy path: a normal-size evidence result's emitted envelope.summary MUST conform
// to the declared outputSchema (otherwise Phase 3 would never emit structuredContent).
const normalEvidence = {
	tabId: 1,
	collected_at: "2026-06-01",
	sources: {
		dom: { ok: true, data: { events: [{ type: "click" }, { type: "input" }], items: [{ tag: "DIV" }] } },
		screenshot: { ok: true, data: { count: 1 } },
	},
};
const normalResult = await distilledJsonResult(normalEvidence, {
	toolName: "browser_evidence", command: "evidence.collect", maxChars: 8000, fallbackName: "evidence", detailLevel: "summary",
});
const normalEnvelope = JSON.parse(normalResult.content[0].text);
assert(Value.Check(EvidenceSummarySchema, normalEnvelope.summary),
	"normal-size evidence envelope.summary MUST conform to EvidenceSummarySchema (Phase 3 emits structuredContent on happy path)");

// Extreme path: an oversized result forces fitSummaryBudget into the minimal
// fallback shape, which drops required fields. This proves the MCP handler MUST
// guard structuredContent emission with Value.Check (it cannot blindly emit
// envelope.summary). The guard lives in mcp/index.ts.
const hugeSources = {};
for (let i = 0; i < 400; i++) {
	hugeSources[`source_${i}`] = { ok: true, data: { events: Array.from({ length: 50 }, (_, j) => ({ type: `evt_${i}_${j}`, detail: "x".repeat(200) })) } };
}
const hugeResult = await distilledJsonResult({ tabId: 1, collected_at: "2026-06-01", sources: hugeSources }, {
	toolName: "browser_evidence", command: "evidence.collect", maxChars: 8000, fallbackName: "evidence", detailLevel: "summary",
});
const hugeEnvelope = JSON.parse(hugeResult.content[0].text);
const hugeConforms = Value.Check(EvidenceSummarySchema, hugeEnvelope.summary);
if (!hugeConforms) {
	// When the emitted summary does NOT conform, the MCP handler must NOT emit it as
	// structuredContent — verify the guard is present in source.
	const indexSrc = read("mcp/index.ts");
	assert(indexSrc.includes("Value.Check(distillerDef.summarySchema"),
		"mcp/index.ts MUST gate structuredContent emission with Value.Check(distillerDef.summarySchema, summary) — oversized summaries fail the declared outputSchema");
}
assert.equal(typeof normalEnvelope.entities === "undefined" || Array.isArray(normalEnvelope.entities), true, "P8 envelope-level entities projection must be optional but well-shaped");

console.log("output schema conformance ok");
