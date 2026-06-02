// ABML P1 — trustworthy control state. Chrome getFullAXTree node shapes fed into
// the AX pipeline: full widget-state vocabulary is extracted, and the DOM↔AX merge
// propagates AX state onto the aligned DOM entity (the fix for the xuetangx case
// where the lying DOM checked=false survived). These are the spike negatives flipped.
import test from "node:test";
import assert from "node:assert/strict";
import { buildAxEntityFromNode, mergeDomAndAxEntities } from "../../../src/abml/ax.ts";

const ctx = { observationId: "test", url: "https://example.test", capturedAt: 1 };

function axNode(role: string, name: string, props: Array<{ name: string; value: { value: string } }>, backendId = 10): Record<string, unknown> {
	return { role: { value: role }, name: { value: name }, backendDOMNodeId: backendId, hidden: false, properties: props };
}

test("AX extraction surfaces checked/selected/pressed/current (full widget state)", () => {
	const radio = buildAxEntityFromNode(axNode("radio", "True", [{ name: "checked", value: { value: "true" } }]), ctx);
	assert.equal((radio.entity.state as Record<string, unknown>).checked, true);

	const option = buildAxEntityFromNode(axNode("option", "Item A", [{ name: "selected", value: { value: "true" } }]), ctx);
	assert.equal((option.entity.state as Record<string, unknown>).selected, true);

	const toggle = buildAxEntityFromNode(axNode("button", "Bold", [{ name: "pressed", value: { value: "true" } }]), ctx);
	assert.equal((toggle.entity.state as Record<string, unknown>).pressed, true);

	const navlink = buildAxEntityFromNode(axNode("link", "Docs", [{ name: "current", value: { value: "page" } }]), ctx);
	assert.equal((navlink.entity.state as Record<string, unknown>).current, "page");
});

test("AX value reads aria-valuetext / valuenow (slider/progressbar)", () => {
	const slider = buildAxEntityFromNode(axNode("slider", "Volume", [{ name: "valuetext", value: { value: "70%" } }, { name: "valuenow", value: { value: "70" } }]), ctx);
	assert.equal(slider.entity.value, "70%");
});

test("merge propagates AX control state onto the aligned DOM entity (AX authoritative)", () => {
	// DOM entity lies (Vue: native input.checked=false) but is geometry/role-aligned to the AX node.
	const domEntity = {
		ref: "pi-ref://control/x", kind: "control", role: "radio", name: "True",
		state: { visible: true, occluded: false, disabled: false, focused: false, checked: false, editable: false, inViewport: true },
		source: "dom", locators: [], geometry: { point: { x: 100, y: 100 } },
	} as unknown as Parameters<typeof mergeDomAndAxEntities>[0][number];
	const ax = buildAxEntityFromNode(axNode("radio", "True", [{ name: "checked", value: { value: "true" } }], 11), ctx, { point: { x: 100, y: 100 } });
	const { merged } = mergeDomAndAxEntities([domEntity], [ax]);
	assert.equal(merged.length, 1);
	const e = merged[0];
	assert.equal((e.state as Record<string, unknown>).checked, true, "AX checked=true overrides the lying DOM checked=false");
	assert.deepEqual((e.hints as Record<string, unknown>).stateSource, { checked: "ax" }, "state source recorded as ax");
	assert.deepEqual((e.hints as Record<string, unknown>).mergedSources, ["dom", "ax"]);
});

