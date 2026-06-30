import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPageObservation } from "../../src/commands/observe/scanProjection.ts";
import type { CollectionModel } from "../../src/kernels/abml/collections.ts";
import { buildCollectionModels } from "../../src/kernels/abml/collections.ts";
import type { Entity } from "../../src/kernels/abml/entity.ts";
import { sanitizeSemanticText } from "../../src/kernels/abml/semanticText.ts";

type ObserveRegressionFixture = {
	entities?: Entity[];
	scanEvidence?: Parameters<typeof buildCollectionModels>[0]["scanEvidence"];
	pageObservation?: {
		entities?: Entity[];
		collections?: CollectionModel[];
		content?: string;
		url?: string;
	};
};

type ObserveRegressionExpectations = {
	noMarkupPollution?: boolean;
	maxCollectionNameChars?: number;
	uniqueCollectionNames?: boolean;
	requireCollectionNames?: string[];
	rejectCollectionNameIncludes?: string[];
	requireEvidenceIncludes?: string[];
	canonicalShape?: boolean;
	requireAxProvider?: string;
	requireAxFusion?: { axEnriched?: number; axOnly?: number; degraded?: boolean; skipped?: Partial<Record<"ambiguousBackend" | "ambiguousGeometry" | "ambiguousSemantic" | "unsafeSemantic", number>> };
};

type ObserveRegressionCase = {
	name: string;
	fixture: ObserveRegressionFixture;
	expect: ObserveRegressionExpectations;
};

const baseState: Entity["state"] = {
	visible: true,
	occluded: false,
	disabled: false,
	focused: false,
	editable: false,
	inViewport: true,
};

function entity(ref: string, overrides: Partial<Entity> = {}): Entity {
	return {
		ref,
		kind: "control",
		role: "button",
		name: "Submit",
		state: baseState,
		source: "dom",
		...overrides,
		state: { ...baseState, ...overrides.state },
	};
}

const pricingPreview = "Model: premium-llm-2026, Input price: $12 per 1M tokens, Output price: $48 per 1M tokens, Cache read: $3 per 1M tokens, Context: 128k, Billing multiplier: 2x";

