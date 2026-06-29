import assert from "node:assert/strict";
import test from "node:test";
import {
	attachAbmlArtifactHints,
	buildObserveAbmlDetails,
	buildObserveArtifactProjection,
	buildPageObservation,
	buildPageObservationProviders,
	buildScanNextActionHints,
} from "../../src/commands/observe/scanProjection.ts";
import { cachedEnvelopeFromArtifact } from "../../src/commands/observe/renderCache.ts";
import { cachedObserveResultFromEnvelope } from "../../src/commands/observe/scanRunner.ts";
import { factsFromObservedEntities, stableRefsFromCommandFrames } from "../../src/commands/observe/perceptionLedgerProjection.ts";
import type { Entity } from "../../src/kernels/abml/entity.ts";
import type { TreeDiff } from "../../src/kernels/abml/treeDiff.ts";
import { getJsonPath } from "../../src/utils/jsonPath.ts";

const buttonEntity: Entity = {
	ref: "bp-ref://element/button/submit",
	kind: "control",
	role: "button",
	name: "Submit",
	state: {},
	source: "ax",
};

const listEntity: Entity = {
	ref: "bp-ref://region/list/results",
	kind: "region",
	role: "list",
	name: "Results",
	state: {},
	source: "dom",
	hints: { listContainer: true },
};

const visualEntity: Entity = {
	ref: "bp-ref://region/vision/banner",
	kind: "region",
	role: "banner",
	name: "Hero",
	state: {},
	source: "vision",
};

const frameEntity: Entity = {
	ref: "bp-ref://frame/checkout",
	kind: "frame",
	role: "frame",
	name: "Checkout Frame",
	state: {},
	source: "dom",
};

function changedTreeDiff(): TreeDiff {
	return {
		summary: {
			templateCount: 4,
			appeared: 2,
			disappeared: 1,
			changed: 1,
			reordered: 0,
			changedTemplateCount: 4,
			sample: {
				appeared: ["New CTA", "New row", "Ignored extra"],
				disappeared: ["Old CTA"],
				changed: ["Price"],
			},
		},
		templates: [],
	};
}

test("observe scan characterization: ABML detail projection keeps integrated and non-integrated counts", () => {
	const diagnostics = { bridgeRoundTrips: 3 };
	assert.deepEqual(buildObserveAbmlDetails({ abmlRead: { ok: false }, diagnostics }), { integrated: false, diagnostics });
	assert.deepEqual(buildObserveAbmlDetails({ abmlRead: { ok: true, entities: [buttonEntity, listEntity, visualEntity, frameEntity] }, diagnostics }), {
		integrated: true,
		entityCount: 4,
		primaryEntityCount: 1,
		listEntityCount: 1,
		visualRegionCount: 1,
		frameEntityCount: 1,
		diagnostics,
	});
});

test("observe scan characterization: next action hints cover baseline, causal, and treeDiff contracts", () => {
	assert.deepEqual(buildScanNextActionHints({ hasBaseline: false, snapshotId: "snap-1", recorderActive: true }), [
		"to see what CHANGES after you act here: re-run browser_observe baselineSnapshotId:\"snap-1\" or browser_observe diff:true → envelope.treeDiff (template-level appeared/disappeared, cleaner than re-extracting before/after); + envelope.causal.requests = which requests your action fired",
	]);
	const hints = buildScanNextActionHints({
		hasBaseline: true,
		recorderActive: true,
		causal: { sinceSeq: 10, requestCount: 15, requests: [{ ref: "bp-ref://network-entry/11", url: "https://example.test/api", method: "POST" }] },
		treeDiff: changedTreeDiff(),
	});
	assert.equal(hints.length, 2);
	assert.equal(hints[0], "15 request(s) fired since baseline → read envelope.causal.requests (first 1 shown inline; full set via browser_network list) (action→request attribution)");
	assert.match(hints[1], /structure changed \(2 appeared \/ 1 disappeared \/ 1 changed, template-level\)/);
	assert.match(hints[1], /\+New CTA, New row, Ignored extra; -Old CTA; ~Price/);
});

