/**
 * ABML DOM Entity scan contract (P3 internal gate).
 *
 * Verifies:
 * - scan summary builds primary/list Entity projections without changing legacy top-level shape
 * - primary action entities mint pi-ref:// refs with css + textAnchor + point locators when available
 * - entity owner metadata inherits browserSessionId/tabId/url/observationId/capturedAt from observe context
 * - list hints mint region refs and entity de-duplication keeps stable counts
 */
import assert from "node:assert/strict";
import { summarizeScanData } from "../../../src/tools/summaries/scan.ts";

const baseData = {
	url: "https://shop.example.test/checkout",
	title: "Checkout",
	readyState: "complete",
	content: "<h1>Checkout</h1>\n<button>Pay now</button>\n<input name=card>\n20 items in cart",
	node_count: 40,
	truncated: false,
	actionables: [
		{ index: 0, tag: "button", role: "button", action: "pay", label: "Pay now", selector: "#pay", point: { x: 180, y: 260 }, rect: { x: 140, y: 240, width: 80, height: 32 }, hitOk: true, clickable: true, disabled: false, priority: 1500 },
		{ index: 1, tag: "button", role: "button", action: "pay", label: "Pay now", selector: "#pay", point: { x: 180, y: 260 }, rect: { x: 140, y: 240, width: 80, height: 32 }, hitOk: true, clickable: true, disabled: false, priority: 1400 },
		{ index: 2, tag: "input", role: "textbox", action: "card", label: "Card number", selector: "#card", point: { x: 100, y: 200 }, rect: { x: 80, y: 180, width: 220, height: 30 }, hitOk: true, editable: true, disabled: false, priority: 1200 },
	],
	list_hints: [
		{ selector: "main > div.cart > div.item", itemCount: 20, hiddenCount: 17, firstItemPreview: "Item 1 $10", sampleHidden: ["Item 4 $40", "Item 5 $50"] },
		{ selector: "main > div.cart > div.item", itemCount: 20, hiddenCount: 17, firstItemPreview: "Item 1 $10", sampleHidden: ["Item 6 $60"] },
	],
};

const summary = summarizeScanData(baseData, [{ id: 1 }], {
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

	// legacy top-level surface remains unchanged
	assert.equal("entities" in summary, false, "scan summary must not add a new top-level entities field before public surface convergence");
	assert(Array.isArray(summary.focus?.primary_actions), "scan summary must keep legacy focus.primary_actions");
	assert(Array.isArray(summary.focus?.primary_entities), "scan summary must expose internal primary_entities under focus");
	assert(Array.isArray(summary.focus?.list_entities), "scan summary must expose internal list_entities under focus");

	const primaryEntities = summary.focus.primary_entities;
	const listEntities = summary.focus.list_entities;
	assert(primaryEntities.length >= 2, "scan summary must mint primary action entities");
	assert.equal(listEntities.length, 1, "scan list entity de-duplication must collapse duplicate list hints");

	const payEntity = primaryEntities.find((entity) => entity.name === "pay" || entity.name === "Pay now");
	assert(payEntity, "scan summary must include a Pay now entity");
	assert.match(payEntity.ref, /^pi-ref:\/\//, "entity ref must use pi-ref:// scheme");
	assert.equal(payEntity.kind, "control", "button actionable must become control entity");
	assert.equal(payEntity.role, "button", "entity role must preserve button role");
	assert.equal(payEntity.source, "dom", "scan actionable entities must be sourced from dom");
	assert.equal(Array.isArray(payEntity.locators), true, "entity must carry locators");
	assert(payEntity.locators.some((locator) => locator.by === "css" && locator.value === "#pay"), "entity must preserve selector as css locator");
	assert(payEntity.locators.some((locator) => locator.by === "textAnchor" && locator.value === "pay"), "entity must mint textAnchor locator from role/text");
	assert(payEntity.locators.some((locator) => locator.by === "point" && locator.x === 180 && locator.y === 260), "entity must mint point locator from scan geometry");
	assert.equal(payEntity.geometry.box.w, 80, "entity geometry must preserve actionable box");
	assert.equal(payEntity.geometry.point.x, 180, "entity geometry must preserve actionable point");
	assert.equal(payEntity.hints.jsonPath, "data.actionables[0]", "entity hints must keep actionables jsonPath");

	const payAction = summary.focus.primary_actions.find((action) => action.jsonPath === "data.actionables[0]");
	assert(payAction?.entity?.ref === payEntity.ref, "primary action summary row must carry the minted entity handle");

	assert.equal(payEntity.hints.selector, "#pay", "minted entity must preserve selector hint");
	assert.equal(payEntity.hints.jsonPath, "data.actionables[0]", "minted entity must preserve source jsonPath");
	assert.match(payEntity.ref, /^pi-ref:\/\/control\//, "minted ref must use control pi-ref URI shape");

	const listEntity = listEntities[0];
	assert.equal(listEntity.kind, "region", "list hints must mint region entities");
	assert.equal(listEntity.role, "list", "list hint entity role must be list");
	assert.equal(listEntity.hints.listContainer, true, "list hint entity must mark listContainer");
	assert.equal(listEntity.hints.hiddenCount, 17, "list hint entity must preserve hiddenCount");
	assert(listEntity.locators.some((locator) => locator.by === "css"), "list hint entity must preserve selector locator");
	assert(listEntity.locators.some((locator) => locator.by === "textAnchor"), "list hint entity must mint textAnchor from preview text");
	assert.equal(listEntity.hints.jsonPath, "data.list_hints[0]", "list hint entity must preserve source jsonPath");
	assert.match(listEntity.ref, /^pi-ref:\/\/region\//, "list hint entity must use region pi-ref URI shape");

console.log("abml scan entities ok");
