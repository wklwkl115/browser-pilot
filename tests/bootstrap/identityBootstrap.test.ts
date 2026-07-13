import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { bootstrapScanBackendNodeIds } from "../../src/kernels/abml/identityBootstrap.ts";
import { pageWorldScanBundle } from "../helpers/pageWorldScan.ts";

test("bootstrapScanBackendNodeIds omits sampleWindowMs when snapshotEndedAt is invalid", () => {
	const result = bootstrapScanBackendNodeIds(pageWorldScanBundle(), [], {
		scanCapturedAt: 10,
		scanCapturedAtIso: new Date(10).toISOString(),
		snapshotEndedAt: "not-a-date",
	});
	assert.equal(result.stats.sampleWindowMs, undefined);
	assert.equal("backendNodeIdBootstrap" in result.data, false);
});

test("bootstrapScanBackendNodeIds keeps diagnostic jsonPath stable when actionable index is absent", () => {
	const result = bootstrapScanBackendNodeIds(pageWorldScanBundle({
		structure: { actionables: [{ selector: "#demo", rect: { x: 1, y: 2, width: 3, height: 4 } }] },
	}), []);
	assert.equal(result.stats.records[0]?.jsonPath, "data.structure.actionables[0]");
});

test("bootstrapScanBackendNodeIds spatial index preserves ambiguity, overflow, and stale-selector semantics", () => {
	const result = bootstrapScanBackendNodeIds(pageWorldScanBundle({
		structure: { actionables: [
			{ selector: "#ambiguous", rect: { x: -10, y: -10, width: 10, height: 10 } },
			{ selector: "#oversized", rect: { x: 0, y: 0, width: 2_000, height: 2_000 } },
			{ selector: "#stale", rect: { x: 4_000, y: 4_000, width: 10, height: 10 } },
		] },
	}), [
		{ backendNodeId: 1, bounds: { x: -10, y: -10, w: 10, h: 10 }, attrs: { id: "ambiguous" } },
		{ backendNodeId: 2, bounds: { x: -10, y: -10, w: 10, h: 10 } },
		{ backendNodeId: 3, bounds: { x: 0, y: 0, w: 2_000, h: 2_000 }, attrs: { id: "oversized" } },
		{ backendNodeId: 4, bounds: { x: 5_000, y: 5_000, w: 10, h: 10 }, attrs: { id: "stale" } },
	]);

	assert.deepEqual(result.stats.records.map((record) => record.status), ["ambiguous", "matched", "stale"]);
	assert.equal(result.stats.records[0]?.candidateCount, 2);
	assert.equal(result.stats.records[1]?.backendNodeId, 3);
	assert.equal(result.stats.records[2]?.backendNodeId, 4);
});

test("bootstrapScanBackendNodeIds stays bounded on large exact-match datasets", () => {
	const entries = Array.from({ length: 10000 }, (_, index) => ({
		backendNodeId: index + 1,
		bounds: { x: index % 500, y: Math.floor(index / 500), w: 10, h: 10 },
		attrs: { id: `id-${index}` },
	}));
	const actionables = Array.from({ length: 3000 }, (_, index) => ({
		index,
		selector: `#id-${index}`,
		rect: { x: index % 500, y: Math.floor(index / 500), width: 10, height: 10 },
	}));
	const data = pageWorldScanBundle({ structure: { actionables } });
	const maxElapsedMs = process.env.BROWSER_PILOT_COVERAGE === "1" ? 2_000 : process.env.CI ? 1_200 : 260;
	for (let warmup = 0; warmup < 2; warmup += 1) bootstrapScanBackendNodeIds(data, entries);
	const startedAt = performance.now();
	const result = bootstrapScanBackendNodeIds(data, entries);
	const elapsedMs = performance.now() - startedAt;
	assert.equal(result.stats.matched, 3000);
	assert.ok(elapsedMs < maxElapsedMs, `expected large exact-match bootstrap run < ${maxElapsedMs}ms after warmup, got ${elapsedMs.toFixed(2)}ms`);
});