test("observe scan characterization: artifact hints are added without duplicating preferred reads", () => {
	const summary = {
		artifact_hints: { jsonPaths: {}, preferredReads: [{ label: "existing", jsonPath: "envelope.collections" }] },
		collections: [{ id: "items" }],
		snapshotProjection: { root: "page" },
		identity: { backendNodeIdCount: 1 },
		focus: { relations: { summary: { controls: 1 } } },
	} as Record<string, unknown>;
	attachAbmlArtifactHints(summary);
	const hints = summary.artifact_hints as { jsonPaths: Record<string, string>; preferredReads: Array<{ jsonPath: string }> };
	assert.equal(hints.jsonPaths.collections, "envelope.collections");
	assert.equal(hints.jsonPaths.snapshotProjection, "envelope.snapshotProjection");
	assert.equal(hints.jsonPaths.relations, "envelope.relations");
	assert.equal(hints.jsonPaths.relationGraph, "envelope.relationGraph");
	assert.equal(hints.jsonPaths.identityGraph, "envelope.identityGraph");
	assert.equal(hints.preferredReads.filter((item) => item.jsonPath === "envelope.collections").length, 1);
});

test("observe scan characterization: artifact projection mirrors envelope fields and strips private summary graph keys", () => {
	const relationGraph = { edgeCount: 1 };
	const identityGraph = { nodes: [{ ref: buttonEntity.ref }] };
	const summary = {
		abmlIntegrated: true,
		snapshotProjection: { root: buttonEntity.ref },
		collections: [{ ref: listEntity.ref }],
		_identityGraph: identityGraph,
		_relationGraph: relationGraph,
		focus: { relations: { summary: { controls: 1 } } },
	} as Record<string, unknown>;
	const diff = { appeared: [], disappeared: [], changed: [] };
	const causal = { sinceSeq: 1, requests: [{ ref: "bp-ref://network-entry/2" }] };
	const projection = buildObserveArtifactProjection({
		summaryRecord: summary,
		summary,
		envelopeEntities: [buttonEntity, listEntity],
		envelopeDiff: diff,
		abmlTreeDiff: changedTreeDiff(),
		artifactRelevance: { score: 0.9 },
		causalBlock: { causal },
		mode: "scan",
		hasNavigation: false,
	});
	assert.equal(Object.hasOwn(summary, "_identityGraph"), false);
	assert.equal(Object.hasOwn(summary, "_relationGraph"), false);
	assert.equal(projection.artifactEnvelopeMirror.tool, "browser_observe");
	assert.equal(projection.artifactEnvelopeMirror.command, "scan");
	assert.equal(projection.artifactEnvelopeMirror.summary, summary);
	assert.deepEqual(projection.artifactEnvelopeMirror.entities, [buttonEntity, listEntity]);
	assert.equal(projection.artifactEnvelopeMirror.diff, diff);
	assert.equal(projection.artifactEnvelopeMirror.treeDiff?.summary.changedTemplateCount, 4);
	assert.equal(projection.artifactEnvelopeMirror.relations, summary.focus.relations);
	assert.equal(projection.artifactEnvelopeMirror.relationGraph, relationGraph);
	assert.equal(projection.artifactEnvelopeMirror.snapshotProjection, summary.snapshotProjection);
	assert.deepEqual(projection.artifactEnvelopeMirror.collections, summary.collections);
	assert.equal(projection.artifactEnvelopeMirror.identityGraph, identityGraph);
	assert.equal(projection.artifactEnvelopeMirror.relevance?.score, 0.9);
	assert.equal(projection.artifactEnvelopeMirror.causal, causal);
});

