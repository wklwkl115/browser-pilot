import test from "node:test";
import assert from "node:assert/strict";
import {
	buildCausalSummary,
	buildCausalEvents,
	buildCausalRequest,
	buildCausalEvent,
} from "../../../src/abml-core/causal.ts";
import {
	materializeRelations,
	buildRelationSummary,
	type RelationAnchor,
} from "../../../src/abml-core/relations.ts";
import { summarizeEntityDiff, type EntityDiff, type EntityChange } from "../../../src/abml-core/diff.ts";
import {
	buildDomEntityFromScanActionable,
	buildRegionEntityFromListHint,
	buildControlsSourceEntity,
	buildReferencedTargetEntity,
	buildVisionRegionFromCanvasActionable,
	type Entity,
	type RelationType,
} from "../../../src/abml-core/entity.ts";
import { buildAxEntityFromNode } from "../../../src/abml-core/ax.ts";
import { compareMicroBench, microBenchSink } from "../helpers/microBench.ts";

const ctx = {
	observationId: "obs-item11",
	browserSessionId: "session-item11",
	tabId: 7,
	url: "https://shop.example.test/products?q=laptop",
	capturedAt: 1710000000000,
};

test("item11 causal seq decoration stays output-identical for request and event windows", () => {
	const records = [
		{ seq: 9, requestId: "z", request: { url: "https://x/z", method: "POST" }, response: { status: 201 } },
		{ seq: 4, requestId: "old", request: { url: "https://x/old", method: "GET" } },
		{ requestId: "no-seq", request: { url: "https://x/no-seq", method: "GET" } },
		{ seq: 6, requestId: "mid", request: { url: "https://x/mid", method: "GET" } },
	];
	const events = [
		{ seq: 8, type: "console", data: { message: "later" } },
		{ type: "console", data: { message: "missing seq" } },
		{ seq: 3, type: "console", data: { message: "old" } },
		{ seq: 5, type: "console", data: { message: "first" } },
	];
	assert.deepEqual(buildCausalSummary(records, 4), buildCausalSummaryReference(records, 4));
	assert.deepEqual(buildCausalEvents(events, 4), buildCausalEventsReference(events, 4));
});

test("item11 relation rank map preserves relation and highlight ordering", () => {
	const source: Entity = {
		ref: "pi-ref://control/source",
		kind: "control",
		role: "button",
		state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true },
		source: "ax",
		hints: { backendNodeId: 1 },
	};
	const current: Entity = {
		ref: "pi-ref://region/current",
		kind: "region",
		role: "navigation",
		state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true },
		source: "ax",
		hints: { backendNodeId: 2 },
	};
	const label: Entity = {
		ref: "pi-ref://text/label",
		kind: "text",
		role: "StaticText",
		state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true },
		source: "ax",
		hints: { backendNodeId: 3 },
	};
	const overlay: Entity = {
		ref: "pi-ref://control/overlay",
		kind: "control",
		role: "button",
		state: { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true },
		source: "ax",
		hints: { backendNodeId: 4 },
	};
	const materialized = materializeRelations([source, current, label, overlay], [
		anchor("b:1", "describedBy", "b:3"),
		anchor("b:1", "controls", "b:2"),
		anchor("b:1", "currentIn", "b:2"),
		anchor("b:4", "occludes", "b:1", { source: "geometry", confidence: "medium" }),
	]);
	assert.deepEqual(
		materialized[0]?.relations?.map((relation) => relation.type),
		["controls", "currentIn", "describedBy"],
	);
	const summary = buildRelationSummary(materialized);
	assert.deepEqual(summary.highlights.map((highlight) => highlight.type), ["controls", "currentIn", "describedBy", "occludes"]);
	const perturbedOrder = ["currentIn", "controls", "describedBy", "occludes"];
	assert.notDeepEqual(perturbedOrder, summary.highlights.map((highlight) => highlight.type));
});

