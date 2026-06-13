/**
 * ABML scan summary/envelope schema contract (P3.4/P3.5).
 *
 * Verifies:
 * - ScanSummarySchema accepts the current scan summary with focus entity refs
 * - EntitySchema validates the full envelope entity disclosure
 * - DistilledEnvelope keeps layered artifact hints + nextActions without changing top-level scan surface
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Value } from "typebox/value";
import { distilledTextResult } from "../../../src/tools/resultMiddleware.ts";
import { buildCollectionModels } from "../../../src/abml-core/collections.ts";
import { scanEntitiesForEnvelope, summarizeScanData } from "../../../src/tools/summaries/scan.ts";
import { EntitySchema, ScanSummarySchema } from "../../../src/tools/summaries/outputSchemas.ts";

const rawScan = {
	url: "https://shop.example.test/checkout",
	title: "Checkout",
	readyState: "complete",
	content: "<h1>Checkout</h1>\nStatus: payment required\n<button>Pay now</button>\n<input name=card>\n20 items in cart",
	node_count: 40,
	truncated: true,
	actionables: [
		{ index: 0, tag: "button", role: "button", action: "pay", label: "Pay now", selector: "#pay", point: { x: 180, y: 260 }, rect: { x: 140, y: 240, width: 80, height: 32 }, hitOk: true, clickable: true, disabled: false, priority: 1500 },
		{ index: 1, tag: "input", role: "textbox", action: "card", label: "Card number", selector: "#card", point: { x: 100, y: 200 }, rect: { x: 80, y: 180, width: 220, height: 30 }, hitOk: true, editable: true, disabled: false, priority: 1200 },
	],
	list_hints: [
		{ selector: "main > div.cart > div.item", itemCount: 20, hiddenCount: 17, firstItemPreview: "Item 1 $10", sampleHidden: ["Item 4 $40", "Item 5 $50"] },
	],
};

const summary = summarizeScanData(rawScan, [{ id: 1 }], {
	detailLevel: "summary",
	maxChars: 12_000,
	entityContext: {
		browserSessionId: "session-1",
		tabId: 42,
		url: "https://shop.example.test/checkout",
		observationId: "snapshot-123",
		capturedAt: 1710000000000,
	},
});
const entities = scanEntitiesForEnvelope(rawScan, {
	entityContext: {
		browserSessionId: "session-1",
		tabId: 42,
		url: "https://shop.example.test/checkout",
		observationId: "snapshot-123",
		capturedAt: 1710000000000,
	},
});
summary.collections = buildCollectionModels({
	entities: [],
	scanEvidence: { listHints: rawScan.list_hints },
});

assert(Value.Check(ScanSummarySchema, summary), `scan summary must conform to ScanSummarySchema: ${JSON.stringify([...Value.Errors(ScanSummarySchema, summary)].slice(0, 5).map((e) => `${e.instancePath}: ${e.message}`))}`);
assert.equal(summary.focus.entityShape, "refs-v1", "focus must version the entity-ref projection");
assert(summary.focus.primary_entities.every((ref) => typeof ref === "string" && ref.startsWith("pi-ref://")), "primary_entities must be entity refs");
assert(summary.focus.list_entities.every((ref) => typeof ref === "string" && ref.startsWith("pi-ref://")), "list_entities must be entity refs");
assert(summary.focus.primary_actions.every((action) => action.entity === undefined && (action.entityRef === undefined || typeof action.entityRef === "string")), "primary action rows must expose entityRef, not embedded entity objects");
assert(entities.every((entity) => Value.Check(EntitySchema, entity)), "full envelope entities must conform to EntitySchema");

const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-abml-scan-envelope-"));
try {
	const result = await distilledTextResult(rawScan.content, {
		toolName: "browser_observe",
		command: "scan",
		detailLevel: "summary",
		maxChars: 12_000,
		ctx: { cwd: tmp },
		outputPath: path.join(tmp, ".pi", "browser-artifacts", "scan-envelope.json"),
		fallbackName: "scan-summary.json",
		summary,
		entities,
		artifactValue: { data: rawScan },
	});
	const envelope = JSON.parse(result.content[0].text);
	assert.equal(envelope.tool, "browser_observe", "scan envelope must preserve tool name");
	assert.equal(envelope.summary.summaryVersion, 2, "scan envelope must preserve summary version");
	assert(Array.isArray(envelope.summary.focus.primary_entities), "scan envelope must keep primary_entities in summary focus");
	assert(Array.isArray(envelope.summary.focus.list_entities), "scan envelope must keep list_entities in summary focus");
	assert(envelope.summary.focus.primary_entities.every((ref) => typeof ref === "string"), "scan envelope focus primary_entities must remain refs");
	assert(envelope.summary.focus.primary_actions.every((action) => action.entity === undefined && (action.entityRef === undefined || typeof action.entityRef === "string")), "scan envelope primary_actions must not embed entity objects");
	assert(envelope.nextActions.some((item) => String(item).includes("jsonPath=data.actionables") || String(item).includes("click(pi-ref://") || String(item).includes("read(pi-ref://")), "scan envelope nextActions must retain actionables targeted follow-up");
	assert(envelope.nextActions.some((item) => String(item).includes("jsonPath=data.content") || String(item).includes("read_saved_artifact")), "scan envelope nextActions must retain content targeted follow-up");
	assert(Array.isArray(envelope.entities), "scan envelope must surface entity projections at envelope level in P8");
	assert(envelope.entities.every((entity) => typeof entity === "object" && typeof entity.ref === "string" && typeof entity.kind === "string"), "envelope.entities must still carry compact full entity objects");
	assert.equal(envelope.collections?.[0]?.completeness, "lazy", "scan envelope must lift collection completeness");
	assert.equal(envelope.collections?.[0]?.continuation?.kind, "virtual-window", "scan envelope must carry semantic continuation evidence");
	assert(!JSON.stringify(envelope.nextActions || []).toLowerCase().includes("scroll"), "scan envelope nextActions must not prescribe scroll");
	// F2: the scan summarizer duplicated `headings`/`top_layer` into both summary top-level AND focus by
	// SHARED reference, so redactSensitiveValue collapsed the second occurrence to a "[Circular]" string
	// — unreadable noise. They are now distinct copies; assert none renders as the placeholder.
	// Entity objects now live in envelope.entities/artifacts; focus carries refs only.
	for (const value of [envelope.summary.headings, envelope.summary.top_layer, envelope.summary.focus?.headings, envelope.summary.focus?.top_layer]) {
		assert(value !== "[Circular]", "scan summary headings/top_layer must be real values, never a [Circular] placeholder");
	}
} finally {
	await rm(tmp, { recursive: true, force: true });
}

console.log("abml scan envelope ok");