test("merge corrects a DOM-mislabeled control via AX (role mismatch still aligns on name+geometry)", () => {
	// The DOM heuristic scanned a Vue radio as a textbox; AX knows it is a radio. Under the
	// old hard role-equality match this would never align, so the mislabel + missing state
	// survived. name + geometry now align them and AX role/state correct the DOM entity.
	const domEntity = {
		ref: "pi-ref://control/y", kind: "control", role: "textbox", name: "选项A",
		state: { visible: true, occluded: false, disabled: false, focused: false, editable: true, inViewport: true },
		source: "dom", locators: [], geometry: { point: { x: 200, y: 300 } },
	} as unknown as Parameters<typeof mergeDomAndAxEntities>[0][number];
	const ax = buildAxEntityFromNode(axNode("radio", "选项A", [{ name: "checked", value: { value: "true" } }], 12), ctx, { point: { x: 202, y: 301 } });
	const { merged, unmatchedAx } = mergeDomAndAxEntities([domEntity], [ax]);
	assert.equal(unmatchedAx.length, 0, "AX radio aligns to the mislabeled DOM entity instead of leaking as a new entity");
	assert.equal(merged.length, 1);
	assert.equal(merged[0]!.role, "radio", "AX role corrects the DOM textbox mislabel");
	assert.equal((merged[0]!.state as Record<string, unknown>).checked, true, "AX checked propagates onto the corrected entity");
});

test("merge fuses a native input via coincident geometry despite mislabeled role + dirty class-name (Selenium case)", () => {
	// The DOM scan mislabels a native <input type=radio> as a textbox, takes the CSS class
	// as the name, and emits no checked. Old matching (hard role / name-conflict veto) left
	// this unmerged → role stayed textbox, no checked, no stateSource. Box IoU recognizes it
	// as the SAME element and AX corrects everything while the DOM selector stays actionable.
	const domEntity = {
		ref: "pi-ref://control/r", kind: "control", role: "textbox", name: "form-check-input",
		state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true },
		source: "dom", locators: [{ by: "css", value: "#my-radio-1" }], geometry: { box: { x: 40, y: 300, w: 16, h: 16 }, point: { x: 48, y: 308 } },
	} as unknown as Parameters<typeof mergeDomAndAxEntities>[0][number];
	const ax = buildAxEntityFromNode(axNode("radio", "Radio button 1", [{ name: "checked", value: { value: "true" } }], 15), ctx, { box: { x: 40, y: 301, w: 16, h: 16 }, point: { x: 48, y: 309 } });
	const { merged, unmatchedAx } = mergeDomAndAxEntities([domEntity], [ax]);
	assert.equal(unmatchedAx.length, 0, "coincident geometry fuses them — no leaked duplicate AX entity");
	assert.equal(merged.length, 1);
	assert.equal(merged[0]!.role, "radio", "AX role corrects the textbox mislabel");
	assert.equal((merged[0]!.state as Record<string, unknown>).checked, true, "AX checked fills the missing DOM state");
	assert.deepEqual((merged[0]!.hints as Record<string, unknown>).stateSource, { checked: "ax" }, "control state is sourced from AX");
	assert.equal(merged[0]!.locators?.some((l) => (l as Record<string, unknown>).value === "#my-radio-1"), true, "DOM selector preserved for actioning");
});

test("merge does NOT cross-link entities with conflicting names", () => {
	// Same position, different accessible names → different elements. A conflicting name
	// must veto the role-agnostic path, otherwise overlapping controls would cross-link.
	const domEntity = {
		ref: "pi-ref://control/z", kind: "control", role: "textbox", name: "用户名",
		state: { visible: true, occluded: false, disabled: false, focused: false, editable: true, inViewport: true },
		source: "dom", locators: [], geometry: { point: { x: 50, y: 50 } },
	} as unknown as Parameters<typeof mergeDomAndAxEntities>[0][number];
	const ax = buildAxEntityFromNode(axNode("radio", "记住我", [{ name: "checked", value: { value: "true" } }], 13), ctx, { point: { x: 50, y: 50 } });
	const { merged, unmatchedAx } = mergeDomAndAxEntities([domEntity], [ax]);
	assert.equal(unmatchedAx.length, 1, "conflicting-name AX entity stays unmatched");
	assert.equal(merged[0]!.role, "textbox", "DOM entity is left untouched");
});
