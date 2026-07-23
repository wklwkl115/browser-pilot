import assert from "node:assert/strict";
import test from "node:test";
import {
	PAGE_WORLD_SCAN_SCHEMA,
} from "../../src/kernels/abml/pageWorldScan.ts";
import { validatePageWorldScanBundle } from "../../src/validation/pageContracts.ts";
import { pageWorldScanBundle } from "../helpers/pageWorldScan.ts";

test("page-world scan bundle validates empty and fully populated v1 captures", () => {
	const empty = pageWorldScanBundle({ content: { text: "" }, stats: { nodeCount: 0, outputChars: 0 } });
	assert.deepEqual(validatePageWorldScanBundle(empty), { ok: true, value: empty });

	const full = pageWorldScanBundle({
		page: { language: "en-US" },
		content: { headings: ["Checkout"] },
		structure: {
			actionables: [
				{ index: 0, selector: "#pay", tag: "button", role: "button", label: "Pay now", text: "Pay now", clickable: true, editable: false, disabled: false, focused: false, handlers: [], rect: { x: 1, y: 2, width: 90, height: 30 }, documentRect: { x: 1, y: 202, width: 90, height: 30 }, point: { x: 46, y: 17 }, hitOk: true, hitTarget: null, priority: 100 },
				{ selector: "#dialog", role: "dialog", name: "Checkout", hidden: true, referenceOnly: true },
				{ sourceSelector: "#open", sourceRole: "button", sourceName: "Open", controlsSelectors: ["#dialog"], relationOnly: true },
			],
			listHints: [{ selector: "#orders > li", itemCount: 10, hiddenCount: 7, firstItemPreview: "Order 1", sampleHidden: ["Order 4"] }],
			canvasRegions: [{ index: 0, tag: "canvas", role: "img", action: "Chart", label: "Chart", selector: "#chart", point: { x: 10, y: 10 }, rect: { x: 0, y: 0, width: 20, height: 20 }, hitOk: true, clickable: false }],
		},
		signals: {
			fingerprint: { changeSeq: 9, url: "https://example.test/", title: "Example", readyState: "complete", visibleCount: 1, interactiveCount: 1, capturedAt: 42 },
		},
		stats: { nodeCount: 40, outputChars: 400, truncated: true },
	});
	assert.deepEqual(validatePageWorldScanBundle(full), { ok: true, value: full });
});

test("page-world scan bundle rejects unknown schemas and malformed fields", () => {
	const valid = pageWorldScanBundle();
	const unknownSchema = { ...valid, schema: "browser-page-scan/v2" };
	const malformed = { ...valid, stats: { ...valid.stats, nodeCount: "one" } };
	const unknownNested = { ...valid, structure: { ...valid.structure, actionables: [{ selector: "#pay", unknownField: true }] } };
	const staleUnusedFields = { ...valid, structure: { ...valid.structure, rows: [] } };
	const staleGrowthProbe = { ...valid, signals: { ...valid.signals, growthProbe: { supported: true, candidateCount: 1, elapsedMs: 10 } } };
	const internalAnnotation = { ...valid, structure: { ...valid.structure, actionables: [{ selector: "#pay", entityRefs: { domAction: "bp-ref://control/pay" } }] } };
	const missingLocator = { ...valid, structure: { ...valid.structure, actionables: [{}] } };

	for (const value of [unknownSchema, malformed, unknownNested, staleUnusedFields, staleGrowthProbe, internalAnnotation, missingLocator]) {
		const result = validatePageWorldScanBundle(value);
		assert.equal(result.ok, false, JSON.stringify(value));
		if (!result.ok) assert.equal(result.issues.length > 0, true);
	}
	const schemaIssue = validatePageWorldScanBundle(unknownSchema);
	assert.equal(schemaIssue.ok, false);
	if (!schemaIssue.ok) assert.equal(schemaIssue.issues.includes(`/schema: expected ${PAGE_WORLD_SCAN_SCHEMA}`), true);
});