test("item11 summarizeEntityDiff keeps score ordering and payload shape unchanged", () => {
	const before = [
		diffEntity("pi-ref://control/search", { role: "searchbox", value: "A", state: { focused: false } }),
		diffEntity("pi-ref://control/submit", { name: "Continue", state: { disabled: true } }),
		diffEntity("pi-ref://text/hint", { kind: "text", role: "StaticText", name: "Hint" }),
	];
	const after = [
		diffEntity("pi-ref://control/search", { role: "searchbox", value: "B", state: { focused: true } }),
		diffEntity("pi-ref://control/submit", { name: "Submit", state: { disabled: false } }),
		diffEntity("pi-ref://text/hint", { kind: "text", role: "StaticText", name: "Hint updated" }),
	];
	const diff: EntityDiff = {
		appeared: ["pi-ref://text/new"],
		disappeared: ["pi-ref://text/old"],
		changed: [
			{ ref: "pi-ref://control/search", kind: "value-changed", before: { value: "A" }, after: { value: "B" } },
			{ ref: "pi-ref://control/submit", kind: "state-changed", before: { disabled: true }, after: { disabled: false } },
			{ ref: "pi-ref://text/hint", kind: "name-changed", before: { name: "Hint" }, after: { name: "Hint updated" } },
		],
		focusedRef: "pi-ref://control/search",
	};
	const salience = summarizeEntityDiff(diff, before, after);
	assert.deepEqual(salience.items.slice(0, 3).map((item) => item.kind === "changed" ? { ref: item.ref, score: item.score, fields: item.fields } : item), [
		{ ref: "pi-ref://control/search", score: changeScoreReference(diff.changed[0]!, before[0], diff.focusedRef), fields: ["value"] },
		{ ref: "pi-ref://control/submit", score: changeScoreReference(diff.changed[1]!, before[1], diff.focusedRef), fields: ["disabled"] },
		{ ref: "pi-ref://text/hint", score: changeScoreReference(diff.changed[2]!, before[2], diff.focusedRef), fields: ["name"] },
	]);
	assert.equal(salience.items.at(-1)?.kind, "churn");
});

test("item11 repeated-origin builders keep descriptor output stable across entity and ax surfaces", () => {
	const actionable = buildDomEntityFromScanActionable({
		index: 0,
		role: "button",
		action: "Buy now",
		selector: "#buy",
		point: { x: 10, y: 12 },
		rect: { x: 0, y: 0, width: 20, height: 10 },
	}, ctx);
	const listHint = buildRegionEntityFromListHint({ selector: "#results", firstItemPreview: "Laptop", hiddenCount: 3 }, ctx, 0);
	const controlsSource = buildControlsSourceEntity({ sourceSelector: "#filter", sourceRole: "button", sourceName: "Filter" }, ctx);
	const referencedTarget = buildReferencedTargetEntity({ selector: "#panel", role: "region", name: "Details" }, ctx);
	const visionRegion = buildVisionRegionFromCanvasActionable({ index: 1, action: "Canvas item", point: { x: 15, y: 18 }, rect: { x: 10, y: 10, width: 20, height: 12 } }, ctx);
	const axEntity = buildAxEntityFromNode({
		nodeId: "ax-11",
		backendDOMNodeId: 81,
		role: { value: "button" },
		name: { value: "Buy now" },
	}, ctx, { point: { x: 10, y: 12 } });
	for (const built of [actionable, listHint, controlsSource, referencedTarget, visionRegion, axEntity]) {
		assert.equal(built.descriptor.owner.topLevelOrigin, "https://shop.example.test");
	}
	const invalidUrlBuilt = buildControlsSourceEntity({ sourceSelector: "#bad", sourceRole: "button" }, { ...ctx, url: "not a valid url" });
	assert.equal(invalidUrlBuilt.descriptor.owner.topLevelOrigin, undefined);
});