const cases: ObserveRegressionCase[] = [
	{
		name: "semantic labels reject SVG/path/HTML-like pollution",
		fixture: {
			pageObservation: {
				entities: [
					entity("bp-ref://element/icon", { name: sanitizeSemanticText("<svg><path d=\"M10 10 L20 20\" /></svg>") }),
					entity("bp-ref://element/path", { name: sanitizeSemanticText("M10 10 L20 20") }),
					entity("bp-ref://element/cta", { name: sanitizeSemanticText("Start trial") }),
				],
				content: "Start trial",
				url: "https://example.test/pricing",
			},
		},
		expect: {
			noMarkupPollution: true,
			canonicalShape: true,
		},
	},
	{
		name: "long pricing/model-card preview is preserved as evidence but not promoted to containerName",
		fixture: {
			scanEvidence: {
				listHints: [{ itemCount: 4, firstItemPreview: pricingPreview, selector: ".pricing-grid" }],
			},
		},
		expect: {
			noMarkupPollution: true,
			maxCollectionNameChars: 24,
			requireCollectionNames: ["list-0"],
			rejectCollectionNameIncludes: ["Input price", "Output price", "Billing multiplier"],
			requireEvidenceIncludes: ["Input price", "Output price", "Billing multiplier"],
		},
	},
	{
		name: "duplicate collection names are deterministically distinguishable",
		fixture: {
			scanEvidence: {
				listHints: [
					{ itemCount: 3, containerLabel: "筛选", selector: ".left-filters" },
					{ itemCount: 5, containerLabel: "筛选", selector: ".right-filters" },
				],
			},
		},
		expect: {
			uniqueCollectionNames: true,
			requireCollectionNames: ["筛选 (left filters)", "筛选 (right filters)"],
		},
	},
	{
		name: "safe item sample survives when unsafe preview cannot name the collection",
		fixture: {
			scanEvidence: {
				listHints: [{ itemCount: 2, firstItemPreview: "Enterprise plan | Input: $20 | Output: $80 | Cache: $5 | Requests: 1M", nearestHeading: "Plans" }],
			},
		},
		expect: {
			requireCollectionNames: ["list-0"],
			rejectCollectionNameIncludes: ["Enterprise plan", "Requests: 1M"],
			requireEvidenceIncludes: ["Enterprise plan", "Requests: 1M"],
		},
	},
	{
		name: "AX fusion diagnostics are represented in canonical PageObservation",
		fixture: {
			pageObservation: {
				entities: [entity("bp-ref://control/save", { name: "Save", hints: { mergedSources: ["dom", "ax"], selector: "#save" } })],
				content: "Save",
				url: "https://example.test/settings",
			},
		},
		expect: {
			canonicalShape: true,
			noMarkupPollution: true,
			requireAxProvider: "ax-enriched",
			requireAxFusion: { axEnriched: 1, axOnly: 0, degraded: false },
		},
	},
	{
		name: "AX fusion degraded diagnostics include skipped ambiguity counts",
		fixture: {
			pageObservation: {
				entities: [
					entity("bp-ref://control/filter-a", { name: "Filter", hints: { selector: "#filter-a" } }),
					entity("bp-ref://control/filter-b", { name: "Filter", hints: { selector: "#filter-b" } }),
				],
				content: "Filter Filter",
				url: "https://example.test/filters",
			},
		},
		expect: {
			canonicalShape: true,
			noMarkupPollution: true,
			requireAxProvider: "degraded",
			requireAxFusion: { axEnriched: 0, axOnly: 1, degraded: true, skipped: { ambiguousSemantic: 1 } },
		},
	},
];

function buildCollections(caseDef: ObserveRegressionCase): CollectionModel[] {
	return buildCollectionModels({
		entities: caseDef.fixture.entities ?? [],
		...(caseDef.fixture.scanEvidence ? { scanEvidence: caseDef.fixture.scanEvidence } : {}),
	});
}

function buildObservation(caseDef: ObserveRegressionCase, collections: CollectionModel[]): Record<string, unknown> | undefined {
	const fixture = caseDef.fixture.pageObservation;
	if (!fixture) return undefined;
	const entities = fixture.entities ?? caseDef.fixture.entities ?? [];
	const axFusion = caseDef.expect.requireAxFusion;
	const skipped = {
		ambiguousBackend: axFusion?.skipped?.ambiguousBackend ?? 0,
		ambiguousGeometry: axFusion?.skipped?.ambiguousGeometry ?? 0,
		ambiguousSemantic: axFusion?.skipped?.ambiguousSemantic ?? 0,
		unsafeSemantic: axFusion?.skipped?.unsafeSemantic ?? 0,
	};
	return buildPageObservation({
		mode: "scan",
		canonical: true,
		summary: {
			focus: { gist: { title: "Offline observe regression", url: fixture.url }, primary_entities: entities.filter((item) => item.kind === "control") },
			collections,
		},
		entities,
		content: fixture.content ?? "",
		url: fixture.url,
		tabs: [{ id: 1 }],
		activeTabId: 1,
		snapshot: { snapshotId: `offline-${caseDef.name.replace(/\W+/g, "-").toLowerCase()}` },
		artifactPath: "artifacts/offline-observe-regression.json",
		abmlIntegrated: true,
		diagnostics: {
			offlineBenchmark: true,
			...(axFusion ? { axFusion: { scanBacked: entities.length, axEnriched: axFusion.axEnriched ?? 0, axOnly: axFusion.axOnly ?? 0, degraded: axFusion.degraded ?? false, skipped } } : {}),
		},
		...(caseDef.expect.requireAxProvider ? { providerStatuses: { ax: caseDef.expect.requireAxProvider as "ax-enriched" | "ax-only" | "degraded" | "skipped" | "scan-backed" | "failed" } } : {}),
	});
}

