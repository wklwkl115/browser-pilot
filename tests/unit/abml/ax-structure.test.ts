// ABML P3 (first slice) — ARIA structure/landmark vocabulary. The AX tree resolves
// document-outline metadata (heading level, list set membership, column sort, landmark
// role) that DOM-tag heuristics only approximate. These ride on Entity.structure,
// distinct from interaction state, and survive the DOM↔AX merge.
import test from "node:test";
import assert from "node:assert/strict";
import { buildAxEntityFromNode, mergeDomAndAxEntities } from "../../../src/abml/ax.ts";

const ctx = { observationId: "test", url: "https://example.test", capturedAt: 1 };
function axNode(role: string, name: string, props: Array<{ name: string; value: { value: string } }>, backendId = 10): Record<string, unknown> {
	return { role: { value: role }, name: { value: name }, backendDOMNodeId: backendId, hidden: false, properties: props };
}

test("AX extracts heading level (document structure)", () => {
	const h = buildAxEntityFromNode(axNode("heading", "Chapter 2", [{ name: "level", value: { value: "2" } }]), ctx);
	assert.equal(h.entity.structure?.level, 2);
});

test("AX extracts list-item setsize/posinset", () => {
	const item = buildAxEntityFromNode(axNode("listitem", "Item 3", [{ name: "setsize", value: { value: "10" } }, { name: "posinset", value: { value: "3" } }]), ctx);
	assert.equal(item.entity.structure?.setSize, 10);
	assert.equal(item.entity.structure?.posInSet, 3);
});

test("AX extracts column-header sort", () => {
	const col = buildAxEntityFromNode(axNode("columnheader", "Name", [{ name: "sort", value: { value: "ascending" } }]), ctx);
	assert.equal(col.entity.structure?.sort, "ascending");
});

test("AX classifies landmark roles, leaves non-landmarks without structure", () => {
	const nav = buildAxEntityFromNode(axNode("navigation", "Primary", []), ctx);
	assert.equal(nav.entity.structure?.landmark, "navigation");
	const plain = buildAxEntityFromNode(axNode("button", "Go", []), ctx);
	assert.equal(plain.entity.structure, undefined);
});

test("merge carries AX structure onto the aligned DOM entity", () => {
	const dom = {
		ref: "pi-ref://text/h", kind: "text", role: "heading", name: "Chapter 2",
		state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true },
		source: "dom", locators: [], geometry: { point: { x: 10, y: 10 } },
	} as unknown as Parameters<typeof mergeDomAndAxEntities>[0][number];
	const ax = buildAxEntityFromNode(axNode("heading", "Chapter 2", [{ name: "level", value: { value: "2" } }], 14), ctx, { point: { x: 10, y: 10 } });
	const { merged } = mergeDomAndAxEntities([dom], [ax]);
	assert.equal(merged[0]!.structure?.level, 2);
});
