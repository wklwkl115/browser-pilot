/**
 * MCP unified structured-envelope schema contract (Residual A / Phase 2).
 *
 * StructuredEnvelopeSchema describes the WHOLE distilled envelope. It is distinct
 * from the per-tool summarySchema (which validates structuredContent = envelope.summary).
 * Key invariant proven here: the envelope schema holds even when the per-tool
 * summary schema does NOT (because envelope.summary is intentionally loose) — that
 * separation is what lets mcp/index.ts guard structuredContent independently.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

// ── Source-level contracts ────────────────────────────────────────────────────

const schemaSrc = read("mcp/structuredEnvelopeSchema.ts");
assert(schemaSrc.includes("StructuredEnvelopeSchema"), "must export StructuredEnvelopeSchema");
assert(schemaSrc.includes("SectionSchema"), "must export SectionSchema");
assert(schemaSrc.includes("sections:"), "envelope schema must include a sections field");

const middlewareSrc = read("src/tools/resultMiddleware.ts");
assert(middlewareSrc.includes("sections?:"), "DistilledEnvelope must declare an optional sections field");
assert(middlewareSrc.includes("entities?:") && middlewareSrc.includes("error?:"), "DistilledEnvelope must declare optional entities/error fields for P8");

// ── Runtime conformance against the REAL emission path ────────────────────────

const { StructuredEnvelopeSchema, SectionSchema } = await import(
	new URL("../../../mcp/structuredEnvelopeSchema.ts", import.meta.url).href
);
const { distilledJsonResult } = await import(
	new URL("../../../src/tools/resultMiddleware.ts", import.meta.url).href
);
const { EvidenceSummarySchema } = await import(
	new URL("../../../src/tools/summaries/outputSchemas.ts", import.meta.url).href
);

async function envelopeFor(value, toolName, command) {
	const r = await distilledJsonResult(value, { toolName, command, maxChars: 8000, fallbackName: toolName, detailLevel: "summary" });
	return JSON.parse(r.content[0].text);
}

// 1. Normal-size envelopes for all 3 spike tools conform.
const evidence = await envelopeFor(
	{ tabId: 1, collected_at: "2026-06-01", sources: { dom: { ok: true, data: { events: [{ type: "click" }] } } } },
	"browser_evidence", "evidence.collect",
);
assert(Value.Check(StructuredEnvelopeSchema, evidence), `evidence envelope must conform: ${JSON.stringify([...Value.Errors(StructuredEnvelopeSchema, evidence)].slice(0, 3).map((e) => `${e.instancePath}: ${e.message}`))}`);
assert.equal(evidence.tool, "browser_evidence", "envelope.tool must be set");
assert(typeof evidence.detailLevel === "string", "envelope.detailLevel must be set");

const network = await envelopeFor(
	{ tabId: 7, total: 2, entries: [{ requestId: "r1", url: "https://ex.com/a", method: "GET", status: 200 }] },
	"browser_network", "network.list",
);
assert(Value.Check(StructuredEnvelopeSchema, network), "network envelope must conform");

const hook = await envelopeFor(
	{ nodes: [{ nodeId: 1, listeners: [{ type: "click" }] }], total: 1 },
	"browser_hook", "hook.getNodeListeners",
);
assert(Value.Check(StructuredEnvelopeSchema, hook), "hook envelope must conform");

// 2. Separation invariant: oversized envelope conforms to the (loose) envelope
//    schema even though its budget-fitted summary fails the strict per-tool schema.
const hugeSources = {};
for (let i = 0; i < 400; i++) hugeSources[`s_${i}`] = { ok: true, data: { events: Array.from({ length: 50 }, (_, j) => ({ type: `e_${i}_${j}`, detail: "x".repeat(200) })) } };
const huge = await envelopeFor({ tabId: 1, collected_at: "2026-06-01", sources: hugeSources }, "browser_evidence", "evidence.collect");
assert(Value.Check(StructuredEnvelopeSchema, huge), "oversized envelope must still conform to the loose envelope schema");
assert(!Value.Check(EvidenceSummarySchema, huge.summary), "oversized summary must FAIL the strict per-tool schema (proves envelope schema != summary schema)");

// 3. Required-field enforcement.
assert(!Value.Check(StructuredEnvelopeSchema, { detailLevel: "summary", summary: {} }), "envelope schema must require `tool`");
assert(!Value.Check(StructuredEnvelopeSchema, { tool: "x", summary: {} }), "envelope schema must require `detailLevel`");

// 4. SectionSchema shape.
assert(Value.Check(SectionSchema, { name: "failed entries", kind: "network-entry", handle: "browser-result://abc", count: 3 }), "valid section must pass SectionSchema");
assert(Value.Check(SectionSchema, { name: "failed entries", kind: "network-entry", handle: "pi-ref://data-slice/abc", count: 3 }), "pi-ref data-slice section handles must also pass SectionSchema");
assert(!Value.Check(SectionSchema, { name: "x", kind: "not-a-kind" }), "SectionSchema must reject unknown kind");
const withSections = { ...network, sections: [{ name: "entries", kind: "network-entry", handle: "pi-ref://data-slice/x", count: 2 }], entities: [{ ref: "pi-ref://control/x", kind: "control", role: "button" }], error: { code: "REF_STALE", category: "ref", message: "stale" } };
assert(Value.Check(StructuredEnvelopeSchema, withSections), "envelope with sections/entities/error must conform");

console.log("mcp structured envelope ok");
