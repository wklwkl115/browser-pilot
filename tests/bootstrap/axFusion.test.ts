import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { buildAxEntityFromNode, mergeDomAndAxEntities } from "../../src/kernels/abml/ax.ts";
import type { BuiltEntity, Entity } from "../../src/kernels/abml/entity.ts";
import { entityRelationKeys } from "../../src/kernels/abml/relations.ts";

const BASE_STATE: Entity["state"] = {
	visible: true,
	occluded: false,
	disabled: false,
	focused: false,
	editable: false,
	inViewport: true,
};

function domEntity(ref: string, overrides: Partial<Entity> = {}): Entity {
	return { ref, kind: "control", role: "button", name: "Save", state: BASE_STATE, source: "dom", locators: [], ...overrides };
}

function axEntity(role: string, name: string, geometry?: Entity["geometry"], backendDOMNodeId?: number): BuiltEntity {
	return buildAxEntityFromNode(
		{ role, name, ...(backendDOMNodeId === undefined ? {} : { backendDOMNodeId }) },
		{ observationId: "ax-fusion-test", capturedAt: 1 },
		geometry,
	);
}

test("indexed AX fusion rejects ambiguous and role-conflicting geometry", () => {
	const dom = [
		domEntity("bp-ref://dom/box", { geometry: { point: { x: 100, y: 100 }, box: { x: 0, y: 0, w: 40, h: 40 } } }),
		domEntity("bp-ref://dom/point", { geometry: { point: { x: 100, y: 100 } } }),
	];
	const result = mergeDomAndAxEntities(dom, [
		axEntity("button", "Save", { point: { x: 100, y: 100 } }),
		axEntity("image", "Overlay", { box: { x: 0, y: 0, w: 40, h: 40 } }),
	]);

	assert.equal(result.diagnostics.axEnriched, 0);
	assert.deepEqual(result.diagnostics.skipped, { ambiguousBackend: 0, ambiguousGeometry: 1, ambiguousSemantic: 1, targetScopeMismatch: 0, unsafeSemantic: 0 });
	assert.equal(result.merged[0]?.name, "Save");
	assert.equal(result.merged[1]?.name, "Save");
	assert.equal(result.unmatchedAx.length, 2);
});

test("indexed AX fusion keeps overflow boxes, radius-boundary points, and normalized semantic matches", () => {
	const overflow = mergeDomAndAxEntities([
		domEntity("bp-ref://dom/overflow", { role: "region", name: "DOM region", geometry: { box: { x: 0, y: 0, w: 2_000, h: 2_000 } } }),
	], [axEntity("image", "AX overlay", { box: { x: 0, y: 0, w: 2_000, h: 2_000 } })]);
	assert.equal(overflow.diagnostics.axEnriched, 0);
	assert.equal(overflow.merged[0]?.name, "DOM region");

	const boundary = mergeDomAndAxEntities([
		domEntity("bp-ref://dom/boundary", { role: "link", name: "Shared name", geometry: { point: { x: 24, y: 0 } } }),
	], [axEntity("button", "Shared name", { point: { x: 0, y: 0 } })]);
	assert.equal(boundary.diagnostics.axEnriched, 0);

	const semantic = mergeDomAndAxEntities([
		domEntity("bp-ref://dom/semantic", { role: "button", name: "Case Name", geometry: undefined }),
	], [axEntity("button", "case name")]);
	assert.equal(semantic.diagnostics.axEnriched, 1);
	assert.equal(semantic.unmatchedAx.length, 0);
});

test("geometry enriches semantics without promoting AX identity while competing proposals stay unmatched", () => {
	const enriched = mergeDomAndAxEntities([
		domEntity("bp-ref://dom/enriched", { role: "button", name: "Save", locators: [{ by: "css", value: "#save" }], geometry: { box: { x: 0, y: 0, w: 100, h: 30 } } }),
	], [axEntity("button", "Save", { box: { x: 0, y: 0, w: 100, h: 30 } }, 42)]);
	assert.deepEqual(enriched.merged[0]?.locators, [{ by: "css", value: "#save" }]);
	assert.equal(enriched.merged[0]?.hints?.backendNodeId, undefined);
	assert.equal(enriched.merged[0]?.hints?.axNodeId, undefined);
	assert.deepEqual(entityRelationKeys(enriched.merged[0]!), []);
	assert.deepEqual(enriched.merged[0]?.hints?.fusionMatch, { tier: "geometry", confidence: "high" });
	assert.deepEqual(enriched.diagnostics.matched, { backend: 0, geometry: 1, semantic: 0 });

	const genericParent = mergeDomAndAxEntities([
		domEntity("bp-ref://dom/generic", { role: "generic", name: "Save", geometry: { box: { x: 0, y: 0, w: 100, h: 30 } } }),
	], [axEntity("button", "Save", { box: { x: 0, y: 0, w: 100, h: 30 } }, 42)]);
	assert.equal(genericParent.diagnostics.axEnriched, 0);

	const competing = mergeDomAndAxEntities([
		domEntity("bp-ref://dom/contended", { geometry: { point: { x: 10, y: 10 } } }),
	], [
		axEntity("button", "Save", { point: { x: 10, y: 10 } }),
		axEntity("button", "Save", { point: { x: 10, y: 10 } }),
	]);
	assert.equal(competing.diagnostics.axEnriched, 0);
	assert.equal(competing.diagnostics.skipped.ambiguousGeometry, 2);
	assert.equal(competing.unmatchedAx.length, 2);
});