test("observe scan characterization: canonical PageObservation keeps stable fused no-mode shape", () => {
	const diff = { appeared: [buttonEntity], disappeared: [], changed: [], summary: { changed: 1 } };
	const observation = buildPageObservation({
		mode: "scan",
		canonical: true,
		summary: {
			focus: {
				gist: { title: "Checkout", url: "https://example.test/checkout" },
				outline: [{ label: "Cart" }],
				primary_entities: [buttonEntity],
				relations: { summary: { controls: 1 } },
			},
			collections: [{ ref: listEntity.ref, complete: true }],
			memory: { facts: [{ id: "fact-1" }] },
		},
		entities: [buttonEntity, listEntity, visualEntity, frameEntity],
		content: `${"Readable checkout content ".repeat(80)}`,
		url: "https://example.test/checkout",
		tabs: [{ id: 7 }, { id: 8 }],
		activeTabId: 7,
		snapshot: { snapshotId: "snap-1", saved: { path: "artifacts/observe-snap-1.json" } },
		diff,
		treeDiff: changedTreeDiff(),
		causal: { sinceSeq: 1, requestCount: 1, requests: [{ ref: "bp-ref://network-entry/2", url: "https://example.test/api", method: "POST" }] },
		artifactPath: "artifacts/observe-snap-1.json",
		abmlIntegrated: true,
		diagnostics: { bridgeRoundTrips: 2 },
	});

	assert.equal(observation.model, "PageObservation");
	assert.equal(observation.canonical, true);
	assert.equal(observation.mode, "scan");
	assert.equal(observation.sourceMode, "scan");
	assert.deepEqual(observation.context, { url: "https://example.test/checkout", activeTabId: 7, tabCount: 2 });
	assert.deepEqual(observation.actionables, [buttonEntity]);
	assert.deepEqual(observation.refs, [buttonEntity.ref, listEntity.ref, visualEntity.ref, frameEntity.ref]);
	assert.equal((observation.content as { chars: number }).chars, "Readable checkout content ".repeat(80).length);
	assert.equal((observation.content as { artifact?: { jsonPath?: string } }).artifact?.jsonPath, "pageObservation.content");
	assert.equal((observation.text as { artifact?: { jsonPath?: string } }).artifact?.jsonPath, "pageObservation.text");
	assert.equal((observation.evidence as { artifact?: { jsonPath?: string } }).artifact?.jsonPath, "envelope");
	assert.equal(observation.diff, diff, "diff is preserved by reference");
	assert.equal((observation.treeDiff as TreeDiff).summary.changedTemplateCount, 4);
	assert.deepEqual((observation.diagnostics as { providers: Record<string, string> }).providers, {
		structure: "executed",
		content: "scan-backed",
		text: "scan-backed",
		html: "scan-backed",
		evidence: "scan-backed",
		tabs: "executed",
	});
	const artifactHints = observation.artifact_hints as { jsonPaths: Record<string, string>; preferredReads: Array<{ label: string; jsonPath: string }> };
	assert.equal(artifactHints.jsonPaths["response envelope"], "envelope");
	assert.equal(artifactHints.jsonPaths["saved observation artifact"], "pageObservation");
	assert.equal(artifactHints.jsonPaths["raw scan evidence"], "data");
	assert.equal(artifactHints.jsonPaths["saved observation content"], "pageObservation.content");
	assert.equal(artifactHints.jsonPaths["saved observation text"], "pageObservation.text");
	assert.deepEqual(artifactHints.preferredReads.map((read) => read.jsonPath), [
		"envelope",
		"pageObservation",
		"data",
		"pageObservation.content",
		"pageObservation.text",
	]);
});

test("observe scan characterization: canonical artifact jsonPaths are readable against saved artifact root", () => {
	const observation = buildPageObservation({
		mode: "scan",
		canonical: true,
		summary: { focus: { primary_entities: [buttonEntity] } },
		entities: [buttonEntity],
		content: "Readable checkout content",
		url: "https://example.test/checkout",
		tabs: [{ id: 7 }],
		activeTabId: 7,
		snapshot: { snapshotId: "snap-1" },
		artifactPath: "artifacts/observe-snap-1.json",
		abmlIntegrated: true,
		diagnostics: {},
	});
	const savedArtifactRoot = {
		data: { content: "Readable checkout content", actionables: [buttonEntity] },
		pageObservation: observation,
		envelope: { summary: { pageObservation: observation } },
	};
	const artifactHints = observation.artifact_hints as { jsonPaths: Record<string, string>; preferredReads: Array<{ label: string; jsonPath: string }> };
	const savedRootPaths = [
		(observation.content as { artifact?: { jsonPath?: string } }).artifact?.jsonPath,
		(observation.text as { artifact?: { jsonPath?: string } }).artifact?.jsonPath,
		...artifactHints.preferredReads.map((read) => read.jsonPath),
	].filter((path): path is string => typeof path === "string");
	assert.equal(savedRootPaths.some((jsonPath) => jsonPath.startsWith("result.data.")), false);
	for (const jsonPath of savedRootPaths) {
		assert.equal(getJsonPath(savedArtifactRoot, jsonPath).exists, true, `${jsonPath} should resolve against saved artifact root`);
	}
	assert.equal(getJsonPath(savedArtifactRoot, "pageObservation.content").exists, true);
	assert.equal(getJsonPath(savedArtifactRoot.envelope, "summary.pageObservation.content").exists, true);
	assert.equal(getJsonPath(savedArtifactRoot.envelope, "pageObservation.content").exists, false);
});

