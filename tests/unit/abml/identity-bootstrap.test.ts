import test from "node:test";
import assert from "node:assert/strict";
import { bootstrapScanBackendNodeIds, type SnapshotGeometryEntry } from "../../../src/abml-core/identityBootstrap.ts";

const entries: SnapshotGeometryEntry[] = [
	{ backendNodeId: 101, bounds: { x: 20, y: 240, w: 100, h: 40 }, attrs: { id: "stable" } },
	{ backendNodeId: 201, bounds: { x: 200, y: 240, w: 100, h: 40 }, attrs: { id: "dup-a" } },
	{ backendNodeId: 202, bounds: { x: 200, y: 240, w: 100, h: 40 }, attrs: { id: "dup-b" } },
	{ backendNodeId: 301, bounds: { x: 760, y: 240, w: 100, h: 40 }, attrs: { id: "drift" } },
];

test("bootstrapScanBackendNodeIds stamps unique geometry matches and keeps fail-open states", () => {
	const result = bootstrapScanBackendNodeIds({
		viewport: { scrollX: 0, scrollY: 100, devicePixelRatio: 2 },
		actionables: [
			{ index: 0, selector: "#stable", rect: { x: 10, y: 20, width: 50, height: 20 } },
			{ index: 1, selector: "#dup-a", rect: { x: 100, y: 20, width: 50, height: 20 } },
			{ index: 2, selector: "#drift", rect: { x: 300, y: 20, width: 50, height: 20 } },
			{ index: 3, selector: "#bad" },
		],
	}, entries, { scanCapturedAt: 1_000, snapshotStartedAt: new Date(1_100).toISOString(), snapshotEndedAt: new Date(1_250).toISOString() });
	const actionables = result.data.actionables as Array<Record<string, unknown>>;
	assert.equal(actionables[0]?.backendNodeId, 101, "unique high-IoU match is stamped");
	assert.equal(actionables[1]?.backendNodeId, undefined, "duplicate high-IoU candidates stay fail-open");
	assert.equal(actionables[2]?.backendNodeId, undefined, "selector geometry drift stays fail-open");
	assert.deepEqual(
		{
			matched: result.stats.matched,
			ambiguous: result.stats.ambiguous,
			stale: result.stats.stale,
			unsupported: result.stats.unsupported,
			coverage: result.stats.coverage,
			scale: result.stats.snapshotScaleDivisor,
			sampleWindowMs: result.stats.sampleWindowMs,
		},
		{ matched: 1, ambiguous: 1, stale: 1, unsupported: 1, coverage: 0.25, scale: 2, sampleWindowMs: 250 },
	);
	assert.equal(result.stats.records.find((item) => item.jsonPath === "data.actionables[1]")?.reason, "multiple-high-iou-candidates");
	assert.equal(result.stats.records.find((item) => item.jsonPath === "data.actionables[2]")?.reason, "selector-node-geometry-drift");
});

test("bootstrapScanBackendNodeIds reports missing when no geometry or selector oracle matches", () => {
	const result = bootstrapScanBackendNodeIds({
		viewport: { scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
		actionables: [{ index: 0, selector: ".unknown", rect: { x: 400, y: 20, width: 50, height: 20 } }],
	}, entries);
	assert.equal(result.stats.missing, 1);
	assert.equal((result.data.actionables as Array<Record<string, unknown>>)[0]?.backendNodeId, undefined);
});