test("item11 micro-bench logs per-site ratios on the shared helper", () => {
	const seqValues = Array.from({ length: 256 }, (_, index) => ({ seq: index % 3 === 0 ? undefined : 256 - index }));
	const relationTypes: RelationType[] = ["describedBy", "controls", "currentIn", "occludes", "coveredBy", "owns", "expandedTarget", "triggered"];
	const diffChanges: EntityChange[] = Array.from({ length: 128 }, (_, index) => ({
		ref: `pi-ref://control/${index}`,
		kind: index % 3 === 0 ? "value-changed" : index % 3 === 1 ? "state-changed" : "name-changed",
		before: index % 3 === 0 ? { value: "A" } : index % 3 === 1 ? { disabled: true } : { name: "Before" },
		after: index % 3 === 0 ? { value: "B" } : index % 3 === 1 ? { disabled: false } : { name: "After" },
	}));
	const originUrls = Array.from({ length: 256 }, () => "https://shop.example.test/path?q=1");

	const seqBench = compareMicroBench({
		reference: () => sortSeqReference(seqValues),
		candidate: () => sortSeqCandidate(seqValues),
		iterations: 400,
		warmupSamples: 2,
		samples: 7,
	});
	const relationBench = compareMicroBench({
		reference: () => sortRelationTypesReference(relationTypes),
		candidate: () => sortRelationTypesCandidate(relationTypes),
		iterations: 800,
		warmupSamples: 2,
		samples: 7,
	});
	const diffBench = compareMicroBench({
		reference: () => {
			let total = 0;
			for (const change of diffChanges) total += changeScoreReference(change, diffEntity(change.ref), undefined);
			return total;
		},
		candidate: () => {
			let total = 0;
			for (const change of diffChanges) total += changeScoreCandidate(change, diffEntity(change.ref), undefined);
			return total;
		},
		iterations: 500,
		warmupSamples: 2,
		samples: 7,
	});
	const originBench = compareMicroBench({
		reference: () => {
			let count = 0;
			for (const url of originUrls) count += ownerWithOriginReference(url).topLevelOrigin ? 1 : 0;
			return count;
		},
		candidate: () => {
			let count = 0;
			for (const url of originUrls) count += ownerWithOriginCandidate(url).topLevelOrigin ? 1 : 0;
			return count;
		},
		iterations: 500,
		warmupSamples: 2,
		samples: 7,
	});
	assert.ok(Number.isFinite(seqBench.speedup));
	assert.ok(Number.isFinite(relationBench.speedup));
	assert.ok(Number.isFinite(diffBench.speedup));
	assert.ok(Number.isFinite(originBench.speedup));
	assert.ok(microBenchSink() >= 0);
	console.log(
		`item11 microbench seq=${seqBench.speedup.toFixed(2)}x relations=${relationBench.speedup.toFixed(2)}x diff=${diffBench.speedup.toFixed(2)}x origin=${originBench.speedup.toFixed(2)}x`,
	);
});

function anchor(sourceKey: string, type: RelationType, targetKey: string, extra: Partial<RelationAnchor> = {}): RelationAnchor {
	return { sourceKey, type, targetKey, source: "ax", confidence: "high", ...extra };
}

function diffEntity(ref: string, opts: { role?: string; kind?: Entity["kind"]; name?: string; value?: string; state?: Partial<Entity["state"]> } = {}): Entity {
	return {
		ref,
		kind: opts.kind ?? "control",
		role: opts.role ?? "button",
		...(opts.name !== undefined ? { name: opts.name } : {}),
		...(opts.value !== undefined ? { value: opts.value } : {}),
		state: {
			visible: true,
			occluded: false,
			disabled: false,
			focused: false,
			editable: false,
			inViewport: true,
			...(opts.state ?? {}),
		},
		source: "dom",
	};
}

function numReference(value: unknown): number | undefined {
	const num = Number(value);
	return Number.isFinite(num) ? num : undefined;
}

function buildCausalSummaryReference(records: Array<Record<string, unknown>>, sinceSeq: number): ReturnType<typeof buildCausalSummary> {
	const delta = records
		.filter((record) => {
			const seq = numReference(record.seq);
			return seq === undefined || seq > sinceSeq;
		})
		.sort((a, b) => (numReference(a.seq) ?? 0) - (numReference(b.seq) ?? 0));
	const requests = delta.slice(0, 12).map((record) => buildCausalRequest(record));
	return {
		sinceSeq,
		requests,
		...(delta.length > requests.length ? { requestCount: delta.length } : {}),
	};
}

function buildCausalEventsReference(records: Array<Record<string, unknown>>, sinceSeq: number): ReturnType<typeof buildCausalEvents> {
	const delta = records
		.filter((record) => {
			const seq = numReference(record.seq);
			return seq === undefined || seq > sinceSeq;
		})
		.sort((a, b) => (numReference(a.seq) ?? 0) - (numReference(b.seq) ?? 0));
	const events = delta.slice(0, 12).map((record, index) => buildCausalEvent(record, index));
	return {
		events,
		...(delta.length > events.length ? { eventCount: delta.length } : {}),
	};
}