test("observe scan characterization: render cache restores only the final envelope artifact path", () => {
	const finalEnvelope = {
		tool: "browser_observe",
		command: "scan",
		summary: { pageObservation: { model: "PageObservation", canonical: true } },
		operation: { operationId: "op-final" },
		snapshot: { snapshotId: "snap-final" },
		saved: { path: "artifact.json" },
		fromCache: true,
		cache: { reason: "prior" },
	};
	const restored = cachedEnvelopeFromArtifact({ data: { content: "cached" }, envelope: finalEnvelope });
	assert.deepEqual(restored, {
		tool: "browser_observe",
		command: "scan",
		summary: { pageObservation: { model: "PageObservation", canonical: true } },
	});
	assert.equal(cachedEnvelopeFromArtifact({ tool: "browser_observe", command: "scan", summary: {} }), undefined);
});

test("observe scan characterization: render cache hit returns final PageObservation envelope without re-distillation", () => {
	const cacheMeta = { reason: "content-fingerprint-unchanged", changeSeq: 7, priorSnapshotId: "snap-prior" };
	const freshEnvelope = {
		tool: "browser_observe",
		command: "scan",
		detailLevel: "summary",
		summary: {
			model: "PageObservation",
			canonical: true,
			pageObservation: {
				model: "PageObservation",
				canonical: true,
				context: { url: "https://example.test", activeTabId: 1, tabCount: 1 },
			},
		},
		entities: [{ ref: "bp-ref://element/button/pay", kind: "control" }],
		operation: { operationId: "op-fresh", snapshotId: "snap-fresh" },
		snapshot: { snapshotId: "snap-fresh", sourceMode: "scan" },
	};
	const restored = cachedEnvelopeFromArtifact({ envelope: freshEnvelope });
	assert.ok(restored);
	const cachedSummary = restored.summary as Record<string, unknown>;
	const cachedPageObservation = { ...(cachedSummary.pageObservation as Record<string, unknown>) };
	cachedPageObservation.snapshot = { snapshotId: "snap-cache", sourceMode: "scan" };
	cachedPageObservation.diagnostics = { fromCache: true, cache: cacheMeta };
	const cachedEnvelope = {
		...restored,
		fromCache: true,
		cache: cacheMeta,
		delta: "session",
		baselineSnapshotId: "snap-prior",
		operation: { operationId: "op-cache", snapshotId: "snap-cache" },
		snapshot: { snapshotId: "snap-cache", sourceMode: "scan" },
		summary: {
			...cachedSummary,
			pageObservation: cachedPageObservation,
			fromCache: true,
			cache: cacheMeta,
			priorSnapshotId: "snap-prior",
		},
	};
	const result = cachedObserveResultFromEnvelope(cachedEnvelope, { fromCache: true, renderCache: { hit: true, ...cacheMeta } }, 20_000);
	const output = JSON.parse(result.content[0]?.text || "{}") as Record<string, unknown>;
	const summary = output.summary as Record<string, unknown>;
	const pageObservation = summary.pageObservation as Record<string, unknown>;
	assert.equal(output.tool, freshEnvelope.tool);
	assert.equal(output.command, freshEnvelope.command);
	assert.deepEqual(output.entities, freshEnvelope.entities);
	assert.equal(summary.model, "PageObservation");
	assert.equal(summary.canonical, true);
	assert.equal(pageObservation.model, "PageObservation");
	assert.equal(pageObservation.canonical, true);
	assert.equal(output.fromCache, true);
	assert.deepEqual(output.cache, cacheMeta);
	assert.equal(summary.fromCache, true);
	assert.deepEqual(summary.cache, cacheMeta);
	assert.deepEqual((pageObservation.diagnostics as Record<string, unknown>).cache, cacheMeta);
	assert.equal(summary.envelope, undefined);
	assert.equal(output.envelope, undefined);
});

test("observe scan characterization: canonical PageObservation remains stable when optional providers degrade", () => {
	const observation = buildPageObservation({
		mode: "scan",
		canonical: true,
		summary: {},
		entities: [],
		content: "",
		tabs: [],
		snapshot: { snapshotId: "snap-degraded" },
		abmlIntegrated: false,
		diagnostics: { providerFailures: [{ provider: "abml-read", code: "BACKEND_UNAVAILABLE" }] },
	});

	assert.equal(observation.model, "PageObservation");
	assert.equal(observation.canonical, true);
	assert.deepEqual(observation.entities, []);
	assert.deepEqual(observation.actionables, []);
	assert.deepEqual(observation.refs, []);
	assert.deepEqual(observation.context, { url: undefined, activeTabId: undefined, tabCount: 0 });
	assert.deepEqual((observation.diagnostics as { providers: Record<string, string> }).providers, {
		structure: "degraded",
		content: "skipped",
		text: "skipped",
		html: "skipped",
		evidence: "skipped",
		tabs: "degraded",
	});
	assert.deepEqual((observation.diagnostics as { providerFailures: unknown[] }).providerFailures, [{ provider: "abml-read", code: "BACKEND_UNAVAILABLE" }]);
});

