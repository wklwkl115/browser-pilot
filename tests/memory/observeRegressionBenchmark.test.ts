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
	requireReadabilityProvider?: string;
	rejectStructuralReadabilityText?: string[];
	rejectStructuralPartialAxText?: string[];
	rejectPartialAxProvider?: boolean;
	requireAxFusion?: { axEnriched?: number; axOnly?: number; degraded?: boolean; skipped?: Partial<Record<"ambiguousBackend" | "ambiguousGeometry" | "ambiguousSemantic" | "unsafeSemantic", number>> };
	requireProviderTelemetry?: Record<string, { status: string; requested?: boolean; budget?: Record<string, unknown>; truncated?: boolean; degraded?: boolean; reason?: string; counts?: Record<string, number> }>;
	rejectProviderTelemetry?: string[];
	requireActionableRoles?: string[];
	rejectActionableRoles?: string[];
	rejectCollectionRoles?: string[];
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
	{
		name: "role provider landmarks do not pollute actionables or collections",
		fixture: {
			entities: [
				entity("bp-ref://control/search", { role: "searchbox", name: "Search docs", state: { ...baseState, editable: true }, hints: { selector: "#q", jsonPath: "data.actionables[0]", inputKind: "search" } }),
				entity("bp-ref://control/open-details", { role: "button", name: "More details", hints: { selector: "details > summary", jsonPath: "data.actionables[1]" } }),
			],
			pageObservation: {
				content: "Search docs More details Navigation Main Region Form Banner Footer",
				url: "https://example.test/roles",
			},
			scanEvidence: {
				listHints: [{ itemCount: 6, containerLabel: "Navigation", selector: "nav > a.item", firstItemPreview: "Role mapping fixture item" }],
			},
		},
		expect: {
			canonicalShape: true,
			noMarkupPollution: true,
			requireActionableRoles: ["searchbox", "button"],
			rejectActionableRoles: ["navigation", "main", "region", "form", "banner", "contentinfo"],
			rejectCollectionRoles: ["navigation", "main", "region", "form", "banner", "contentinfo"],
		},
	},
	{
		name: "readability content-plane provider is recorded without entering structural benchmark authority",
		fixture: {
			pageObservation: {
				entities: [entity("bp-ref://control/pay", { name: "Pay invoice", hints: { selector: "#pay" } })],
				content: "Subscribe now Navigation Advertisement Cookie banner Related links Footer Article body about river restoration and habitat work",
				url: "https://example.test/article",
			},
		},
		expect: {
			canonicalShape: true,
			noMarkupPollution: true,
			requireReadabilityProvider: "executed",
			rejectStructuralReadabilityText: ["Article body about river restoration", "habitat work"],
		},
	},
	{
		name: "provider budget telemetry fixture is compact and independent from live providers",
		fixture: {
			pageObservation: {
				entities: [entity("bp-ref://control/export", { name: "Export report", hints: { selector: "#export" } })],
				content: "Export report Article summary remains content-plane only",
				url: "https://example.test/report",
			},
		},
		expect: {
			canonicalShape: true,
			noMarkupPollution: true,
			requireReadabilityProvider: "degraded",
			requireProviderTelemetry: {
				structure: { status: "executed" },
				content: { status: "scan-backed", counts: { chars: "Export report Article summary remains content-plane only".length } },
				readability: { status: "degraded", requested: true, budget: { maxInlineChars: 96 }, truncated: true, degraded: true, reason: "truncated", counts: { textLength: 1200, contentLength: 1800 } },
			},
			rejectProviderTelemetry: ["axe", "partialAx", "partial-ax"],
			rejectStructuralReadabilityText: ["Article summary remains content-plane only"],
		},
	},
	{
		name: "partial AX pierce diagnostics stay scoped and do not enter canonical page-wide structure",
		fixture: {
			pageObservation: {
				entities: [entity("bp-ref://control/settings", { name: "Open settings", hints: { selector: "#settings", backendNodeId: 42 } })],
				content: "Open settings Local partial AX candidate Admin-only hidden menu Imported AX-only sibling",
				url: "https://example.test/settings",
			},
		},
		expect: {
			canonicalShape: true,
			noMarkupPollution: true,
			rejectPartialAxProvider: true,
			rejectStructuralPartialAxText: ["Local partial AX candidate", "Admin-only hidden menu", "Imported AX-only sibling"],
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
	const readabilityTelemetry = caseDef.expect.requireProviderTelemetry?.readability;
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
			...(axFusion ? { axFusion: { scanBacked: entities.length, axEnriched: axFusion.axEnriched ?? 0, axOnly: axFusion.axOnly ?? 0, degraded: axFusion.degraded ?? false, skipped: { ambiguousBackend: axFusion.skipped?.ambiguousBackend ?? 0, ambiguousGeometry: axFusion.skipped?.ambiguousGeometry ?? 0, ambiguousSemantic: axFusion.skipped?.ambiguousSemantic ?? 0, unsafeSemantic: axFusion.skipped?.unsafeSemantic ?? 0 } } } : {}),
			...(readabilityTelemetry ? { readability: { requested: readabilityTelemetry.requested === true, ms: 24, ...(readabilityTelemetry.counts ?? {}), bounded: readabilityTelemetry.budget, truncated: readabilityTelemetry.truncated === true, degraded: readabilityTelemetry.degraded === true } } : {}),
		},
		...(caseDef.expect.requireAxProvider || caseDef.expect.requireReadabilityProvider
			? {
					providerStatuses: {
						...(caseDef.expect.requireAxProvider ? { ax: caseDef.expect.requireAxProvider as "ax-enriched" | "ax-only" | "degraded" | "skipped" | "scan-backed" | "failed" } : {}),
						...(caseDef.expect.requireReadabilityProvider ? { readability: caseDef.expect.requireReadabilityProvider as "executed" | "degraded" | "skipped" | "failed" } : {}),
					},
				}
			: {}),
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
	if (expect.requireReadabilityProvider) assert.equal(providers.readability, expect.requireReadabilityProvider);
	if (expect.rejectPartialAxProvider) assert.equal("partialAx" in providers || "partial-ax" in providers, false);
	if (expect.requireAxFusion) {
		const axFusion = diagnostics.axFusion as Record<string, unknown>;
		if (expect.requireAxFusion.axEnriched !== undefined) assert.equal(axFusion.axEnriched, expect.requireAxFusion.axEnriched);
		if (expect.requireAxFusion.axOnly !== undefined) assert.equal(axFusion.axOnly, expect.requireAxFusion.axOnly);
		if (expect.requireAxFusion.degraded !== undefined) assert.equal(axFusion.degraded, expect.requireAxFusion.degraded);
		const skipped = axFusion.skipped as Record<string, unknown>;
		for (const [key, value] of Object.entries(expect.requireAxFusion.skipped ?? {})) assert.equal(skipped[key], value);
	}
	const providerTelemetry = Array.isArray(diagnostics.providerBudgetTelemetry) ? diagnostics.providerBudgetTelemetry as Array<Record<string, unknown>> : [];
	for (const [provider, required] of Object.entries(expect.requireProviderTelemetry ?? {})) {
		const item = providerTelemetry.find((candidate) => candidate.provider === provider);
		assert.ok(item, `missing provider telemetry: ${provider}`);
		assert.equal(item.status, required.status);
		if (required.requested !== undefined) assert.equal(item.requested, required.requested);
		if (required.budget) assert.deepEqual(item.budget, required.budget);
		if (required.truncated !== undefined) assert.equal(item.truncated, required.truncated);
		if (required.degraded !== undefined) assert.equal(item.degraded, required.degraded);
		if (required.reason !== undefined) assert.equal(item.reason, required.reason);
		if (required.counts) assert.deepEqual(item.counts, required.counts);
	}
	for (const provider of expect.rejectProviderTelemetry ?? []) assert.equal(providerTelemetry.some((item) => item.provider === provider), false, `unexpected provider telemetry: ${provider}`);
	const actionables = observation.actionables as Record<string, unknown>[];
	const actionableRoles = actionables.map((item) => String(item.role || "").toLowerCase()).filter(Boolean);
	for (const role of expect.requireActionableRoles ?? []) assert.ok(actionableRoles.includes(role), `missing actionable role: ${role}; got ${actionableRoles.join(", ")}`);
	for (const role of expect.rejectActionableRoles ?? []) assert.equal(actionableRoles.includes(role), false, `unexpected actionable role: ${role}`);
	const structuralText = collectStrings({ actionables: observation.actionables, refs: observation.refs, entities: observation.entities, collections: observation.collections }).join("\n");
	for (const rejected of expect.rejectStructuralReadabilityText ?? []) assert.equal(structuralText.includes(rejected), false, `readability content entered structural model: ${rejected}`);
	for (const rejected of expect.rejectStructuralPartialAxText ?? []) assert.equal(structuralText.includes(rejected), false, `partial AX local data entered canonical structural model: ${rejected}`);
}

function assertRoleBoundary(collections: CollectionModel[], expect: ObserveRegressionExpectations): void {
	if (!expect.rejectCollectionRoles?.length) return;
	const collectionText = collectStrings(collections).join("\n").toLowerCase();
	for (const role of expect.rejectCollectionRoles) assert.equal(collectionText.includes(role), false, `collection leaked role provider structural role: ${role}`);
}

test("observe regression benchmark cases are offline and deterministic", () => {
	assert.ok(cases.length >= 5);
	for (const caseDef of cases) {
		assert.equal(caseDef.name.trim().length > 0, true);
		const collections = buildCollections(caseDef);
		const observation = buildObservation(caseDef, collections);
		assertCollectionMetrics(collections, caseDef.expect);
		assertRoleBoundary(collections, caseDef.expect);
		if (caseDef.expect.canonicalShape) assertCanonicalShape(observation, caseDef.expect);
		if (caseDef.expect.noMarkupPollution) assertNoMarkupPollution({ collections, observation });
	}
});
