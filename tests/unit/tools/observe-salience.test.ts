// ABML P2.5 — entity-level focus salience. After the DOM↔AX merge, AX-only controls are
// appended at the tail and bypass the scan-side scoreAction. This re-rank lifts active and
// stateful controls into primary_entities regardless of source, so an AX radio/checkbox the
// scan never surfaced (the W3C-ARIA case) leads the focus instead of sinking below noise.
import test from "node:test";
import assert from "node:assert/strict";
import { buildEntityOutline, buildPageGist, entitySalienceRank, sortEntitiesBySalience } from "../../../src/tools/observeRunners.ts";

function entity(kind: string, role: string, name: string, partialState: Record<string, unknown>): unknown {
	return { ref: "r", kind, role, name, state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true, ...partialState }, source: "ax" };
}

test("active controls rank above stateful, stateful above plain controls, controls above elements", () => {
	const activeRadio = entity("control", "radio", "active", { checked: true });
	const statefulRadio = entity("control", "radio", "stateful", { checked: false });
	const plainButton = entity("control", "button", "plain", {});
	const link = entity("element", "link", "link", {});
	assert.equal(entitySalienceRank(activeRadio as never), 0);
	assert.equal(entitySalienceRank(statefulRadio as never), 1);
	assert.equal(entitySalienceRank(plainButton as never), 2);
	assert.equal(entitySalienceRank(link as never), 3);
});

test("sort lifts active/stateful controls ahead of noise, stable within a rank", () => {
	const noiseLink = entity("element", "link", "Docs", {});
	const uncheckedBox = entity("control", "checkbox", "Subscribe", { checked: false });
	const checkedRadioA = entity("control", "radio", "A", { checked: true });
	const checkedRadioB = entity("control", "radio", "B", { checked: true });
	const sorted = sortEntitiesBySalience([noiseLink, uncheckedBox, checkedRadioA, checkedRadioB] as never[]);
	assert.deepEqual(sorted.map((e) => e.name), ["A", "B", "Subscribe", "Docs"], "active radios first (stable A before B), then stateful box, then plain link");
});

test("outline folds entities by AX container into largest-first groups with member refs", () => {
	const member = (ref: string, containerRole: string, containerName: string) => ({
		ref, kind: "control", role: "radio", name: ref,
		state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true },
		source: "ax", hints: { containerRole, containerName },
	});
	const noContainer = { ref: "x", kind: "element", role: "link", name: "Home", state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true }, source: "dom" };
	const label = { ref: "lbl", kind: "text", role: "text", name: "Crust label", state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true }, source: "ax", hints: { containerRole: "radiogroup", containerName: "Crust" } };
	const outline = buildEntityOutline([
		label,
		member("r1", "radiogroup", "Crust"),
		member("r2", "radiogroup", "Crust"),
		member("t1", "list", "Toppings"),
		noContainer,
	] as never[]);
	assert.equal(outline.length, 2, "only entities with a container are grouped");
	assert.equal(outline[0].container, "radiogroup", "largest group (3 members) first");
	assert.equal(outline[0].name, "Crust");
	assert.equal(outline[0].memberCount, 3, "total members incl. the non-control label");
	assert.equal(outline[0].controlCount, 2, "only the 2 radios count as controls");
	assert.deepEqual(outline[0].memberRefs, ["r1", "r2", "lbl"], "controls first, label/text last");
	assert.equal(outline[1].container, "list");
});

test("gist summarizes landmarks, control counts and containers (L0)", () => {
	const baseState = { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true };
	const nav = { ref: "n", kind: "region", role: "navigation", name: "Primary", state: baseState, source: "ax", structure: { landmark: "navigation" } };
	const main = { ref: "m", kind: "region", role: "main", name: "", state: baseState, source: "ax", structure: { landmark: "main" } };
	const activeRadio = { ref: "r1", kind: "control", role: "radio", name: "A", state: { ...baseState, checked: true }, source: "ax", hints: { containerRole: "radiogroup", containerName: "Crust" } };
	const uncheckedRadio = { ref: "r2", kind: "control", role: "radio", name: "B", state: { ...baseState, checked: false }, source: "ax", hints: { containerRole: "radiogroup", containerName: "Crust" } };
	const gist = buildPageGist([nav, main, activeRadio, uncheckedRadio] as never[]);
	assert.deepEqual(gist.landmarks, ["navigation", "main"]);
	assert.equal(gist.controlCount, 2);
	assert.equal(gist.statefulControlCount, 2);
	assert.equal(gist.activeControlCount, 1);
	assert.equal(gist.containerCount, 1, "both radios share the radiogroup:Crust container");
});
