import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPageObservation } from "../../src/commands/observe/scanProjection.ts";
import { pageObservationResult } from "../../src/commands/resultMiddleware.ts";
import { isPageObservationV3, isPageObservationView } from "../../src/validation/pageContracts.ts";
import { OBSERVATION_RESOURCES_DETAIL_KEY, type ObservationResourceDescriptor } from "../../src/commands/observe/observationResources.ts";
import type { Entity } from "../../src/kernels/abml/entity.ts";
import { pruneObservationArtifacts } from "../../src/artifacts/artifactFiles.ts";

test("PageObservation returns a bounded view and keeps its canonical artifact", async () => {
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
		providerExecution: { causal: { planned: true, status: "executed", reservedMs: 500, actualMs: 20, bridgeRoundTrips: 2 } },
		causal: { sinceSeq: 0, requests: Array.from({ length: 4 }, (_, index) => ({ ref: `bp-ref://network/${index}`, url: `https://example.test/${index}` })) },
	});
	((built.causal as { requests: Array<Record<string, unknown>> }).requests[0]!).internalId = "hidden";
	const dir = await mkdtemp(path.join(tmpdir(), "browser-pilot-observe-"));
	const outputPath = path.join(dir, ".browser-pilot", "artifacts", "observation.json");
	await mkdir(path.dirname(outputPath), { recursive: true });
	const result = await pageObservationResult({ observation: built, artifactPath: outputPath, fallbackName: "observation.json" });
	const inline = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
	const artifact = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
	const resources = result.details?.[OBSERVATION_RESOURCES_DETAIL_KEY] as ObservationResourceDescriptor[];

	assert.equal(isPageObservationView(inline), true);
	assert.equal(isPageObservationV3(artifact), true);
	assert.equal(artifact.canonical, true);
	assert.deepEqual(inline.target, { url: "https://example.test/" });
	assert.equal((artifact.snapshot as Record<string, unknown>).browserSessionId, "session-1");
	for (const key of ["schema", "tool", "model", "canonical", "snapshot", "providers", "diagnostics"]) assert.equal(inline[key], undefined);
	assert.equal((inline.content as { text?: string }).text, "Install dependencies");
	assert.equal((inline.content as { complete?: boolean }).complete, false);
	assert.equal((artifact.content as { text?: string }).text, "Introduction Install dependencies Verify the build");
	assert.equal(((inline.causal as { requests: unknown[] }).requests).length, 3);
	assert.equal((inline.causal as Record<string, unknown>).sinceSeq, undefined);
	assert.equal(JSON.stringify(inline.causal).includes("internalId"), false);
	assert.equal(((artifact.causal as { requests: unknown[] }).requests).length, 4);
	assert.equal(resources.length, 3);
	assert.equal(resources.some((resource) => resource.kind === "details" && resource.jsonPath === "causal"), true);
	assert.ok(resources.every((resource) => resource.uri.startsWith("browser-pilot://observation/") && resource.path === path.resolve(outputPath)));
	assert.equal("saved" in inline, false);
	assert.equal("limits" in inline, false);
	assert.equal("continuation" in inline, false);
	assert.equal(result.content[0]?.text.includes("\n"), false);
});

test("public observation keeps one decision shape for inference, relations, and structural changes", async () => {
	const sourceRef = "bp-ref://control/source";
	const targetRef = "bp-ref://region/target";
	const built = buildPageObservation({ summary: {}, entities: [], content: "Changed", snapshot: { snapshotId: "decision-shape", sourceMode: "scan", capturedAt: 1, ttlMs: 30_000 }, abmlIntegrated: true, diagnostics: {} });
	built.relations = { summary: { controls: 1, internal: -1 }, highlights: [{ type: "controls", sourceRef, targetRef, source: "ax" }] };
	built.inference = { intents: [{ intent: "dialog", confidence: "high", reason: "visible dialog", evidence: { dialogRef: targetRef, internalCount: 1 } }] };
	built.causal = { unavailable: "causal provider deadline exhausted" };
	built.treeDiff = {
		summary: { templateCount: 1, changedTemplateCount: 1, appeared: 1, disappeared: 0, changed: 0, reordered: 0 },
		templates: [{ templateKey: "internal-template", role: "dialog", kind: "region", beforeCount: 0, afterCount: 1, appeared: { count: 1, instances: [{ key: "name:Dialog", ref: targetRef, anchor: "name", confidence: "high", name: "Dialog" }] }, disappeared: { count: 0, instances: [] }, changed: { count: 0, instances: [] } }],
	};
	(built.treeDiff.summary as unknown as Record<string, unknown>).internalCount = 1;
	const dir = await mkdtemp(path.join(tmpdir(), "browser-pilot-observe-decision-"));
	const outputPath = path.join(dir, ".browser-pilot", "artifacts", "observation.json");
	const result = await pageObservationResult({ observation: built, artifactPath: outputPath, fallbackName: "observation.json" });
	const inline = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
	const resources = result.details?.[OBSERVATION_RESOURCES_DETAIL_KEY] as ObservationResourceDescriptor[];

	assert.deepEqual(inline.relations, { summary: { controls: 1 }, highlights: [{ type: "controls", sourceRef, targetRef }] });
	assert.deepEqual(inline.inference, { intents: [{ intent: "dialog", confidence: "high", reason: "visible dialog", refs: [targetRef] }] });
	assert.deepEqual(inline.causal, { unavailable: "Recent request activity was unavailable." });
	assert.deepEqual(inline.treeDiff, { summary: { templateCount: 1, changedTemplateCount: 1, appeared: 1, disappeared: 0, changed: 0, reordered: 0 } });
	assert.ok(resources.some((resource) => resource.jsonPath === "treeDiff"));
	assert.equal(JSON.stringify(inline).includes("internal-template"), false);
});

