/**
 * ABML scan summary/envelope schema contract (P3.4/P3.5).
 *
 * Verifies:
 * - ScanSummarySchema accepts the current scan summary with internal entity projections
 * - EntitySchema validates focus.primary_actions[*].entity and primary/list entity arrays
 * - DistilledEnvelope keeps layered artifact hints + nextActions without changing top-level scan surface
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Value } from "typebox/value";
import { distilledTextResult } from "../../../src/tools/resultMiddleware.ts";
import { summarizeScanData } from "../../../src/tools/summaries/scan.ts";
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

assert(Value.Check(ScanSummarySchema, summary), `scan summary must conform to ScanSummarySchema: ${JSON.stringify([...Value.Errors(ScanSummarySchema, summary)].slice(0, 5).map((e) => `${e.instancePath}: ${e.message}`))}`);
assert(summary.focus.primary_entities.every((entity) => Value.Check(EntitySchema, entity)), "primary_entities must conform to EntitySchema");
assert(summary.focus.list_entities.every((entity) => Value.Check(EntitySchema, entity)), "list_entities must conform to EntitySchema");
assert(summary.focus.primary_actions.every((action) => action.entity == null || Value.Check(EntitySchema, action.entity)), "embedded primary action entities must conform to EntitySchema");

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
		artifactValue: { data: rawScan },
	});
	const envelope = JSON.parse(result.content[0].text);
	assert.equal(envelope.tool, "browser_observe", "scan envelope must preserve tool name");
	assert.equal(envelope.summary.summaryVersion, 2, "scan envelope must preserve summary version");
	assert(Array.isArray(envelope.summary.focus.primary_entities), "scan envelope must keep primary_entities in summary focus");
	assert(Array.isArray(envelope.summary.focus.list_entities), "scan envelope must keep list_entities in summary focus");
	assert(envelope.nextActions.some((item) => String(item).includes("jsonPath=data.actionables") || String(item).includes("click(pi-ref://") || String(item).includes("read(pi-ref://")), "scan envelope nextActions must retain actionables targeted follow-up");
	assert(envelope.nextActions.some((item) => String(item).includes("jsonPath=data.content") || String(item).includes("read_saved_artifact")), "scan envelope nextActions must retain content targeted follow-up");
	assert(Array.isArray(envelope.entities), "scan envelope must surface entity projections at envelope level in P8");
} finally {
	await rm(tmp, { recursive: true, force: true });
}

console.log("abml scan envelope ok");
