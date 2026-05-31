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
 * - Schema coverage: browser_evidence, browser_network, browser_hook
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
const { EvidenceSummarySchema, NetworkSummarySchema, HookDomFlowSummarySchema } = await import(
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

console.log("output schema conformance ok");
