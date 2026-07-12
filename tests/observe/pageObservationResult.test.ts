import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPageObservation } from "../../src/commands/observe/scanProjection.ts";
import { pageObservationResult } from "../../src/commands/resultMiddleware.ts";
import type { CollectionModel } from "../../src/kernels/abml/collections.ts";
import type { Entity } from "../../src/kernels/abml/entity.ts";
import { isPageObservationV3, type PageObservationV3 } from "../../src/kernels/abml/pageObservation.ts";
import type { SnapshotProjection } from "../../src/kernels/abml/snapshotProjection.ts";
import { costOfRenderedJson } from "../../src/kernels/evidence/cost.ts";
import { hasJsonPathValue } from "../../src/utils/jsonPath.ts";

const state: Entity["state"] = { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true };

function entity(index: number): Entity {
	return { ref: `bp-ref://element/item/${index}`, kind: "element", role: "listitem", name: `Item ${index}`, state, source: "dom" };
}

function snapshot(snapshotId: string) {
	return { snapshotId, browserSessionId: "session-1", tabId: 7, targetGeneration: 2, pageEpoch: "page-1", sourceMode: "scan", capturedAt: 1, ttlMs: 300_000 };
}

function projection(): SnapshotProjection {
	const refs = Array.from({ length: 6 }, (_, index) => entity(index).ref);
	return {
		summary: { templateCount: 1, instanceCount: refs.length, projectedInstanceRefCount: refs.length },
		templates: [{ templateKey: "items", role: "listitem", kind: "element", count: refs.length, varies: [], constant: {}, instanceRefs: refs, instanceRefCount: refs.length }],
	};
}

function collections(): CollectionModel[] {
	const refs = Array.from({ length: 6 }, (_, index) => entity(index).ref);
	return [{
		collectionId: "items",
		kind: "list",
		containerRef: "bp-ref://region/items",
		containerName: "Items",
		observedCount: refs.length,
		itemRefCount: refs.length,
		itemRefs: refs,
		estimatedTotal: 120,
		completeness: "virtualized",
		confidence: "high",
		paginationControl: { ref: "bp-ref://element/load-more", label: "Load more", kind: "load-more" },
		dataSources: [{ source: "dom", ref: "bp-ref://region/items", summary: "virtual window", confidence: "high" }],
		evidence: [{ source: "listHints", summary: "six visible items", jsonPath: "structure.listHints[0]" }],
	}];
}

function buildFixture(content = "Visible content ".repeat(80)) {
	const entities = Array.from({ length: 24 }, (_, index) => entity(index));
	return buildPageObservation({
		mode: "scan",
		canonical: true,
		summary: {
			focus: { gist: { title: "Inventory" }, primary_entities: [entities[0]] },
			snapshotProjection: projection(),
			collections: collections(),
		},
		entities,
		content,
		url: "https://example.test/inventory",
		tabs: [{ id: 7 }],
		activeTabId: 7,
		snapshot: snapshot("snapshot-1"),
		abmlIntegrated: true,
		diagnostics: { warnings: ["bounded fixture"] },
		budgetChars: 8_000,
	});
}

async function outputPath(name: string): Promise<string> {
	return path.join(await mkdtemp(path.join(tmpdir(), "browser-pilot-page-observation-")), name);
}

function assertExactCost(value: PageObservationV3, rendered: string): void {
	assert.deepEqual(value.limits.cost, costOfRenderedJson(rendered));
}

