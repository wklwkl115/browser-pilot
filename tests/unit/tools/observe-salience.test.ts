// ABML P2.5 — entity-level focus salience. After the DOM↔AX merge, AX-only controls are
// appended at the tail and bypass the scan-side scoreAction. This re-rank lifts active and
// stateful controls into primary_entities regardless of source, so an AX radio/checkbox the
// scan never surfaced (the W3C-ARIA case) leads the focus instead of sinking below noise.
import test from "node:test";
import assert from "node:assert/strict";
import { entitySalienceRank, sortEntitiesBySalience } from "../../../src/tools/observeRunners.ts";

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
