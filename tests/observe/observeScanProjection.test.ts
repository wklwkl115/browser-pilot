import assert from "node:assert/strict";
import test from "node:test";
import {
	attachAbmlArtifactHints,
	buildObserveAbmlDetails,
	buildObserveArtifactProjection,
	buildPageObservation,
	buildPageObservationProviders,
	buildProviderBudgetTelemetry,
	buildScanNextActionHints,
} from "../../src/commands/observe/scanProjection.ts";
import { cachedEnvelopeFromArtifact } from "../../src/commands/observe/renderCache.ts";
import { cachedObserveResultFromEnvelope } from "../../src/commands/observe/scanCache.ts";
import { factsFromObservedEntities, stableRefsFromCommandFrames } from "../../src/commands/observe/perceptionLedgerProjection.ts";
import type { Entity } from "../../src/kernels/abml/entity.ts";
import type { TreeDiff } from "../../src/kernels/abml/treeDiff.ts";
import { getJsonPath } from "../../src/utils/jsonPath.ts";

const defaultState: Entity["state"] = {
	visible: true,
	occluded: false,
	disabled: false,
	focused: false,
	editable: false,
	inViewport: true,
};

const buttonEntity: Entity = {
	ref: "bp-ref://element/button/submit",
	kind: "control",
	role: "button",
	name: "Submit",
	state: defaultState,
	source: "ax",
};

const listEntity: Entity = {
	ref: "bp-ref://region/list/results",
	kind: "region",
	role: "list",
	name: "Results",
	state: defaultState,
	source: "dom",
	hints: { listContainer: true },
};

const visualEntity: Entity = {
	ref: "bp-ref://region/vision/banner",
	kind: "region",
	role: "banner",
	name: "Hero",
	state: defaultState,
	source: "vision",
};

const frameEntity: Entity = {
	ref: "bp-ref://frame/checkout",
	kind: "frame",
	role: "frame",
	name: "Checkout Frame",
	state: defaultState,
	source: "dom",
};

function observationSnapshot(snapshotId: string, extra: Record<string, unknown> = {}) {
	return { snapshotId, sourceMode: "scan", capturedAt: 1, ttlMs: 300_000, ...extra };
}

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
		"after acting, use browser_observe diff:true only if the next decision needs fresh state; inspect treeDiff and causal.requests",
	]);
	const hints = buildScanNextActionHints({
		hasBaseline: true,
		recorderActive: true,
		causal: { sinceSeq: 10, requestCount: 15, requests: [{ ref: "bp-ref://network-entry/11", url: "https://example.test/api", method: "POST" }] },
		treeDiff: changedTreeDiff(),
	});
	assert.equal(hints.length, 2);
	assert.equal(hints[0], "15 request(s) fired since baseline → read envelope.causal.requests (first 1 shown inline; full set via browser_network list) (action→request attribution)");
	assert.match(hints[1], /treeDiff: \+2\/-1\/~1 templates/);
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
	assert.equal(projection.artifactEnvelopeMirror.relations, (summary.focus as Record<string, unknown>).relations);
	assert.equal(projection.artifactEnvelopeMirror.relationGraph, relationGraph);
	assert.equal(projection.artifactEnvelopeMirror.snapshotProjection, summary.snapshotProjection);
	assert.deepEqual(projection.artifactEnvelopeMirror.collections, summary.collections);
	assert.equal(projection.artifactEnvelopeMirror.identityGraph, identityGraph);
	assert.equal(projection.artifactEnvelopeMirror.relevance?.score, 0.9);
	assert.equal(projection.artifactEnvelopeMirror.causal, causal);
});