test("PageObservation v3 persists one exact-cost root and verifies every frontier read", async () => {
	const built = buildFixture();
	const artifactPath = await outputPath("observation.json");
	const result = await pageObservationResult({ inline: built.inline, artifact: built.artifact, maxChars: 8_000, outputPath: artifactPath, fallbackName: "observation.json" });
	const inlineText = result.content[0]?.text ?? "";
	const inline = JSON.parse(inlineText) as PageObservationV3;
	const artifactText = await readFile(artifactPath, "utf8");
	const artifact = JSON.parse(artifactText) as PageObservationV3;

	assert.equal(isPageObservationV3(inline), true, JSON.stringify(inline));
	assert.equal(isPageObservationV3(artifact), true);
	assertExactCost(inline, inlineText);
	assertExactCost(artifact, artifactText);
	assert.equal(artifact.saved?.path, path.resolve(artifactPath));
	assert.equal(artifact.saved?.chars, artifactText.length);
	assert.equal(artifact.saved?.bytes, Buffer.byteLength(artifactText, "utf8"));
	assert.deepEqual(inline.saved, artifact.saved);
	assert.equal(new Set(inline.frontier.items.map((item) => item.ref)).size, inline.frontier.items.length);
	for (const item of inline.frontier.items) {
		if (item.read) assert.equal(hasJsonPathValue(artifact, item.read.jsonPath), true, `${item.ref}: ${item.read.jsonPath}`);
		else assert.ok(item.unavailableReason, `${item.ref} must explain unavailable content`);
	}

	const template = inline.frontier.items.find((item) => item.kind === "template-instances");
	const collection = inline.frontier.items.find((item) => item.kind === "collection-window");
	assert.deepEqual({ observed: template?.observed, total: template?.total }, { observed: 3, total: 6 });
	assert.equal(collection?.state, "virtualized");
	assert.equal(collection?.controlRef, "bp-ref://element/load-more");
	assert.equal(Object.hasOwn(inline.collections?.[0] ?? {}, "evidence"), false);
	assert.equal(Array.isArray(artifact.collections?.[0]?.evidence), true);
});

test("PageObservation v3 converts a missing persisted frontier path into explicit unavailability", async () => {
	const built = buildFixture("short content");
	const missing = {
		ref: "frontier:missing",
		kind: "diagnostics" as const,
		state: "folded" as const,
		read: { tool: "browser_artifact" as const, mode: "json" as const, pathRef: "saved.path" as const, jsonPath: "diagnostics.missing" },
	};
	built.inline.frontier.items.push(missing);
	built.artifact.frontier.items.push(missing);
	const artifactPath = await outputPath("missing-frontier.json");
	const result = await pageObservationResult({ inline: built.inline, artifact: built.artifact, maxChars: 8_000, outputPath: artifactPath, fallbackName: "missing-frontier.json" });
	const inline = JSON.parse(result.content[0]?.text ?? "{}") as PageObservationV3;
	const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as PageObservationV3;
	const converted = inline.frontier.items.find((item) => item.ref === missing.ref);
	assert.equal(converted?.state, "unavailable");
	assert.equal(converted?.read, undefined);
	assert.match(converted?.unavailableReason ?? "", /diagnostics\.missing/);
	assert.deepEqual(converted, artifact.frontier.items.find((item) => item.ref === missing.ref));
});

test("PageObservation v3 fitting is one schema with artifact-backed omissions and a hard ceiling", async () => {
	const built = buildFixture("Large visible content ".repeat(500));
	const artifactPath = await outputPath("fitted.json");
	const result = await pageObservationResult({ inline: built.inline, artifact: built.artifact, maxChars: 3_000, outputPath: artifactPath, fallbackName: "fitted.json" });
	const rendered = result.content[0]?.text ?? "";
	const inline = JSON.parse(rendered) as PageObservationV3;
	const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as PageObservationV3;
	assert.ok(rendered.length <= 3_000, rendered.length.toString());
	assert.equal(inline.schema, artifact.schema);
	assert.equal(inline.limits.truncated, true);
	assertExactCost(inline, rendered);
	for (const item of inline.frontier.items) {
		assert.equal(Boolean(item.read) || Boolean(item.unavailableReason), true, item.ref);
		if (item.read) assert.equal(hasJsonPathValue(artifact, item.read.jsonPath), true, item.read.jsonPath);
	}
});

test("PageObservation v3 fails explicitly when the mandatory root cannot satisfy maxChars", async () => {
	const built = buildFixture("short");
	await assert.rejects(
		pageObservationResult({ inline: built.inline, artifact: built.artifact, maxChars: 128, outputPath: await outputPath("impossible.json"), fallbackName: "impossible.json" }),
		/PageObservation v3 cannot fit maxChars=128/,
	);
});
