import test from "node:test";
import assert from "node:assert/strict";
import type { Entity, EntityState } from "../../../src/abml-core/entity.ts";
import { buildTemplateSummary, MIN_TEMPLATE_INSTANCES, MAX_TEMPLATE_INSTANCE_REFS } from "../../../src/abml-core/templating.ts";

// ABML mechanism arm — M1 structure templating. The selector folds repeated sibling entities (same
// AX container / aria-setsize + role/kind) into one template + compact instances + handles.

const st = (o: Partial<EntityState> = {}): EntityState => ({ visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true, ...o });

function item(ref: string, opts: { role?: string; kind?: string; name?: string; value?: string; container?: string; containerName?: string; setSize?: number; state?: Partial<EntityState> } = {}): Entity {
	const { role = "link", kind = "control", name, value, container, containerName, setSize, state } = opts;
	const hints: Record<string, unknown> = {};
	if (container) hints.containerRole = container;
	if (containerName) hints.containerName = containerName;
	return {
		ref,
		kind: kind as Entity["kind"],
		role,
		...(name !== undefined ? { name } : {}),
		...(value !== undefined ? { value } : {}),
		state: st(state),
		source: "dom",
		...(setSize !== undefined ? { structure: { setSize } } : {}),
		...(Object.keys(hints).length ? { hints } : {}),
	} as Entity;
}

test("templating: AX container group ≥ MIN folds into one template (count/role/varies/sample)", () => {
	const entities = Array.from({ length: 5 }, (_, i) => item(`pi-ref://control/l${i}`, { role: "link", container: "list", containerName: "Results", name: `Item ${i}` }));
	const { templates } = buildTemplateSummary(entities);
	assert.equal(templates.length, 1);
	const t = templates[0];
	assert.equal(t.count, 5);
	assert.equal(t.container, "list");
	assert.equal(t.containerName, "Results");
	assert.equal(t.role, "link");
	assert.equal(t.kind, "control");
	assert.deepEqual(t.varies, ["name"], "names differ across instances");
	assert.deepEqual(t.constant, { role: "link", kind: "control" }, "only role/kind are constant here");
	assert.equal(t.instanceRefs.length, 5);
	assert.equal(t.sample?.ref, "pi-ref://control/l0");
	assert.equal(t.sample?.name, "Item 0");
});

test("templating: aria-setsize set (no AX container) folds, carries setSize, no container", () => {
	const entities = Array.from({ length: 6 }, (_, i) => item(`pi-ref://control/o${i}`, { role: "option", name: `Opt ${i}`, setSize: 6 }));
	const { templates } = buildTemplateSummary(entities);
	assert.equal(templates.length, 1);
	assert.equal(templates[0].setSize, 6);
	assert.equal(templates[0].container, undefined, "setSize grouping has no AX container");
	assert.equal(templates[0].count, 6);
});

test("templating: a group below MIN_TEMPLATE_INSTANCES is not a template", () => {
	const entities = Array.from({ length: MIN_TEMPLATE_INSTANCES - 1 }, (_, i) => item(`r${i}`, { container: "list", name: `x${i}` }));
	assert.equal(buildTemplateSummary(entities).templates.length, 0);
});

test("templating: varies vs constant — uniform value/truthy-state constant, default state omitted", () => {
	const entities = Array.from({ length: 4 }, (_, i) => item(`pi-ref://control/c${i}`, { role: "checkbox", container: "group", containerName: "Opts", name: `C${i}`, value: "on", state: { checked: true } }));
	const t = buildTemplateSummary(entities).templates[0];
	assert.deepEqual(t.varies, ["name"], "only name differs");
	assert.equal(t.constant.value, "on", "uniform value → constant");
	assert.equal(t.constant.checked, true, "uniform truthy checked → constant");
	assert.ok(!("disabled" in t.constant), "uniform disabled:false is the default → omitted");
});

test("templating: a uniformly-differing state field lands in varies, not constant", () => {
	const entities = [
		item("pi-ref://control/d0", { role: "checkbox", container: "group", containerName: "G", name: "a", state: { checked: true } }),
		item("pi-ref://control/d1", { role: "checkbox", container: "group", containerName: "G", name: "a", state: { checked: false } }),
		item("pi-ref://control/d2", { role: "checkbox", container: "group", containerName: "G", name: "a", state: { checked: true } }),
		item("pi-ref://control/d3", { role: "checkbox", container: "group", containerName: "G", name: "a", state: { checked: false } }),
	];
	const t = buildTemplateSummary(entities).templates[0];
	assert.ok(t.varies.includes("checked"), "checked differs → varies");
	assert.ok(!t.varies.includes("name"), "name uniform → not varies");
	assert.equal(t.constant.name, "a", "uniform name → constant");
	assert.ok(!("checked" in t.constant), "checked is in varies, not constant");
});

test("templating: instanceRefs capped, count is the true size", () => {
	const entities = Array.from({ length: 30 }, (_, i) => item(`pi-ref://control/m${i}`, { container: "list", name: `n${i}` }));
	const t = buildTemplateSummary(entities).templates[0];
	assert.equal(t.count, 30, "count is the true folded size");
	assert.equal(t.instanceRefs.length, MAX_TEMPLATE_INSTANCE_REFS, "instanceRefs capped");
});

test("templating: different roles in the same container form separate templates", () => {
	const links = Array.from({ length: 4 }, (_, i) => item(`pi-ref://control/lk${i}`, { role: "link", container: "navigation", containerName: "Main", name: `L${i}` }));
	const btns = Array.from({ length: 4 }, (_, i) => item(`pi-ref://control/bn${i}`, { role: "button", container: "navigation", containerName: "Main", name: `B${i}` }));
	const { templates } = buildTemplateSummary([...links, ...btns]);
	assert.equal(templates.length, 2, "link group and button group stay distinct");
});

test("templating: distinct containerNames (with spaces) do not collide into one template", () => {
	const a = Array.from({ length: 4 }, (_, i) => item(`pi-ref://control/a${i}`, { role: "link", container: "list", containerName: "Search Results", name: `A${i}` }));
	const b = Array.from({ length: 4 }, (_, i) => item(`pi-ref://control/b${i}`, { role: "link", container: "list", containerName: "Related", name: `B${i}` }));
	const { templates } = buildTemplateSummary([...a, ...b]);
	assert.equal(templates.length, 2, "JSON key avoids delimiter collision on spaced names");
	assert.deepEqual(templates.map((t) => t.containerName).sort(), ["Related", "Search Results"]);
});

test("templating: entities with no container and no setSize are never templated", () => {
	const entities = Array.from({ length: 6 }, (_, i) => item(`r${i}`, { name: `x${i}` }));
	assert.equal(buildTemplateSummary(entities).templates.length, 0, "no ARIA repetition signal → no guessing");
});

test("templating: templates sorted by instance count descending", () => {
	const small = Array.from({ length: 4 }, (_, i) => item(`pi-ref://control/s${i}`, { role: "link", container: "navigation", containerName: "Side", name: `S${i}` }));
	const big = Array.from({ length: 8 }, (_, i) => item(`pi-ref://control/g${i}`, { role: "link", container: "list", containerName: "Feed", name: `G${i}` }));
	const { templates } = buildTemplateSummary([...small, ...big]);
	assert.equal(templates[0].count, 8, "largest group first");
	assert.equal(templates[1].count, 4);
});