test("observe scan characterization: canonical PageObservation keeps stable fused no-mode shape", () => {
	const diff = { appeared: [buttonEntity.ref], disappeared: [], changed: [] };
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
		},
		entities: [buttonEntity, listEntity, visualEntity, frameEntity],
		content: `${"Readable checkout content ".repeat(80)}`,
		url: "https://example.test/checkout",
		tabs: [{ id: 7 }, { id: 8 }],
		activeTabId: 7,
		snapshot: observationSnapshot("snap-1", { browserSessionId: "session-1", tabId: 7, targetGeneration: 3, pageEpoch: "page-1" }),
		diff,
		treeDiff: changedTreeDiff(),
		causal: { sinceSeq: 1, requestCount: 1, requests: [{ ref: "bp-ref://network-entry/2", url: "https://example.test/api", method: "POST" }] },
		artifactPath: "artifacts/observe-snap-1.json",
		abmlIntegrated: true,
		diagnostics: { bridgeRoundTrips: 2 },
	}).inline;

	assert.equal(observation.schema, "browser-page-observation/v3");
	assert.equal(observation.tool, "browser_observe");
	assert.equal(observation.model, "PageObservation");
	assert.equal(observation.canonical, true);
	assert.deepEqual(observation.target, {
		browserSessionId: "session-1",
		tabId: 7,
		targetGeneration: 3,
		pageEpoch: "page-1",
		url: "https://example.test/checkout",
	});
	assert.deepEqual(observation.actionables, [{ ref: buttonEntity.ref, kind: "control", name: "Submit", state: defaultState }]);
	assert.deepEqual(observation.entities, [buttonEntity, listEntity, visualEntity, frameEntity]);
	assert.equal(observation.diff, diff, "diff is preserved by reference");
	assert.equal((observation.treeDiff as TreeDiff).summary.changedTemplateCount, 4);
	assert.equal(observation.providers.structure?.status, "executed");
	assert.equal(observation.providers.content?.status, "scan-backed");
	assert.equal(observation.providers.causal?.status, "executed");
	assert.deepEqual(observation.frontier.items.map((item) => [item.kind, item.read?.jsonPath]), [
		["content", "diagnostics.content"],
		["diagnostics", "diagnostics"],
	]);
	for (const forbidden of ["summary", "evidence", "correlation", "templates", "text", "refs", "content"]) {
		assert.equal(Object.hasOwn(observation, forbidden), false, `${forbidden} must not be mirrored on PageObservation v3`);
	}
});

test("observe scan characterization: canonical artifact jsonPaths are readable against saved artifact root", () => {
	const built = buildPageObservation({
		mode: "scan",
		canonical: true,
		summary: { focus: { primary_entities: [buttonEntity] } },
		entities: [buttonEntity],
		content: "Readable checkout content",
		url: "https://example.test/checkout",
		tabs: [{ id: 7 }],
		activeTabId: 7,
		snapshot: observationSnapshot("snap-1"),
		artifactPath: "artifacts/observe-snap-1.json",
		abmlIntegrated: true,
		diagnostics: {},
	});
	const savedArtifactRoot = built.artifact;
	const savedRootPaths = built.inline.frontier.items.flatMap((item) => item.read ? [item.read.jsonPath] : []);
	assert.equal(savedRootPaths.length > 0, true);
	for (const jsonPath of savedRootPaths) assert.equal(getJsonPath(savedArtifactRoot, jsonPath).exists, true, `${jsonPath} should resolve against saved artifact root`);
	assert.equal(Object.hasOwn(savedArtifactRoot, "pageObservation"), false);
	assert.equal(Object.hasOwn(savedArtifactRoot, "envelope"), false);
});

test("observe scan characterization: render cache accepts only the final PageObservation v3 root", () => {
	const root = buildPageObservation({
		mode: "scan", canonical: true, summary: {}, entities: [], content: "cached", tabs: [], snapshot: observationSnapshot("snap-final"), abmlIntegrated: true, diagnostics: {},
	}).artifact;
	const restored = cachedEnvelopeFromArtifact(root);
	assert.equal(restored?.schema, "browser-page-observation/v3");
	assert.equal(restored?.tool, "browser_observe");
	assert.equal(restored?.canonical, true);
	assert.equal(cachedEnvelopeFromArtifact({ envelope: root }), undefined);
	assert.equal(cachedEnvelopeFromArtifact({ tool: "browser_observe", command: "scan", summary: {} }), undefined);
});