function collectStrings(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, out));
	else if (value && typeof value === "object") Object.values(value).forEach((item) => collectStrings(item, out));
	return out;
}

function assertNoMarkupPollution(value: unknown): void {
	const polluted = collectStrings(value).filter((text) => /<\/?(?:svg|path)\b|<[^>]+>|\b(?:d|viewbox|xmlns|fill-rule|clip-rule)\b/i.test(text));
	assert.deepEqual(polluted, []);
}

function assertCollectionMetrics(collections: CollectionModel[], expect: ObserveRegressionExpectations): void {
	const names = collections.map((collection) => collection.containerName).filter((name): name is string => typeof name === "string");
	if (expect.maxCollectionNameChars !== undefined) {
		for (const name of names) assert.ok(name.length <= expect.maxCollectionNameChars, `${name} exceeds maxCollectionNameChars=${expect.maxCollectionNameChars}`);
	}
	if (expect.uniqueCollectionNames) assert.equal(new Set(names).size, names.length);
	for (const requiredName of expect.requireCollectionNames ?? []) assert.ok(names.includes(requiredName), `missing collection name: ${requiredName}; got ${names.join(", ")}`);
	for (const rejected of expect.rejectCollectionNameIncludes ?? []) assert.equal(names.some((name) => name.includes(rejected)), false, `collection name leaked rejected text: ${rejected}`);
	const evidenceText = collections.flatMap((collection) => collection.evidence.map((item) => item.summary)).join("\n");
	for (const required of expect.requireEvidenceIncludes ?? []) assert.match(evidenceText, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

function assertCanonicalShape(observation: Record<string, unknown> | undefined, expect: ObserveRegressionExpectations = {}): void {
	assert.ok(observation, "case must build a PageObservation");
	assert.equal(observation.model, "PageObservation");
	assert.equal(observation.canonical, true);
	assert.equal(observation.mode, "scan");
	assert.equal(observation.sourceMode, "scan");
	assert.ok(observation.context && typeof observation.context === "object");
	assert.ok(Array.isArray(observation.entities));
	assert.ok(Array.isArray(observation.actionables));
	assert.ok(Array.isArray(observation.refs));
	assert.ok(observation.diagnostics && typeof observation.diagnostics === "object");
	const diagnostics = observation.diagnostics as Record<string, unknown>;
	const providers = diagnostics.providers as Record<string, unknown>;
	assert.equal(providers.structure, "executed");
	if (expect.requireAxProvider) assert.equal(providers.ax, expect.requireAxProvider);
	if (expect.requireAxFusion) {
		const axFusion = diagnostics.axFusion as Record<string, unknown>;
		if (expect.requireAxFusion.axEnriched !== undefined) assert.equal(axFusion.axEnriched, expect.requireAxFusion.axEnriched);
		if (expect.requireAxFusion.axOnly !== undefined) assert.equal(axFusion.axOnly, expect.requireAxFusion.axOnly);
		if (expect.requireAxFusion.degraded !== undefined) assert.equal(axFusion.degraded, expect.requireAxFusion.degraded);
		const skipped = axFusion.skipped as Record<string, unknown>;
		for (const [key, value] of Object.entries(expect.requireAxFusion.skipped ?? {})) assert.equal(skipped[key], value);
	}
}

test("observe regression benchmark cases are offline and deterministic", () => {
	assert.ok(cases.length >= 5);
	for (const caseDef of cases) {
		assert.equal(caseDef.name.trim().length > 0, true);
		const collections = buildCollections(caseDef);
		const observation = buildObservation(caseDef, collections);
		assertCollectionMetrics(collections, caseDef.expect);
		if (caseDef.expect.canonicalShape) assertCanonicalShape(observation, caseDef.expect);
		if (caseDef.expect.noMarkupPollution) assertNoMarkupPollution({ collections, observation });
	}
});
