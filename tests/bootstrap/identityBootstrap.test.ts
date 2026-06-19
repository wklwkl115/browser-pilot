import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { bootstrapScanBackendNodeIds } from "../../src/kernels/abml/identityBootstrap.ts";

test("bootstrapScanBackendNodeIds omits sampleWindowMs when snapshotEndedAt is invalid", () => {
	const result = bootstrapScanBackendNodeIds({ viewport: {}, actionables: [] }, [], {
		scanCapturedAt: 10,
		scanCapturedAtIso: new Date(10).toISOString(),
		snapshotEndedAt: "not-a-date",
	});
	assert.equal(result.stats.sampleWindowMs, undefined);
	assert.equal("sampleWindowMs" in result.data.backendNodeIdBootstrap, false);
});

test("bootstrapScanBackendNodeIds keeps diagnostic jsonPath stable when actionable index is invalid", () => {
	const result = bootstrapScanBackendNodeIds({
		viewport: { scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
		actionables: [{ index: "foo", selector: "#demo", rect: { x: 1, y: 2, width: 3, height: 4 } }],
	}, []);
	assert.equal(result.stats.records[0]?.jsonPath, "data.actionables[0]");
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
	const data = { viewport: { scrollX: 0, scrollY: 0, devicePixelRatio: 1 }, actionables };
	const maxElapsedMs = process.env.CI ? 1200 : 260;
	for (let warmup = 0; warmup < 2; warmup += 1) bootstrapScanBackendNodeIds(data, entries);
	const startedAt = performance.now();
	const result = bootstrapScanBackendNodeIds(data, entries);
	const elapsedMs = performance.now() - startedAt;
	assert.equal(result.stats.matched, 3000);
	assert.ok(elapsedMs < maxElapsedMs, `expected large exact-match bootstrap run < ${maxElapsedMs}ms after warmup, got ${elapsedMs.toFixed(2)}ms`);
});