test("fusion rejects conflicting names and target-scoped backend identities", () => {
	const nameConflict = mergeDomAndAxEntities([
		domEntity("bp-ref://dom/name", { name: "Parent", geometry: { box: { x: 0, y: 0, w: 100, h: 30 } } }),
	], [axEntity("button", "Child", { box: { x: 0, y: 0, w: 100, h: 30 } }, 42)]);
	assert.equal(nameConflict.diagnostics.axEnriched, 0);

	const targetConflict = mergeDomAndAxEntities([
		domEntity("bp-ref://dom/target", { locators: [{ by: "backendNodeId", value: 42, targetId: "target-a" }] }),
	], [buildAxEntityFromNode(
		{ role: "button", name: "Save", backendDOMNodeId: 42 },
		{ observationId: "ax-fusion-test", capturedAt: 1, targetId: "target-b" },
	)]);
	assert.equal(targetConflict.diagnostics.axEnriched, 0);
	assert.equal(targetConflict.diagnostics.skipped.targetScopeMismatch, 1);
	assert.equal(targetConflict.diagnostics.degraded, true);
	assert.deepEqual(entityRelationKeys(targetConflict.merged[0]!), ["t:target-a:b:42"]);
});

test("DOM-only, AX-only, and fused modes preserve execution and password boundaries", () => {
	const dom = domEntity("bp-ref://dom/password", { role: "textbox", name: "Password", value: undefined, hints: { inputKind: "password" }, locators: [{ by: "backendNodeId", value: 77 }] });
	const axWithoutBackend = buildAxEntityFromNode({ role: "textbox", name: "Password", value: "secret" }, { observationId: "ax-fusion-test", capturedAt: 1 });
	const axWithBackend = buildAxEntityFromNode({ role: "textbox", name: "Password", value: "secret", backendDOMNodeId: 77 }, { observationId: "ax-fusion-test", capturedAt: 1 });

	assert.deepEqual(mergeDomAndAxEntities([dom], []).merged, [dom]);
	assert.equal(axWithoutBackend.entity.actionability, undefined);
	assert.deepEqual(axWithBackend.entity.actionability, { actions: ["click", "edit"], confidence: "medium" });
	const fused = mergeDomAndAxEntities([dom], [axWithBackend]).merged[0]!;
	assert.equal(fused.value, undefined);
	assert.equal((fused.hints?.fieldSource as Record<string, unknown> | undefined)?.value, undefined);
});

test("indexed AX fusion preserves semantic score groups after geometry ambiguity", () => {
	const semanticWins = mergeDomAndAxEntities([
		domEntity("bp-ref://dom/near-left", { name: undefined, geometry: { point: { x: -24, y: 0 } } }),
		domEntity("bp-ref://dom/near-right", { name: undefined, geometry: { point: { x: 24, y: 0 } } }),
		domEntity("bp-ref://dom/named", { name: "Target", geometry: undefined }),
	], [axEntity("button", "Target", { point: { x: 0, y: 0 } })]);
	assert.equal(semanticWins.diagnostics.skipped.ambiguousGeometry, 1);
	assert.equal(semanticWins.diagnostics.skipped.ambiguousSemantic, 0);
	assert.equal(semanticWins.merged[2]?.hints?.mergedSources !== undefined, true);

	const semanticTie = mergeDomAndAxEntities([
		domEntity("bp-ref://dom/tie-left", { name: undefined, geometry: { point: { x: -20, y: 0 } } }),
		domEntity("bp-ref://dom/tie-right", { name: undefined, geometry: { point: { x: 20, y: 0 } } }),
		domEntity("bp-ref://dom/tie-named", { name: "Target", geometry: undefined }),
	], [axEntity("button", "Target", { point: { x: 0, y: 0 } })]);
	assert.equal(semanticTie.diagnostics.skipped.ambiguousGeometry, 1);
	assert.equal(semanticTie.diagnostics.skipped.ambiguousSemantic, 1);
	assert.equal(semanticTie.diagnostics.axOnly, 1);
});