function sortSeqReference(values: Array<{ seq: number | undefined }>): number {
	return values
		.slice()
		.sort((a, b) => (numReference(a.seq) ?? 0) - (numReference(b.seq) ?? 0))
		.reduce((sum, item) => sum + (item.seq ?? 0), 0);
}

function sortSeqCandidate(values: Array<{ seq: number | undefined }>): number {
	return values
		.map((item) => ({ seq: numReference(item.seq) ?? 0 }))
		.sort((a, b) => a.seq - b.seq)
		.reduce((sum, item) => sum + item.seq, 0);
}

const TYPE_ORDER: RelationType[] = [
	"controls",
	"owns",
	"expandedTarget",
	"triggered",
	"currentIn",
	"labelledBy",
	"describedBy",
	"cellOf",
	"rowOf",
	"columnOf",
	"headerFor",
	"occludes",
	"coveredBy",
];
const TYPE_ORDER_RANK = new Map(TYPE_ORDER.map((type, index) => [type, index]));

function sortRelationTypesReference(types: RelationType[]): number {
	return types
		.slice()
		.sort((a, b) => {
			const left = TYPE_ORDER.indexOf(a);
			const right = TYPE_ORDER.indexOf(b);
			return (left === -1 ? TYPE_ORDER.length : left) - (right === -1 ? TYPE_ORDER.length : right);
		})
		.reduce((sum, type) => sum + type.length, 0);
}

function sortRelationTypesCandidate(types: RelationType[]): number {
	return types
		.slice()
		.sort((a, b) => (TYPE_ORDER_RANK.get(a) ?? TYPE_ORDER.length) - (TYPE_ORDER_RANK.get(b) ?? TYPE_ORDER.length))
		.reduce((sum, type) => sum + type.length, 0);
}

function changedFieldsReference(change: EntityChange): string[] {
	if (change.kind === "name-changed") return ["name"];
	if (change.kind === "value-changed") return ["value"];
	const before = change.before && typeof change.before === "object" ? Object.keys(change.before) : [];
	const after = change.after && typeof change.after === "object" ? Object.keys(change.after) : [];
	return Array.from(new Set([...before, ...after]));
}

function changeScoreReference(change: EntityChange, entity: Entity | undefined, focusedRef?: string): number {
	let score = 0;
	if (entity?.kind === "control") score += 40;
	else if (entity?.kind === "element" || entity?.kind === "region") score += 24;
	else if (entity?.kind === "text") score += 4;
	if (change.kind === "value-changed") score += 40;
	else if (change.kind === "name-changed") score += 28;
	else if (change.kind === "state-changed") score += 24;
	if (change.ref === focusedRef) score += 30;
	for (const field of changedFieldsReference(change)) {
		if (["value", "checked", "selected", "pressed", "expanded", "current", "disabled", "focused"].includes(field)) score += 8;
	}
	return score;
}

const SALIENT_CHANGE_FIELDS = new Set(["value", "checked", "selected", "pressed", "expanded", "current", "disabled", "focused"]);

function changeScoreCandidate(change: EntityChange, entity: Entity | undefined, focusedRef?: string): number {
	let score = 0;
	if (entity?.kind === "control") score += 40;
	else if (entity?.kind === "element" || entity?.kind === "region") score += 24;
	else if (entity?.kind === "text") score += 4;
	if (change.kind === "value-changed") score += 40;
	else if (change.kind === "name-changed") score += 28;
	else if (change.kind === "state-changed") score += 24;
	if (change.ref === focusedRef) score += 30;
	for (const field of changedFieldsReference(change)) {
		if (SALIENT_CHANGE_FIELDS.has(field)) score += 8;
	}
	return score;
}

function topLevelOriginReference(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

function ownerWithOriginReference(url: string | undefined): { topLevelOrigin?: string } {
	return {
		...(topLevelOriginReference(url) ? { topLevelOrigin: topLevelOriginReference(url) } : {}),
	};
}

let cachedOriginUrl: string | undefined;
let cachedOriginValue: string | undefined;
let hasCachedOrigin = false;

function ownerWithOriginCandidate(url: string | undefined): { topLevelOrigin?: string } {
	if (!(hasCachedOrigin && url === cachedOriginUrl)) {
		cachedOriginUrl = url;
		cachedOriginValue = topLevelOriginReference(url);
		hasCachedOrigin = true;
	}
	return {
		...(cachedOriginValue ? { topLevelOrigin: cachedOriginValue } : {}),
	};
}
