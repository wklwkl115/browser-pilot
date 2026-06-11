/**
 * ABML DOM Entity scan contract (P3 internal gate).
 *
 * Verifies:
 * - scan summary builds primary/list Entity ref projections without changing legacy top-level shape
 * - primary action entities mint pi-ref:// refs with css + textAnchor + point locators when available
 * - entity owner metadata inherits browserSessionId/tabId/url/observationId/capturedAt from observe context
 * - list hints mint region refs and entity de-duplication keeps stable counts
 */
import assert from "node:assert/strict";
import { scanEntitiesForEnvelope, summarizeScanData } from "../../../src/tools/summaries/scan.ts";

const baseData = {
	url: "https://shop.example.test/checkout",
	title: "Checkout",
	readyState: "complete",
	content: "<h1>Checkout</h1>\n<button>Pay now</button>\n<input name=card>\n20 items in cart",
	node_count: 40,
	truncated: false,
	actionables: [
		{ index: 0, tag: "button", role: "button", action: "pay", label: "Pay now", selector: "#pay", point: { x: 180, y: 260 }, rect: { x: 140, y: 240, width: 80, height: 32 }, hitOk: true, clickable: true, disabled: false, priority: 1500, controlsSelectors: Array.from({ length: 10 }, (_, i) => `#panel-${i}`) },
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
const envelopeEntities = scanEntitiesForEnvelope(baseData, {
		entityContext: {
			browserSessionId: "session-1",
			tabId: 42,
			url: "https://shop.example.test/checkout",
			observationId: "snapshot-123",
			capturedAt: 1710000000000,
		},
	});

const wrapperAction = {
	index: 3,
	tag: "div",
	role: null,
	action: "el-input",
	label: "",
	displayLabel: "请输入漏洞名称",
	text: "",
	selector: "#vuln-wrapper",
	point: { x: 120, y: 320 },
	rect: { x: 80, y: 300, width: 260, height: 34 },
	hitOk: true,
	clickable: true,
	editable: false,
	disabled: false,
	priority: 1450,
	hitTarget: { tag: "input", inputLabel: "请输入漏洞名称" },
};
const wrapperData = { ...baseData, actionables: [...baseData.actionables, wrapperAction] };
const wrapperDataWithoutDisplay = { ...baseData, actionables: [...baseData.actionables, { ...wrapperAction, displayLabel: undefined, hitTarget: { tag: "input" } }] };
const wrapperSummary = summarizeScanData(wrapperData, [], {
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
const wrapperEntities = scanEntitiesForEnvelope(wrapperData, {
	entityContext: {
		browserSessionId: "session-1",
		tabId: 42,
		url: "https://shop.example.test/checkout",
		observationId: "snapshot-123",
		capturedAt: 1710000000000,
	},
});
const wrapperEntitiesWithoutDisplay = scanEntitiesForEnvelope(wrapperDataWithoutDisplay, {
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
	assert.equal(summary.focus?.entityShape, "refs-v1", "scan summary must version the focus entity-ref projection");
	assert(Array.isArray(summary.focus?.primary_entities), "scan summary must expose primary entity refs under focus");
	assert(Array.isArray(summary.focus?.list_entities), "scan summary must expose list entity refs under focus");

	const primaryEntityRefs = summary.focus.primary_entities;
	const listEntityRefs = summary.focus.list_entities;
	assert(primaryEntityRefs.length >= 2, "scan summary must mint primary action entity refs");
	assert.equal(listEntityRefs.length, 1, "scan list entity de-duplication must collapse duplicate list hint refs");
	assert(primaryEntityRefs.every((ref) => typeof ref === "string" && ref.startsWith("pi-ref://")), "primary_entities must be refs");
	assert(listEntityRefs.every((ref) => typeof ref === "string" && ref.startsWith("pi-ref://")), "list_entities must be refs");

	const payEntity = envelopeEntities.find((entity) => entity.name === "pay" || entity.name === "Pay now");
	assert(payEntity, "scan summary must include a Pay now entity");
	assert(primaryEntityRefs.includes(payEntity.ref), "focus primary_entities must point at the Pay now entity ref");
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
	assert.equal(payAction?.entityRef, payEntity.ref, "primary action summary row must carry the minted entity handle as a ref");
	assert.equal(payAction?.entity, undefined, "primary action summary row must not embed the full entity object");

	const wrapperActionSummary = wrapperSummary.focus.primary_actions.find((action) => action.jsonPath === "data.actionables[3]");
	assert.equal(wrapperActionSummary?.name, "请输入漏洞名称", "displayLabel must improve the primary action display name for wrapper-pattern inputs");
	const wrapperEntity = wrapperEntities.find((entity) => entity.hints?.jsonPath === "data.actionables[3]");
	const wrapperEntityWithoutDisplay = wrapperEntitiesWithoutDisplay.find((entity) => entity.hints?.jsonPath === "data.actionables[3]");
	assert.equal(wrapperEntity?.name, "el-input", "displayLabel must not replace the entity identity name");
	assert.equal(wrapperEntity?.ref, wrapperEntityWithoutDisplay?.ref, "displayLabel must not participate in pi-ref minting");

	assert.equal(payEntity.hints.selector, "#pay", "minted entity must preserve selector hint");
	assert.equal(payEntity.hints.jsonPath, "data.actionables[0]", "minted entity must preserve source jsonPath");
	assert.equal(payEntity.hints.controlsSelectors.length, 8, "selector relation hint arrays must be capped");
	assert.match(payEntity.ref, /^pi-ref:\/\/control\//, "minted ref must use control pi-ref URI shape");

	const listEntity = envelopeEntities.find((entity) => entity.ref === listEntityRefs[0]);
	assert(listEntity, "envelope entities must carry the full list entity object");
	assert.equal(listEntity.kind, "region", "list hints must mint region entities");
	assert.equal(listEntity.role, "list", "list hint entity role must be list");
	assert.equal(listEntity.hints.listContainer, true, "list hint entity must mark listContainer");
	assert.equal(listEntity.hints.hiddenCount, 17, "list hint entity must preserve hiddenCount");
	assert(listEntity.locators.some((locator) => locator.by === "css"), "list hint entity must preserve selector locator");
	assert(listEntity.locators.some((locator) => locator.by === "textAnchor"), "list hint entity must mint textAnchor from preview text");
	assert.equal(listEntity.hints.jsonPath, "data.list_hints[0]", "list hint entity must preserve source jsonPath");
	assert.match(listEntity.ref, /^pi-ref:\/\/region\//, "list hint entity must use region pi-ref URI shape");

console.log("abml scan entities ok");