test("observation artifacts retain only a recent bounded window", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "browser-pilot-observe-retention-"));
	try {
		const artifacts = path.join(dir, ".browser-pilot", "artifacts");
		await mkdir(artifacts, { recursive: true });
		const files = Array.from({ length: 258 }, (_, index) => path.join(artifacts, `observe-scan-${index}.json`));
		await Promise.all(files.map((file) => writeFile(file, "{}")));
		const old = files[0]!;
		const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		await utimes(old, oldTime, oldTime);
		const current = files.at(-1)!;
		const currentPng = current.replace(/\.json$/, ".png");
		await writeFile(currentPng, "png");
		await pruneObservationArtifacts(current);
		assert.equal((await readdir(artifacts)).filter((name) => name.startsWith("observe-")).length, 256);
		await assert.rejects(() => access(old));
		await access(current);
		await access(currentPng);
		const visualEffect = path.join(artifacts, "visual-effect-1.png");
		await writeFile(visualEffect, "png");
		await pruneObservationArtifacts(visualEffect);
		assert.equal((await readdir(artifacts)).filter((name) => name.startsWith("observe-") || name.startsWith("visual-effect-")).length, 256);
		await access(visualEffect);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("agent PageObservation view hides internal baseline and re-anchor bookkeeping", async () => {
	const built = buildPageObservation({
		summary: { delta: "session", baselineSnapshotId: "baseline-1", reanchorReason: "session_changed" },
		entities: [],
		content: "Changed content",
		url: "https://example.test/changed",
		snapshot: { snapshotId: "snapshot-delta", sourceMode: "scan", capturedAt: 2, ttlMs: 300_000 },
		abmlIntegrated: true,
		diagnostics: { baseline: { reanchorReason: "session_changed" } },
	});
	const dir = await mkdtemp(path.join(tmpdir(), "browser-pilot-observe-delta-"));
	const outputPath = path.join(dir, ".browser-pilot", "artifacts", "observation.json");
	await mkdir(path.dirname(outputPath), { recursive: true });
	const result = await pageObservationResult({ observation: built, artifactPath: outputPath, fallbackName: "observation.json" });
	const inline = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
	const artifact = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;

	for (const key of ["baselineSnapshotId", "delta", "reanchorReason"]) assert.equal(inline[key], undefined);
	assert.equal(inline.diagnostics, undefined);
	assert.equal(artifact.baselineSnapshotId, "baseline-1");
	assert.equal(artifact.delta, "session");
	assert.equal(artifact.reanchorReason, "session_changed");
});

test("canonical PageObservation keeps the full entity graph and returns every captured action when it fits", async () => {
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
		diagnostics: { observeTimings: { axNodeCount: 2_000 }, providerFailures: [{ provider: "visual", code: "VISUAL_CAPTURE_FAILED" }], warnings: ["degraded"] },
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
	assert.deepEqual(inline.warnings, ["Requested visual evidence was unavailable.", "degraded"]);
	assert.equal(((inline.actionSpace as { items: unknown[] }).items).length, 20);
	assert.deepEqual((inline.actionSpace as { coverage: unknown }).coverage, { captured: 20, captureComplete: true });
});

test("action coverage preserves an incomplete empty capture", () => {
	const observation = buildPageObservation({
		summary: { focus: {} },
		entities: [],
		content: "",
		actionCaptureComplete: false,
		snapshot: { snapshotId: "empty-actions", sourceMode: "scan", capturedAt: 1, ttlMs: 300_000 },
		abmlIntegrated: true,
		diagnostics: {},
	});

	assert.deepEqual(observation.actionSpace?.coverage, { captured: 0, captureComplete: false });
	assert.deepEqual(observation.actionSpace?.items, []);
});

test("every captured action is inline or reachable through the action-space frontier", async () => {
	const state = { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true };
	const entities: Entity[] = Array.from({ length: 320 }, (_, index) => ({
		ref: `bp-ref://element/action-${index}`,
		kind: "element",
		role: "span",
		name: `Action ${index} ${"decision context ".repeat(8)}`,
		state,
		actionability: { actions: ["click"], hint: `activate item ${index}`, confidence: "high" },
		source: "dom",
	}));
	const built = buildPageObservation({
		summary: { focus: { primary_entities: entities.slice(0, 10).map((entity) => entity.ref) } },
		entities,
		content: "Large action space",
		actionCaptureComplete: false,
		url: "https://example.test/actions",
		snapshot: { snapshotId: "snapshot-actions", sourceMode: "scan", capturedAt: Date.now(), ttlMs: 300_000 },
		abmlIntegrated: true,
		diagnostics: {},
	});
	const dir = await mkdtemp(path.join(tmpdir(), "browser-pilot-observe-actions-"));
	const outputPath = path.join(dir, ".browser-pilot", "artifacts", "observation.json");
	await mkdir(path.dirname(outputPath), { recursive: true });
	const result = await pageObservationResult({ observation: built, artifactPath: outputPath, fallbackName: "observation.json" });
	const inline = JSON.parse(result.content[0]?.text ?? "{}") as { actionSpace: { coverage: { captured: number; captureComplete: boolean }; items: Array<{ ref: string }> }; frontier: { items: Array<{ ref: string; resourceUri?: string }> } };
	const artifact = JSON.parse(await readFile(outputPath, "utf8")) as { actionSpace: { items: Array<{ ref: string }> } };
	const resources = result.details?.[OBSERVATION_RESOURCES_DETAIL_KEY] as ObservationResourceDescriptor[];
	const continuation = resources.find((resource) => resource.kind === "action-space" && resource.jsonPath === "actionSpace");
	const inlineRefs = new Set(inline.actionSpace.items.map((item) => item.ref));
	const artifactRefs = new Set(artifact.actionSpace.items.map((item) => item.ref));

	assert.equal(inline.actionSpace.coverage.captured, entities.length);
	assert.equal(inline.actionSpace.coverage.captureComplete, false);
	assert.ok(inline.actionSpace.items.length < inline.actionSpace.coverage.captured);
	assert.equal(artifact.actionSpace.items.length, entities.length);
	assert.ok(continuation);
	assert.ok(inline.frontier.items.some((item) => item.ref === "frontier:action-space" && item.resourceUri === continuation?.uri));
	for (const entity of entities) assert.ok(inlineRefs.has(entity.ref) || artifactRefs.has(entity.ref), `unreachable action: ${entity.ref}`);
	assert.ok(Buffer.byteLength(result.content[0]?.text ?? "", "utf8") <= 32 * 1024);
});

test("action projection prefers DOM scope while preserving independent AX structure", () => {
	const entity: Entity = {
		ref: "bp-ref://element/like",
		kind: "element",
		role: "span",
		state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true },
		actionability: { actions: ["click"], confidence: "medium" },
		scope: { key: "#feed > article", name: "Feed", position: 1, size: 20 },
		structure: { posInSet: 5, setSize: 100 },
		hints: { containerKey: "ax:list", containerRole: "list", containerName: "AX list" },
		source: "dom",
	};
	const observation = buildPageObservation({ summary: { focus: {} }, entities: [entity], content: "Feed", url: "https://example.test/", snapshot: { snapshotId: "scope", sourceMode: "scan", capturedAt: 1, ttlMs: 300_000 }, abmlIntegrated: true, diagnostics: {} });
	assert.deepEqual(observation.actionSpace?.scopes, [{ id: "scope-1", name: "Feed", size: 20 }]);
	assert.deepEqual(observation.actionSpace?.items[0]?.scope, { id: "scope-1", position: 1 });
	assert.deepEqual(observation.entities?.[0]?.structure, { posInSet: 5, setSize: 100 });
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
	const inline = JSON.parse(result.content[0]?.text ?? "{}") as { snapshotProjection?: unknown; collections?: unknown[]; frontier?: { items?: Array<{ ref?: string }> } };

	assert.equal(inline.snapshotProjection, undefined);
	assert.equal(inline.collections?.length, 12);
	assert.ok(inline.frontier?.items?.some((item) => item.ref === "frontier:details:structure"));
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

test("canonical PageObservation keeps truncated root content expandable", async () => {
	const content = "content ".repeat(1_000);
	const built = buildPageObservation({
		summary: {}, entities: [], content, url: "https://example.test/long",
		snapshot: { snapshotId: "snapshot-long", sourceMode: "scan", capturedAt: Date.now(), ttlMs: 300_000 },
		abmlIntegrated: true, diagnostics: {},
	});
	built.collections = Array.from({ length: 12 }, (_, index) => ({
		ref: `bp-ref://collection/${index}`, kind: "list", observed: 4, completeness: "complete", confidence: "high",
		itemRefs: Array.from({ length: 4 }, (_item, itemIndex) => `bp-ref://element/${index}-${itemIndex}`),
	}));
	const dir = await mkdtemp(path.join(tmpdir(), "browser-pilot-observe-long-"));
	const outputPath = path.join(dir, ".browser-pilot", "artifacts", "observation.json");
	await mkdir(path.dirname(outputPath), { recursive: true });
	const result = await pageObservationResult({ observation: built, artifactPath: outputPath, fallbackName: "observation.json" });
	const inline = JSON.parse(result.content[0]?.text ?? "{}") as { content?: { text?: string; complete?: boolean }; frontier?: { items?: Array<{ ref?: string; observed?: number; total?: number }> } };
	const resources = result.details?.[OBSERVATION_RESOURCES_DETAIL_KEY] as ObservationResourceDescriptor[];

	assert.equal(inline.content?.text?.length, 6_000);
	assert.equal(inline.content?.complete, false);
	assert.deepEqual(inline.frontier?.items?.find((item) => item.ref === "frontier:content:root"), { ref: "frontier:content:root", kind: "content", state: "folded", label: "Page content", observed: 6_000, total: content.trim().length, resourceUri: resources.find((resource) => resource.ref === "frontier:content:root")?.uri });
	assert.equal(resources.find((resource) => resource.ref === "frontier:content:root")?.contentSection, 0);
});

test("PageObservation schema guards reject incomplete frontiers and negative collection counts", () => {
	const base = {
		schema: "browser-page-observation/v3",
		tool: "browser_observe",
		model: "PageObservation",
		canonical: true,
		target: {},
		snapshot: { snapshotId: "snapshot-contract", sourceMode: "scan", capturedAt: 1, ttlMs: 1 },
		providers: {},
	};
	assert.equal(isPageObservationV3({ ...base, frontier: { items: [{ ref: "content", kind: "content", state: "folded" }] } }), false);
	assert.equal(isPageObservationV3({ ...base, frontier: { items: [] }, collections: [{ ref: "c", kind: "list", observed: -1, completeness: "complete", confidence: "high", itemRefs: [] }] }), false);
});

test("PageObservation keeps one bounded visual observation in canonical and public views", async () => {
	const visual = {
		ref: "bp-ref://region/visual-1",
		resourceUri: "browser-pilot://artifact/observe-scan-1.png",
		captureMethod: "persistent_cdp",
		actionableGrounding: true,
		coordinateSpace: "normalized-image" as const,
		image: { width: 1280, height: 720, sha256: "a".repeat(64) },
		basis: { observationId: "visual-1", changeSeq: 2, url: "https://example.test/", scrollX: 0, scrollY: 0, viewportWidth: 1280, viewportHeight: 720, devicePixelRatio: 1, imageToCss: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number] },
		targets: [{ ref: "bp-ref://control/save", box: { x: 0.1, y: 0.2, w: 0.2, h: 0.1 } }],
	};
	const built = buildPageObservation({ summary: {}, entities: [], content: "Visual page", visual, snapshot: { snapshotId: "visual-1", sourceMode: "scan", capturedAt: 1, ttlMs: 30_000 }, abmlIntegrated: true, diagnostics: {} });
	const dir = await mkdtemp(path.join(tmpdir(), "browser-pilot-observe-visual-"));
	try {
		const outputPath = path.join(dir, ".browser-pilot", "artifacts", "observe-scan-1.json");
		const result = await pageObservationResult({ observation: built, artifactPath: outputPath, fallbackName: "observe-scan-1.json" });
		const inline = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
		const artifact = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
			assert.deepEqual(inline.visual, {
				ref: visual.ref,
				resourceUri: visual.resourceUri,
				actionableGrounding: true,
				coordinateSpace: "normalized-image",
				image: { width: 1280, height: 720 },
				targets: visual.targets,
			});
		assert.deepEqual(artifact.visual, visual);
		assert.equal(isPageObservationView(inline), true);
		assert.equal(isPageObservationV3(artifact), true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