test("observe scan characterization: provider diagnostics express truthful execution states", () => {
	assert.deepEqual(buildPageObservationProviders({ abmlIntegrated: true, contentLength: 12, artifactPath: "artifact.json", tabCount: 1 }), {
		structure: "executed",
		content: "scan-backed",
		text: "scan-backed",
		html: "scan-backed",
		evidence: "scan-backed",
		tabs: "executed",
	});
	assert.deepEqual(buildPageObservationProviders({ abmlIntegrated: false, contentLength: 0, tabCount: 0 }), {
		structure: "degraded",
		content: "skipped",
		text: "skipped",
		html: "skipped",
		evidence: "skipped",
		tabs: "degraded",
	});
});

test("observe scan characterization: ledger facts preserve stable refs across relation-only enrichment", () => {
	const priorFacts = factsFromObservedEntities([buttonEntity]);
	const enrichedEntity: Entity = { ...buttonEntity, relations: [{ type: "triggered", targetRef: "bp-ref://network-entry/2", source: "timing", confidence: "low" }] };
	const currentFacts = factsFromObservedEntities([enrichedEntity]);
	assert.notEqual(currentFacts[buttonEntity.ref]?.versionStamp, priorFacts[buttonEntity.ref]?.versionStamp);
	assert.equal(currentFacts[buttonEntity.ref]?.stableStamp, priorFacts[buttonEntity.ref]?.stableStamp);
	const stableRefs = stableRefsFromCommandFrames(
		{ key: { browserSessionId: "session-1", tabId: 1, navigationEpoch: "https://example.test" }, snapshotId: "snap-2", capturedAt: 2, facts: currentFacts },
		{ key: { browserSessionId: "session-1", tabId: 1, navigationEpoch: "https://example.test" }, snapshotId: "snap-1", capturedAt: 1, facts: priorFacts },
	);
	assert.deepEqual([...stableRefs], [buttonEntity.ref]);
});

test("observe scan characterization: provider diagnostics reflect tabs refresh degradation", () => {
	assert.deepEqual(buildPageObservationProviders({ abmlIntegrated: true, contentLength: 500, artifactPath: "a.json", tabCount: 3, tabsRefreshDegraded: true }), {
		structure: "executed",
		content: "scan-backed",
		text: "scan-backed",
		html: "scan-backed",
		evidence: "scan-backed",
		tabs: "degraded",
	}, "tabs refresh degraded falls back to getTabs → degraded, not executed");
	assert.deepEqual(buildPageObservationProviders({ abmlIntegrated: true, contentLength: 500, artifactPath: "a.json", tabCount: 3, tabsRefreshDegraded: false }), {
		structure: "executed",
		content: "scan-backed",
		text: "scan-backed",
		html: "scan-backed",
		evidence: "scan-backed",
		tabs: "executed",
	}, "tabs refresh succeeded → executed");
});

test("observe scan characterization: provider diagnostics reflect structFailed state", () => {
	assert.deepEqual(buildPageObservationProviders({ abmlIntegrated: false, contentLength: 0, tabCount: 1, structFailed: true }), {
		structure: "failed",
		content: "skipped",
		text: "skipped",
		html: "skipped",
		evidence: "skipped",
		tabs: "executed",
	}, "structFailed=true forces structure to failed even if abmlIntegrated is false");
});

test("observe scan characterization: provider diagnostics allow explicit status overrides for content/text/html/evidence", () => {
	assert.deepEqual(buildPageObservationProviders({
		abmlIntegrated: true,
		contentLength: 100,
		artifactPath: "a.json",
		tabCount: 2,
		contentStatus: "executed",
		textStatus: "failed",
		htmlStatus: "skipped",
		evidenceStatus: "degraded",
	}), {
		structure: "executed",
		content: "executed",
		text: "failed",
		html: "skipped",
		evidence: "degraded",
		tabs: "executed",
	}, "explicit status overrides replace scan-backed/skipped defaults");
});