test("observe scan characterization: render cache hit renders a single PageObservation v3 root with exact cost", () => {
	const cacheMeta = { reason: "content-fingerprint-unchanged", changeSeq: 7, priorSnapshotId: "snap-prior" };
	const cachedRoot = buildPageObservation({
		mode: "scan", canonical: true, summary: { delta: "session", baselineSnapshotId: "snap-prior" }, entities: [buttonEntity], content: "cached", url: "https://example.test", tabs: [{ id: 1 }], activeTabId: 1, snapshot: observationSnapshot("snap-cache"), abmlIntegrated: true, diagnostics: { fromCache: true, cache: cacheMeta },
	}).inline;
	const result = cachedObserveResultFromEnvelope(cachedRoot as unknown as Record<string, unknown>, { fromCache: true, renderCache: { hit: true, ...cacheMeta } }, 20_000);
	const output = JSON.parse(result.content[0]?.text || "{}") as Record<string, unknown>;
	assert.equal(output.schema, "browser-page-observation/v3");
	assert.equal(output.tool, "browser_observe");
	assert.equal(output.model, "PageObservation");
	assert.equal(output.delta, "session");
	assert.equal(output.baselineSnapshotId, "snap-prior");
	assert.deepEqual((output.diagnostics as Record<string, unknown>).cache, cacheMeta);
	assert.equal(Object.hasOwn(output, "summary"), false);
	const limits = output.limits as { cost: { chars: number; bytes: number; estimatedTokens: number } };
	assert.equal(limits.cost.chars, result.content[0]?.text.length);
	assert.equal(limits.cost.bytes, Buffer.byteLength(result.content[0]?.text || "", "utf8"));
});

