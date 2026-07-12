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
		outline?: unknown[];
		relations?: Record<string, unknown>;
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
	requireOutlineText?: string[];
	requireContentPreviewIncludes?: string[];
	requireActionableNames?: string[];
	requireCollectionProperties?: Array<{ name: string; kind?: string; observedCount?: number; itemRefCount?: number; declaredTotal?: number; completeness?: string; continuationKind?: string; pageSize?: number; scrollDirection?: string; paginationKind?: string }>;
	requireRelations?: string[];
	rejectObservationText?: string[];
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
	{
		name: "docs article outline keeps semantic headings and content hints stable",
		fixture: {
			entities: [
				entity("bp-ref://element/docs-title", { kind: "text", role: "heading", name: "Browser Pilot exploration guide", structure: { level: 1 }, hints: { selector: "main h1", jsonPath: "data.outline[0]" } }),
				entity("bp-ref://element/docs-install", { kind: "text", role: "heading", name: "Install the bridge", structure: { level: 2 }, hints: { selector: "main h2#install", jsonPath: "data.outline[1]" } }),
				entity("bp-ref://control/docs-copy", { role: "button", name: "Copy install command", hints: { selector: "button.copy", jsonPath: "data.actionables[0]" } }),
				entity("bp-ref://control/docs-next", { role: "link", name: "Next: observe pages", hints: { selector: "a.next", jsonPath: "data.actionables[1]" } }),
			],
			pageObservation: {
				content: "Browser Pilot exploration guide Install the bridge Use browser_observe to collect a semantic page model before acting. Copy install command Next: observe pages",
				url: "https://example.test/docs/exploration",
				outline: [
					{ level: 1, text: "Browser Pilot exploration guide", ref: "bp-ref://element/docs-title" },
					{ level: 2, text: "Install the bridge", ref: "bp-ref://element/docs-install" },
				],
			},
		},
		expect: {
			canonicalShape: true,
			noMarkupPollution: true,
			requireOutlineText: ["Browser Pilot exploration guide", "Install the bridge"],
			requireContentPreviewIncludes: ["Use browser_observe to collect a semantic page model", "Next: observe pages"],
			requireActionableNames: ["Copy install command", "Next: observe pages"],
		},
	},
	{
		name: "dashboard table form preserves collections actionables and control relations",
		fixture: {
			entities: [
				entity("bp-ref://region/orders-table", { kind: "region", role: "table", name: "Orders", hints: { selector: "#orders" } }),
				entity("bp-ref://row/order-1024", { kind: "element", role: "row", name: "Order 1024 pending", structure: { setSize: 3, posInSet: 1, rowIndex: 1 }, hints: { containerRole: "table", containerName: "Orders", selector: "#orders tbody tr:nth-child(1)" } }),
				entity("bp-ref://row/order-1025", { kind: "element", role: "row", name: "Order 1025 shipped", structure: { setSize: 3, posInSet: 2, rowIndex: 2 }, hints: { containerRole: "table", containerName: "Orders", selector: "#orders tbody tr:nth-child(2)" } }),
				entity("bp-ref://row/order-1026", { kind: "element", role: "row", name: "Order 1026 failed", structure: { setSize: 3, posInSet: 3, rowIndex: 3 }, hints: { containerRole: "table", containerName: "Orders", selector: "#orders tbody tr:nth-child(3)" } }),
				entity("bp-ref://control/order-filter", { role: "textbox", name: "Filter orders", state: { ...baseState, editable: true }, relations: [{ type: "controls", targetRef: "bp-ref://region/orders-table", source: "dom", confidence: "high" }], hints: { selector: "#order-filter", jsonPath: "data.actionables[0]", inputKind: "search" } }),
				entity("bp-ref://control/status", { role: "combobox", name: "Status", relations: [{ type: "controls", targetRef: "bp-ref://region/orders-table", source: "ax", confidence: "medium" }], hints: { selector: "#status", jsonPath: "data.actionables[1]" } }),
				entity("bp-ref://control/apply", { role: "button", name: "Apply filters", relations: [{ type: "controls", targetRef: "bp-ref://region/orders-table", source: "dom", confidence: "high" }], hints: { selector: "#apply", jsonPath: "data.actionables[2]" } }),
			],
			pageObservation: {
				content: "Revenue dashboard Orders Filter orders Status Apply filters Order 1024 pending Order 1025 shipped Order 1026 failed",
				url: "https://example.test/dashboard/orders",
				relations: { controls: [{ from: "bp-ref://control/order-filter", to: "bp-ref://region/orders-table" }, { from: "bp-ref://control/apply", to: "bp-ref://region/orders-table" }] },
			},
		},
		expect: {
			canonicalShape: true,
			noMarkupPollution: true,
			requireCollectionNames: ["Orders"],
			requireCollectionProperties: [{ name: "Orders", kind: "table", observedCount: 3, itemRefCount: 3, declaredTotal: 3, completeness: "complete" }],
			requireActionableRoles: ["textbox", "combobox", "button"],
			requireActionableNames: ["Filter orders", "Status", "Apply filters"],
			requireRelations: ["bp-ref://control/order-filter", "bp-ref://region/orders-table", "bp-ref://control/apply"],
		},
	},
	{
		name: "virtualized list preserves bounded samples evidence and continuation hints",
		fixture: {
			entities: [
				entity("bp-ref://row/customer-1", { kind: "element", role: "listitem", name: "Customer 001 Acme renewal", structure: { setSize: 250, posInSet: 1 }, hints: { containerRole: "list", containerName: "Customers", selector: "[data-rowindex='1']" } }),
				entity("bp-ref://row/customer-2", { kind: "element", role: "listitem", name: "Customer 002 Beta expansion", structure: { setSize: 250, posInSet: 2 }, hints: { containerRole: "list", containerName: "Customers", selector: "[data-rowindex='2']" } }),
				entity("bp-ref://row/customer-3", { kind: "element", role: "listitem", name: "Customer 003 Churn risk", structure: { setSize: 250, posInSet: 3 }, hints: { containerRole: "list", containerName: "Customers", selector: "[data-rowindex='3']" } }),
				entity("bp-ref://row/customer-4", { kind: "element", role: "listitem", name: "Customer 004 Onboarding", structure: { setSize: 250, posInSet: 4 }, hints: { containerRole: "list", containerName: "Customers", selector: "[data-rowindex='4']" } }),
				entity("bp-ref://row/customer-5", { kind: "element", role: "listitem", name: "Customer 005 Support escalation", structure: { setSize: 250, posInSet: 5 }, hints: { containerRole: "list", containerName: "Customers", selector: "[data-rowindex='5']" } }),
			],
			scanEvidence: {
				growthProbe: { beforeCount: 5, afterCount: 5, beforeScrollHeight: 4000, afterScrollHeight: 4200, beforeFirstText: "Customer 001 Acme renewal", afterFirstText: "Customer 041 Delta renewal", windowShifted: true },
			},
			pageObservation: {
				content: "Customers Customer 001 Acme renewal Customer 002 Beta expansion Customer 003 Churn risk Customer 004 Onboarding Customer 005 Support escalation",
				url: "https://example.test/dashboard/customers",
			},
		},
		expect: {
			canonicalShape: true,
			noMarkupPollution: true,
			requireCollectionNames: ["Customers"],
			requireCollectionProperties: [{ name: "Customers", kind: "list", observedCount: 5, itemRefCount: 5, declaredTotal: 250, completeness: "virtualized", continuationKind: "virtual-window", scrollDirection: "vertical" }],
			requireEvidenceIncludes: ["item entities observed 5 of declared 250", "visible item window shifted"],
		},
	},
	{
		name: "iframe and shadow DOM fixture expresses boundaries without privileged reads",
		fixture: {
			entities: [
				entity("bp-ref://frame/payments", { kind: "frame", role: "frame", name: "Payments iframe unavailable", state: { ...baseState, editable: false }, hints: { selector: "iframe#payments", inaccessible: true, reason: "cross-origin", origin: "https://payments.example.test" } }),
				entity("bp-ref://control/shadow-search", { role: "searchbox", name: "Search within settings", state: { ...baseState, editable: true }, hints: { selector: "settings-panel >>> input[type=search]", shadowRoot: "open", jsonPath: "data.actionables[0]" } }),
				entity("bp-ref://control/shadow-save", { role: "button", name: "Save settings", hints: { selector: "settings-panel >>> button.save", shadowRoot: "open", jsonPath: "data.actionables[1]" } }),
			],
			pageObservation: {
				content: "Account settings Payments iframe unavailable Search within settings Save settings",
				url: "https://example.test/settings/embed",
			},
		},
		expect: {
			canonicalShape: true,
			noMarkupPollution: true,
			requireActionableRoles: ["searchbox", "button"],
			requireActionableNames: ["Search within settings", "Save settings"],
			rejectObservationText: ["cardNumber", "cvv", "payment token", "cross-origin secret"],
		},
	},
	{
		name: "github like repo pull request page keeps file list and review actions bounded",
		fixture: {
			entities: [
				entity("bp-ref://control-code-tab", { role: "link", name: "Code", hints: { selector: "nav a[href$='/code']", jsonPath: "data.actionables[0]" } }),
				entity("bp-ref://control-pr-tab", { role: "link", name: "Pull requests", state: { ...baseState, current: "page" }, hints: { selector: "nav a[href$='/pulls']", jsonPath: "data.actionables[1]" } }),
				entity("bp-ref://control-review", { role: "button", name: "Review changes", hints: { selector: "button.review", jsonPath: "data.actionables[2]" } }),
				entity("bp-ref://item-file-1", { kind: "element", role: "listitem", name: "src/commands/observe/scanRunner.ts modified", structure: { setSize: 4, posInSet: 1 }, hints: { containerRole: "list", containerName: "Changed files", selector: ".file-list li:nth-child(1)" } }),
				entity("bp-ref://item-file-2", { kind: "element", role: "listitem", name: "tests/observe/observeRegressionBenchmark.test.ts modified", structure: { setSize: 4, posInSet: 2 }, hints: { containerRole: "list", containerName: "Changed files", selector: ".file-list li:nth-child(2)" } }),
				entity("bp-ref://item-file-3", { kind: "element", role: "listitem", name: "CODE_WIKI.md modified", structure: { setSize: 4, posInSet: 3 }, hints: { containerRole: "list", containerName: "Changed files", selector: ".file-list li:nth-child(3)" } }),
				entity("bp-ref://item-file-4", { kind: "element", role: "listitem", name: "package.json unchanged", structure: { setSize: 4, posInSet: 4 }, hints: { containerRole: "list", containerName: "Changed files", selector: ".file-list li:nth-child(4)" } }),
			],
			pageObservation: {
				content: "browser-pilot Pull requests Review changes Changed files src/commands/observe/scanRunner.ts tests/observe/observeRegressionBenchmark.test.ts CODE_WIKI.md",
				url: "https://example.test/org/browser-pilot/pull/42/files",
			},
		},
		expect: {
			canonicalShape: true,
			noMarkupPollution: true,
			requireCollectionNames: ["Changed files"],
			requireCollectionProperties: [{ name: "Changed files", kind: "list", observedCount: 4, itemRefCount: 4, declaredTotal: 4, completeness: "complete" }],
			requireActionableNames: ["Code", "Pull requests", "Review changes"],
			requireActionableRoles: ["link", "button"],
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
			focus: {
				gist: { title: "Offline observe regression", url: fixture.url },
				primary_entities: entities.filter((item) => item.kind === "control"),
				...(fixture.outline ? { outline: fixture.outline } : {}),
				...(fixture.relations ? { relations: fixture.relations } : {}),
			},
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
	for (const required of expect.requireCollectionProperties ?? []) {
		const collection = collections.find((item) => item.containerName === required.name);
		assert.ok(collection, `missing collection for property check: ${required.name}`);
		if (required.kind !== undefined) assert.equal(collection.kind, required.kind);
		if (required.observedCount !== undefined) assert.equal(collection.observedCount, required.observedCount);
		if (required.itemRefCount !== undefined) assert.equal(collection.itemRefCount, required.itemRefCount);
		if (required.declaredTotal !== undefined) assert.equal(collection.declaredTotal, required.declaredTotal);
		if (required.completeness !== undefined) assert.equal(collection.completeness, required.completeness);
		if (required.continuationKind !== undefined) assert.equal(collection.continuation?.kind, required.continuationKind);
		if (required.pageSize !== undefined) assert.equal(collection.pageSize, required.pageSize);
		if (required.scrollDirection !== undefined) assert.equal(collection.scrollDirection, required.scrollDirection);
		if (required.paginationKind !== undefined) assert.equal(collection.paginationControl?.kind, required.paginationKind);
	}
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
	const actionableNames = actionables.map((item) => typeof item.name === "string" ? item.name : "").filter(Boolean);
	for (const name of expect.requireActionableNames ?? []) assert.ok(actionableNames.includes(name), `missing actionable name: ${name}; got ${actionableNames.join(", ")}`);
	const outlineText = collectStrings(observation.outline).join("\n");
	for (const required of expect.requireOutlineText ?? []) assert.ok(outlineText.includes(required), `missing outline text: ${required}`);
	const contentPreview = collectStrings(observation.content).join("\n");
	for (const required of expect.requireContentPreviewIncludes ?? []) assert.ok(contentPreview.includes(required), `missing content preview text: ${required}`);
	const relationText = collectStrings(observation.relations).join("\n");
	for (const required of expect.requireRelations ?? []) assert.ok(relationText.includes(required), `missing relation text: ${required}`);
	const structuralText = collectStrings({ actionables: observation.actionables, refs: observation.refs, entities: observation.entities, collections: observation.collections }).join("\n");
	for (const rejected of expect.rejectStructuralReadabilityText ?? []) assert.equal(structuralText.includes(rejected), false, `readability content entered structural model: ${rejected}`);
	for (const rejected of expect.rejectStructuralPartialAxText ?? []) assert.equal(structuralText.includes(rejected), false, `partial AX local data entered canonical structural model: ${rejected}`);
	const observationText = collectStrings(observation).join("\n");
	for (const rejected of expect.rejectObservationText ?? []) assert.equal(observationText.includes(rejected), false, `observation leaked rejected text: ${rejected}`);
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