type FusionMode = "backend" | "geometry" | "semantic";

function benchmarkDomEntity(index: number, mode: FusionMode): Entity {
	const x = (index % 200) * 40;
	const y = Math.floor(index / 200) * 40;
	const geometry = mode === "geometry" ? { point: { x, y }, box: { x, y, w: 20, h: 20 } } : undefined;
	return domEntity(`bp-ref://control/${index}`, {
		name: `Button ${index}`,
		locators: mode === "backend" ? [{ by: "backendNodeId", value: index + 1 }] : [],
		...(geometry ? { geometry } : {}),
	});
}

function benchmarkAxEntity(index: number, mode: FusionMode): BuiltEntity {
	const x = (index % 200) * 40;
	const y = Math.floor(index / 200) * 40;
	return axEntity(
		"button",
		`Button ${index}`,
		mode === "geometry" ? { point: { x, y }, box: { x, y, w: 20, h: 20 } } : undefined,
		mode === "backend" ? index + 1 : undefined,
	);
}

test("indexed AX fusion stays bounded across backend, geometry, and semantic 8k datasets", () => {
	const count = 8_000;
	let elapsedMs = 0;
	for (const mode of ["backend", "geometry", "semantic"] as const) {
		const dom = Array.from({ length: count }, (_, index) => benchmarkDomEntity(index, mode));
		const ax = Array.from({ length: count }, (_, index) => benchmarkAxEntity(index, mode));
		mergeDomAndAxEntities(dom.slice(0, 20), ax.slice(0, 20));
		const startedAt = performance.now();
		const result = mergeDomAndAxEntities(dom, ax);
		elapsedMs += performance.now() - startedAt;
		assert.equal(result.diagnostics.axEnriched, count);
		assert.equal(result.diagnostics.axOnly, 0);
	}
	const maxElapsedMs = process.env.BROWSER_PILOT_COVERAGE === "1" ? 3_000 : process.env.CI ? 1_500 : 400;
	assert.ok(elapsedMs < maxElapsedMs, `expected indexed AX fusion run < ${maxElapsedMs}ms, got ${elapsedMs.toFixed(2)}ms`);
});

test("indexed AX fusion keeps dense backend and unnamed semantic ambiguity buckets bounded", () => {
	const count = 10_000;
	const unnamedDom = Array.from({ length: count }, (_, index) => domEntity(`bp-ref://element/${index}`, { kind: "element", role: "generic", name: undefined, geometry: undefined }));
	const unnamedAx = Array.from({ length: count }, () => axEntity("generic", ""));
	mergeDomAndAxEntities(unnamedDom.slice(0, 20), unnamedAx.slice(0, 20));
	const semanticStartedAt = performance.now();
	const semantic = mergeDomAndAxEntities(unnamedDom, unnamedAx);
	const semanticElapsedMs = performance.now() - semanticStartedAt;
	assert.equal(semantic.diagnostics.axEnriched, 0);
	assert.equal(semantic.diagnostics.axOnly, count);
	assert.equal(semantic.diagnostics.skipped.ambiguousSemantic, count);

	const duplicateBackendDom = Array.from({ length: count }, (_, index) => domEntity(`bp-ref://backend/${index}`, { name: `Item ${index}`, locators: [{ by: "backendNodeId", value: 1 }] }));
	const duplicateBackendAx = Array.from({ length: count }, (_, index) => axEntity("button", `Item ${index}`, undefined, 1));
	const backendStartedAt = performance.now();
	const backend = mergeDomAndAxEntities(duplicateBackendDom, duplicateBackendAx);
	const elapsedMs = semanticElapsedMs + performance.now() - backendStartedAt;
	assert.equal(backend.diagnostics.axEnriched, count);
	assert.equal(backend.diagnostics.skipped.ambiguousBackend, count);

	const maxElapsedMs = process.env.BROWSER_PILOT_COVERAGE === "1" ? 2_500 : process.env.CI ? 1_000 : 250;
	assert.ok(elapsedMs < maxElapsedMs, `expected dense AX ambiguity runs < ${maxElapsedMs}ms, got ${elapsedMs.toFixed(2)}ms`);
});