test("observe scan characterization: canonical PageObservation remains stable when optional providers degrade", () => {
	const observation = buildPageObservation({
		mode: "scan",
		canonical: true,
		summary: {},
		entities: [],
		content: "",
		tabs: [],
		snapshot: observationSnapshot("snap-degraded"),
		abmlIntegrated: false,
		diagnostics: { providerFailures: [{ provider: "abml-read", code: "BACKEND_UNAVAILABLE" }] },
	}).inline;

	assert.equal(observation.model, "PageObservation");
	assert.equal(observation.canonical, true);
	assert.equal(observation.entities, undefined);
	assert.equal(observation.actionables, undefined);
	assert.equal(Object.hasOwn(observation, "refs"), false);
	assert.equal(observation.providers.structure?.status, "degraded");
	assert.equal(observation.providers.content?.status, "skipped");
	assert.equal(observation.providers.text?.status, "skipped");
	assert.equal(observation.providers.html?.status, "skipped");
	assert.equal(observation.providers.evidence?.status, "skipped");
	assert.equal(observation.providers.tabs?.status, "degraded");
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

test("observe scan characterization: provider budget telemetry normalizes statuses and compact budget fields", () => {
	const telemetry = buildProviderBudgetTelemetry({
		providers: {
			structure: "executed",
			content: "scan-backed",
			text: "skipped",
			html: "failed",
			evidence: "degraded",
			tabs: "executed",
			ax: "ax-enriched",
			axe: "degraded",
			readability: "failed",
		},
		diagnostics: {
			observeTimings: {
				abmlMs: 12,
				nodeCount: 9,
				tabRefreshMs: 3,
				axMs: 7,
				axNodeCount: 5,
				axCdpCalls: 2,
				axGeometryCdpCalls: 1,
				axCacheHit: true,
				geometryFallbackTruncated: true,
			},
			axFusion: { scanBacked: 4, axEnriched: 2, axOnly: 1, degraded: true },
			axe: { requested: true, ms: 20, counts: { violations: 1, incomplete: 1, passes: 0, inapplicable: 3 }, bounded: { maxInlineResults: 2 }, degraded: true },
			readability: { requested: true, ms: 31, textLength: 800, contentLength: 1600, bounded: { maxInlineChars: 120 }, error: { code: "READABILITY_PROVIDER_UNAVAILABLE" } },
		},
		contentLength: 42,
		tabCount: 2,
		artifactPath: "artifacts/observe.json",
	});
	assert.deepEqual(telemetry.map((item) => [item.provider, item.status]), [
		["structure", "executed"],
		["content", "scan-backed"],
		["text", "skipped"],
		["html", "failed"],
		["evidence", "degraded"],
		["tabs", "executed"],
		["ax", "executed"],
		["axe", "degraded"],
		["readability", "failed"],
	]);
	assert.deepEqual(telemetry.find((item) => item.provider === "structure"), { provider: "structure", status: "executed", durationMs: 12, counts: { nodeCount: 9, axNodeCount: 5, axCdpCalls: 2, axGeometryCdpCalls: 1 } });
	assert.deepEqual(telemetry.find((item) => item.provider === "content"), { provider: "content", status: "scan-backed", counts: { chars: 42 } });
	assert.deepEqual(telemetry.find((item) => item.provider === "html"), { provider: "html", status: "failed", artifact: { path: "artifacts/observe.json", jsonPath: "data.html" } });
	assert.deepEqual(telemetry.find((item) => item.provider === "tabs"), { provider: "tabs", status: "executed", durationMs: 3, counts: { tabs: 2 } });
	assert.deepEqual(telemetry.find((item) => item.provider === "ax"), {
		provider: "ax",
		status: "executed",
		durationMs: 7,
		counts: { axNodeCount: 5, axCdpCalls: 2, axGeometryCdpCalls: 1, scanBacked: 4, axEnriched: 2, axOnly: 1 },
		budget: { axCacheHit: true, geometryFallbackTruncated: true },
		degraded: true,
		reason: "ax-fusion-degraded",
	});
	assert.deepEqual(telemetry.find((item) => item.provider === "axe"), {
		provider: "axe",
		status: "degraded",
		requested: true,
		durationMs: 20,
		counts: { violations: 1, incomplete: 1, passes: 0, inapplicable: 3 },
		budget: { maxInlineResults: 2 },
		degraded: true,
		reason: "incomplete-results",
		errorCode: undefined,
		artifact: undefined,
	});
	assert.deepEqual(telemetry.find((item) => item.provider === "readability"), {
		provider: "readability",
		status: "failed",
		requested: true,
		durationMs: 31,
		counts: { textLength: 800, contentLength: 1600 },
		budget: { maxInlineChars: 120 },
		truncated: false,
		degraded: false,
		reason: "READABILITY_PROVIDER_UNAVAILABLE",
		errorCode: "READABILITY_PROVIDER_UNAVAILABLE",
		artifact: undefined,
	});
});

test("observe scan characterization: provider budget telemetry stays diagnostics-only and bounded", () => {
	const secretArticle = `${"Article body ".repeat(40)}token=secret`;
	const built = buildPageObservation({
		mode: "scan",
		canonical: true,
		summary: { focus: { primary_entities: [buttonEntity] } },
		entities: [buttonEntity, listEntity],
		content: "Checkout content",
		url: "https://example.test/checkout",
		tabs: [{ id: 1 }],
		activeTabId: 1,
		snapshot: observationSnapshot("snap-telemetry"),
		artifactPath: "artifacts/observe-snap-telemetry.json",
		abmlIntegrated: true,
		diagnostics: {
			readability: {
				requested: true,
				ms: 45,
				textLength: secretArticle.length,
				contentLength: secretArticle.length + 20,
				bounded: { maxInlineChars: 80 },
				truncated: true,
				degraded: true,
				article: { textContent: secretArticle, content: `<article>${secretArticle}</article>` },
			},
			axe: {
				requested: true,
				ms: 10,
				counts: { violations: 2, incomplete: 0, passes: 1, inapplicable: 0 },
				bounded: { maxInlineResults: 1 },
				samples: [{ id: "color-contrast", html: "<input value=secret>" }],
			},
		},
		providerStatuses: { readability: "degraded", axe: "executed" },
	});
	const observation = built.inline;
	const diagnostics = built.artifact.diagnostics as Record<string, unknown>;
	const telemetry = diagnostics.providerBudgetTelemetry as Array<Record<string, unknown>>;
	const readability = telemetry.find((item) => item.provider === "readability") as Record<string, unknown>;
	const axe = telemetry.find((item) => item.provider === "axe") as Record<string, unknown>;
	assert.deepEqual(readability, {
		provider: "readability",
		status: "degraded",
		requested: true,
		durationMs: 45,
		counts: { textLength: secretArticle.length, contentLength: secretArticle.length + 20 },
		budget: { maxInlineChars: 80 },
		truncated: true,
		degraded: true,
		reason: "truncated",
		errorCode: undefined,
		artifact: undefined,
	});
	assert.deepEqual(axe, {
		provider: "axe",
		status: "executed",
		requested: true,
		durationMs: 10,
		counts: { violations: 2, incomplete: 0, passes: 1, inapplicable: 0 },
		budget: { maxInlineResults: 1 },
		degraded: false,
		reason: undefined,
		errorCode: undefined,
		artifact: undefined,
	});
	assert.equal(JSON.stringify(telemetry).includes(secretArticle), false);
	assert.equal(JSON.stringify(telemetry).includes("token=secret"), false);
	assert.equal(JSON.stringify(telemetry).includes("samples"), false);
	assert.equal(JSON.stringify(telemetry).includes("article"), false);
	assert.equal(JSON.stringify(observation).includes("token=secret"), false);
	assert.deepEqual(observation.actionables, [{ ref: buttonEntity.ref, kind: "control", name: "Submit", state: defaultState }]);
	assert.deepEqual(observation.entities, [buttonEntity, listEntity]);
	assert.equal(observation.collections, undefined);
});

test("observe scan characterization: provider budget telemetry omits live-only providers unless requested", () => {
	const observation = buildPageObservation({
		mode: "scan",
		canonical: true,
		summary: { focus: { primary_entities: [buttonEntity] } },
		entities: [buttonEntity],
		content: "Checkout content",
		tabs: [{ id: 1 }],
		snapshot: observationSnapshot("snap-default-telemetry"),
		abmlIntegrated: true,
		diagnostics: {},
	}).inline;
	assert.equal(Object.hasOwn(observation.providers, "axe"), false);
	assert.equal(Object.hasOwn(observation.providers, "readability"), false);
	assert.deepEqual(Object.keys(observation.providers), ["structure", "content", "text", "html", "evidence", "tabs", "causal"]);
});

test("observe scan characterization: ledger facts preserve stable refs across relation-only enrichment", () => {
	const priorFacts = factsFromObservedEntities([buttonEntity]);
	const enrichedEntity: Entity = { ...buttonEntity, relations: [{ type: "triggered", targetRef: "bp-ref://network-entry/2", source: "timing", confidence: "low" }] };
	const currentFacts = factsFromObservedEntities([enrichedEntity]);
	assert.notEqual(currentFacts[buttonEntity.ref]?.versionStamp, priorFacts[buttonEntity.ref]?.versionStamp);
	assert.equal(currentFacts[buttonEntity.ref]?.stableStamp, priorFacts[buttonEntity.ref]?.stableStamp);
	const stableRefs = stableRefsFromCommandFrames(
		{ key: { browserSessionId: "session-1", tabId: 1, targetGeneration: 1, pageEpoch: "page-1" }, snapshotId: "snap-2", capturedAt: 2, facts: currentFacts },
		{ key: { browserSessionId: "session-1", tabId: 1, targetGeneration: 1, pageEpoch: "page-1" }, snapshotId: "snap-1", capturedAt: 1, facts: priorFacts },
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
