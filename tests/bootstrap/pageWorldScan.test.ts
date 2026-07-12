import assert from "node:assert/strict";
import test from "node:test";
import {
	PAGE_WORLD_SCAN_SCHEMA,
	validatePageWorldScanBundle,
} from "../../src/kernels/abml/pageWorldScan.ts";
import { pageWorldScanBundle } from "../helpers/pageWorldScan.ts";

test("page-world scan bundle validates empty and fully populated v1 captures", () => {
	const empty = pageWorldScanBundle({ content: { text: "", tree: undefined }, stats: { nodeCount: 0, outputChars: 0 } });
	assert.deepEqual(validatePageWorldScanBundle(empty), { ok: true, value: empty });

	const full = pageWorldScanBundle({
		page: { language: "en-US" },
		content: { headings: ["Checkout"], interactive: ["Pay now"] },
		structure: {
			actionables: [
				{ index: 0, selector: "#pay", tag: "button", role: "button", label: "Pay now", text: "Pay now", clickable: true, editable: false, disabled: false, focused: false, handlers: [], rect: { x: 1, y: 2, width: 90, height: 30 }, documentRect: { x: 1, y: 202, width: 90, height: 30 }, point: { x: 46, y: 17 }, hitOk: true, hitTarget: null, priority: 100 },
				{ selector: "#dialog", role: "dialog", name: "Checkout", hidden: true, referenceOnly: true },
				{ sourceSelector: "#open", sourceRole: "button", sourceName: "Open", controlsSelectors: ["#dialog"], relationOnly: true },
			],
			rows: [{ text: "Order 42", selector: "#order-42", rect: { x: 1, y: 50, w: 120, h: 20 }, href: "https://example.test/orders/42", sameOrigin: true }],
			listHints: [{ selector: "#orders > li", itemCount: 10, hiddenCount: 7, firstItemPreview: "Order 1", sampleHidden: ["Order 4"] }],
			canvasRegions: [{ index: 0, tag: "canvas", role: "img", action: "Chart", label: "Chart", selector: "#chart", point: { x: 10, y: 10 }, rect: { x: 0, y: 0, width: 20, height: 20 }, hitOk: true, clickable: false }],
			mediaCandidates: [{ index: 0, tag: "img", selector: "#hero", rect: { x: 0, y: 0, w: 640, h: 360 }, src: "https://example.test/hero.png", sameOrigin: true, naturalWidth: 1280, naturalHeight: 720 }],
		},
		frames: { notes: [{ src: "https://frame.example.test/", accessible: false }] },
		signals: {
			fingerprint: { changeSeq: 9, url: "https://example.test/", title: "Example", readyState: "complete", visibleCount: 1, interactiveCount: 1, capturedAt: 42 },
			growthProbe: { supported: true, candidateCount: 1, target: "listHint", selector: "#orders > li", beforeCount: 10, afterCount: 20, restoredScrollTop: true, countGrew: true, heightGrew: false, windowShifted: false, elapsedMs: 80 },
		},
		stats: { nodeCount: 40, outputChars: 400, truncated: true },
	});
	assert.deepEqual(validatePageWorldScanBundle(full), { ok: true, value: full });
});

test("page-world scan bundle rejects unknown schemas, legacy roots, malformed nested fields, and unknown nested keys", () => {
	const valid = pageWorldScanBundle();
	const unknownSchema = { ...valid, schema: "browser-page-scan/v2" };
	const legacyRoot = { url: valid.page.url, content: valid.content.text, list_hints: [], node_count: 1 };
	const malformed = { ...valid, stats: { ...valid.stats, nodeCount: "one" } };
	const unknownNested = { ...valid, structure: { ...valid.structure, actionables: [{ selector: "#pay", unknownField: true }] } };
	const internalAnnotation = { ...valid, structure: { ...valid.structure, actionables: [{ selector: "#pay", entityRefs: { domAction: "bp-ref://control/pay" } }] } };

	for (const value of [unknownSchema, legacyRoot, malformed, unknownNested, internalAnnotation]) {
		const result = validatePageWorldScanBundle(value);
		assert.equal(result.ok, false, JSON.stringify(value));
		if (!result.ok) assert.equal(result.issues.length > 0, true);
	}
	const schemaIssue = validatePageWorldScanBundle(unknownSchema);
	assert.equal(schemaIssue.ok, false);
	if (!schemaIssue.ok) assert.equal(schemaIssue.issues.includes(`/schema: expected ${PAGE_WORLD_SCAN_SCHEMA}`), true);
});
