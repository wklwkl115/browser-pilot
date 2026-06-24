import assert from "node:assert/strict";
import test from "node:test";
import { attachAbmlArtifactHints, buildObserveAbmlDetails, buildObserveArtifactProjection, buildScanNextActionHints } from "../../src/commands/observe/scanProjection.ts";
import { factsFromObservedEntities, stableRefsFromCommandFrames } from "../../src/commands/observe/perceptionLedgerProjection.ts";
import type { Entity } from "../../src/kernels/abml/entity.ts";
import type { TreeDiff } from "../../src/kernels/abml/treeDiff.ts";

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
		"to see what CHANGES after you act here: re-run browser_observe mode=scan baseline:\"snap-1\" → envelope.treeDiff (template-level appeared/disappeared, cleaner than re-extracting before/after); + envelope.causal.requests = which requests your action fired",
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
