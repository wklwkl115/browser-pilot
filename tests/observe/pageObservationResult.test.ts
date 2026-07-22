import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPageObservation } from "../../src/commands/observe/scanProjection.ts";
import { pageObservationResult } from "../../src/commands/resultMiddleware.ts";
import { isPageObservationV3 } from "../../src/kernels/abml/pageObservation.ts";
import { OBSERVATION_RESOURCES_DETAIL_KEY, type ObservationResourceDescriptor } from "../../src/commands/observe/observationResources.ts";
import type { Entity } from "../../src/kernels/abml/entity.ts";

test("canonical PageObservation returns its first semantic region and opaque MCP resources", async () => {
	const built = buildPageObservation({
		summary: { focus: { gist: { title: "Example" } } },
		entities: [],
		content: "Introduction Install dependencies Verify the build",
		headings: ["Install dependencies", "Verify the build"],
		url: "https://example.test/",
		activeTabId: 7,
		snapshot: { snapshotId: "snapshot-1", browserSessionId: "session-1", tabId: 7, targetGeneration: 2, pageEpoch: "page-1", sourceMode: "scan", capturedAt: 1, ttlMs: 300_000 },
		abmlIntegrated: true,
		diagnostics: {},
		causal: { sinceSeq: 0, requests: Array.from({ length: 4 }, (_, index) => ({ ref: `bp-ref://network/${index}`, url: `https://example.test/${index}` })) },
	});
	const dir = await mkdtemp(path.join(tmpdir(), "browser-pilot-observe-"));
	const outputPath = path.join(dir, ".browser-pilot", "artifacts", "observation.json");
	await mkdir(path.dirname(outputPath), { recursive: true });
	const result = await pageObservationResult({ observation: built, artifactPath: outputPath, fallbackName: "observation.json" });
	const inline = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
	const artifact = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
	const resources = result.details?.[OBSERVATION_RESOURCES_DETAIL_KEY] as ObservationResourceDescriptor[];

	assert.equal(isPageObservationV3(inline), true);
	assert.equal(isPageObservationV3(artifact), true);
	assert.deepEqual(inline.target, { url: "https://example.test/" });
	assert.equal("browserSessionId" in (inline.snapshot as Record<string, unknown>), false);
	assert.equal((artifact.snapshot as Record<string, unknown>).browserSessionId, "session-1");
	assert.equal((inline.content as { text?: string }).text, "Install dependencies");
	assert.equal((inline.content as { complete?: boolean }).complete, false);
	assert.equal((artifact.content as { text?: string }).text, "Introduction Install dependencies Verify the build");
	assert.equal(((inline.causal as { requests: unknown[] }).requests).length, 3);
	assert.equal(((artifact.causal as { requests: unknown[] }).requests).length, 4);
	assert.equal(resources.length, 3);
	assert.equal(resources.some((resource) => resource.kind === "details" && resource.jsonPath === "causal"), true);
	assert.ok(resources.every((resource) => resource.uri.startsWith("browser-pilot://observation/") && resource.path === path.resolve(outputPath)));
	assert.equal("saved" in inline, false);
	assert.equal("limits" in inline, false);
	assert.equal("continuation" in inline, false);
	assert.equal(result.content[0]?.text.includes("\n"), false);
});

test("canonical PageObservation keeps the full entity graph in its artifact and bounds the agent projection", async () => {
	const state = { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true };
	const entities: Entity[] = Array.from({ length: 500 }, (_, index) => ({
		ref: `bp-ref://element/${index}`,
		kind: index < 20 ? "control" : "element",
		role: index < 20 ? "button" : "generic",
		name: `Entity ${index} ${"detail ".repeat(12)}`,
		state,
		source: "ax",
		locators: [{ by: "textAnchor", value: `Entity ${index}`, role: index < 20 ? "button" : "generic", exact: false }],
		geometry: { box: { x: index, y: index, w: 100, h: 20 }, point: { x: index + 50, y: index + 10 } },
		hints: { selector: `.entity-${index}`, diagnostic: "internal" },
	}));
	const built = buildPageObservation({
		summary: { focus: { gist: { controlCount: 20 }, primary_entities: entities.slice(0, 10).map((entity) => entity.ref) } },
		entities,
		content: "Example page Main content",
		headings: ["Example page", "Main content"],
		url: "https://example.test/large",
		activeTabId: 7,
		snapshot: { snapshotId: "snapshot-large", sourceMode: "scan", capturedAt: Date.now(), ttlMs: 300_000 },
		abmlIntegrated: true,
		diagnostics: { observeTimings: { axNodeCount: 2_000 }, warnings: ["degraded"] },
	});
	const dir = await mkdtemp(path.join(tmpdir(), "browser-pilot-observe-large-"));
	const outputPath = path.join(dir, ".browser-pilot", "artifacts", "observation.json");
	await mkdir(path.dirname(outputPath), { recursive: true });
	const result = await pageObservationResult({ observation: built, artifactPath: outputPath, fallbackName: "observation.json" });
	const inline = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
	const artifact = JSON.parse(await readFile(outputPath, "utf8")) as { entities?: unknown[] };

	assert.equal(inline.entities, undefined);
	assert.equal(artifact.entities?.length, 500);
	assert.ok(Buffer.byteLength(result.content[0]?.text ?? "", "utf8") <= 32 * 1024);
	assert.deepEqual(inline.diagnostics, { warnings: ["degraded"] });
	assert.equal((inline.actionables as unknown[]).length, 10);
});

