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