test("canonical PageObservation bounds repeated structure summaries", async () => {
	const built = buildPageObservation({
		summary: {}, entities: [], content: "Example page Main content", headings: ["Example page", "Main content"], url: "https://example.test/structures",
		snapshot: { snapshotId: "snapshot-structures", sourceMode: "scan", capturedAt: Date.now(), ttlMs: 300_000 },
		abmlIntegrated: true, diagnostics: {},
	});
	built.snapshotProjection = {
		summary: { templateCount: 100, instanceCount: 400, projectedInstanceRefCount: 400 },
		templates: Array.from({ length: 100 }, (_, index) => ({
			templateKey: `template-${index}`, role: "listitem", kind: "element" as const, count: 4, varies: [], constant: {},
			instanceRefs: Array.from({ length: 4 }, (_item, itemIndex) => `bp-ref://element/${index}-${itemIndex}`), instanceRefCount: 4,
		})),
	};
	built.collections = Array.from({ length: 100 }, (_, index) => ({
		ref: `bp-ref://collection/${index}`, kind: "list", name: `Collection ${index}`, observed: 4,
		completeness: "complete", confidence: "high", itemRefs: Array.from({ length: 4 }, (_item, itemIndex) => `bp-ref://element/${index}-${itemIndex}`),
	}));
	const dir = await mkdtemp(path.join(tmpdir(), "browser-pilot-observe-structures-"));
	const outputPath = path.join(dir, ".browser-pilot", "artifacts", "observation.json");
	await mkdir(path.dirname(outputPath), { recursive: true });
	const result = await pageObservationResult({ observation: built, artifactPath: outputPath, fallbackName: "observation.json" });
	const inline = JSON.parse(result.content[0]?.text ?? "{}") as { snapshotProjection?: { templates?: unknown[] }; collections?: unknown[]; frontier?: { items?: Array<{ ref?: string }> } };

	assert.equal(inline.snapshotProjection?.templates?.length, 12);
	assert.equal(inline.collections?.length, 12);
	assert.ok(inline.frontier?.items?.some((item) => item.ref === "frontier:templates:unavailable"));
	assert.ok(inline.frontier?.items?.some((item) => item.ref === "frontier:collections:unavailable"));
	assert.ok(Buffer.byteLength(result.content[0]?.text ?? "", "utf8") <= 32 * 1024);
});

test("canonical PageObservation selects intent-relevant content and bounds frontier resources", async () => {
	const headings = Array.from({ length: 30 }, (_, index) => `Section ${index}`);
	const content = `Navigation ${headings.map((heading) => `${heading} Content for ${heading}.`).join(" ")}`;
	const built = buildPageObservation({
		summary: {}, entities: [], content, headings, url: "https://example.test/sections",
		snapshot: { snapshotId: "snapshot-sections", sourceMode: "scan", capturedAt: Date.now(), ttlMs: 300_000 },
		abmlIntegrated: true, diagnostics: {},
	});
	const dir = await mkdtemp(path.join(tmpdir(), "browser-pilot-observe-sections-"));
	const outputPath = path.join(dir, ".browser-pilot", "artifacts", "observation.json");
	await mkdir(path.dirname(outputPath), { recursive: true });
	const result = await pageObservationResult({ observation: built, artifactPath: outputPath, fallbackName: "observation.json", intent: "Section 23" });
	const inline = JSON.parse(result.content[0]?.text ?? "{}") as { content?: { text?: string }; frontier?: { items?: Array<{ ref?: string }> } };
	const resources = result.details?.[OBSERVATION_RESOURCES_DETAIL_KEY] as ObservationResourceDescriptor[];

	assert.match(inline.content?.text ?? "", /^Section 23\b/);
	assert.ok(resources.length <= 12);
	assert.ok(inline.frontier?.items?.some((item) => item.ref === "frontier:budget"));
});
