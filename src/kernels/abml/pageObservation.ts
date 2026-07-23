import type { Entity } from "./entity.js";
import type { EntityDiff } from "./diff.js";
import type { CausalSummary } from "./causal.js";
import type { TreeDiff } from "./treeDiff.js";
import type { SnapshotProjection } from "./snapshotProjection.js";
import type { RelationSummary } from "./relations.js";
import type { InferenceSummary } from "./inference.js";
import type { PageReanchorReason } from "../session/pageIdentity.js";

export const PAGE_OBSERVATION_SCHEMA_V3 = "browser-page-observation/v3" as const;

export type ObservationFrontierState = "folded" | "viewport-window" | "virtualized" | "paginated" | "lazy" | "unavailable";
export type ObservationFrontierKind = "template-instances" | "collection-window" | "content" | "details";

export interface ObservationFrontierItem {
	ref: string;
	kind: ObservationFrontierKind;
	state: ObservationFrontierState;
	label?: string;
	observed?: number;
	total?: number;
	controlRef?: string;
	resourceUri?: string;
	unavailableReason?: string;
}

export interface ObservationFrontier { items: ObservationFrontierItem[] }

export type ProviderExecutionStatus = "executed" | "scan-backed" | "skipped" | "failed" | "degraded";
export interface ProviderExecutionItem {
	planned: boolean;
	status: ProviderExecutionStatus;
	reason?: string;
	reservedMs?: number;
	actualMs?: number;
	bridgeRoundTrips?: number;
}
export type ProviderExecutionReport = Record<string, ProviderExecutionItem>;
export type PublicProviderExecutionItem = Pick<ProviderExecutionItem, "status" | "reason">;
export type PublicProviderExecutionReport = Record<string, PublicProviderExecutionItem>;

export interface CompactActionable {
	ref: string;
	kind: string;
	name?: string;
	state?: Record<string, unknown>;
}

export interface CompactCollection {
	ref: string;
	kind: string;
	name?: string;
	observed: number;
	total?: number;
	completeness: string;
	confidence: string;
	itemRefs: string[];
	frontierRef?: string;
}

export interface PageObservationContent {
	text: string;
	headings?: string[];
	complete: boolean;
}

/** Saved artifacts use the same v3 root while retaining collection evidence. */
export interface CollectionSummary extends CompactCollection {
	collectionId?: string;
	itemRefCount?: number;
	hiddenCount?: number;
	containerRole?: string;
	containerNameContext?: string;
	containerNameSource?: string;
	itemRole?: string;
	paginationControl?: Record<string, unknown>;
	dataSources?: Array<Record<string, unknown>>;
	evidence?: Array<Record<string, unknown>>;
}

export interface PageTarget {
	browserSessionId?: string;
	tabId?: number;
	targetGeneration?: number;
	pageEpoch?: string;
	url?: string;
}

export interface ObservationSnapshot {
	snapshotId: string;
	browserSessionId?: string;
	tabId?: number;
	url?: string;
	targetGeneration?: number;
	pageEpoch?: string;
	documentId?: string;
	frameScope?: string;
	selectionVersion?: number;
	sourceMode: string;
	capturedAt: number;
	ttlMs: number;
	networkSeq?: number;
	hookSeq?: number;
	invalidatedReason?: string;
	expired?: boolean;
}

export interface PageObservationV3 {
	schema: typeof PAGE_OBSERVATION_SCHEMA_V3;
	tool: "browser_observe";
	model: "PageObservation";
	canonical: true;
	target: PageTarget;
	snapshot: ObservationSnapshot;
	reanchorReason?: PageReanchorReason;
	delta?: "session";
	baselineSnapshotId?: string;
	content?: PageObservationContent;
	gist?: Record<string, unknown>;
	outline?: Array<Record<string, unknown>>;
	entities?: Entity[];
	actionables?: CompactActionable[];
	relations?: RelationSummary;
	identity?: Record<string, unknown>;
	inference?: InferenceSummary;
	diff?: EntityDiff;
	causal?: CausalSummary;
	treeDiff?: TreeDiff;
	snapshotProjection?: SnapshotProjection;
	collections?: CollectionSummary[];
	providers: ProviderExecutionReport;
	frontier: ObservationFrontier;
	diagnostics?: Record<string, unknown>;
	nextActions?: string[];
}

export interface PageObservationView {
	schema: typeof PAGE_OBSERVATION_SCHEMA_V3;
	tool: "browser_observe";
	model: "PageObservation";
	canonical: true;
	target: Pick<PageTarget, "url">;
	snapshot: Pick<ObservationSnapshot, "snapshotId" | "capturedAt" | "ttlMs">;
	content?: PageObservationContent;
	gist?: Record<string, unknown>;
	outline?: Array<Record<string, unknown>>;
	actionables?: CompactActionable[];
	relations?: RelationSummary;
	inference?: InferenceSummary;
	causal?: CausalSummary;
	treeDiff?: TreeDiff;
	snapshotProjection?: SnapshotProjection;
	collections?: CompactCollection[];
	providers: PublicProviderExecutionReport;
	frontier: ObservationFrontier;
	diagnostics?: Record<string, unknown>;
	nextActions?: string[];
}

const FRONTIER_ITEM_SCHEMA = {
	type: "object",
	properties: {
		ref: { type: "string", minLength: 1 },
		kind: { enum: ["template-instances", "collection-window", "content", "details"] },
		state: { enum: ["folded", "viewport-window", "virtualized", "paginated", "lazy", "unavailable"] },
		label: { type: "string", minLength: 1 },
		observed: { type: "integer", minimum: 0 },
		total: { type: "integer", minimum: 0 },
		controlRef: { type: "string", minLength: 1 },
		resourceUri: { type: "string", minLength: 1 },
		unavailableReason: { type: "string", minLength: 1 },
	},
	required: ["ref", "kind", "state"],
	anyOf: [{ required: ["resourceUri"] }, { required: ["unavailableReason"] }, { required: ["controlRef"] }],
	additionalProperties: false,
} as const;

const PROVIDER_ITEM_SCHEMA = {
	type: "object",
	properties: {
		planned: { type: "boolean" },
		status: { enum: ["executed", "scan-backed", "skipped", "failed", "degraded"] },
		reason: { type: "string" },
		reservedMs: { type: "number", minimum: 0 },
		actualMs: { type: "number", minimum: 0 },
		bridgeRoundTrips: { type: "integer", minimum: 0 },
	},
	required: ["planned", "status"],
	additionalProperties: false,
} as const;

const COLLECTION_SCHEMA = {
	type: "object",
	properties: {
		ref: { type: "string", minLength: 1 }, kind: { type: "string", minLength: 1 }, name: { type: "string" },
		observed: { type: "integer", minimum: 0 }, total: { type: "integer", minimum: 0 }, completeness: { type: "string" }, confidence: { type: "string" },
		itemRefs: { type: "array", items: { type: "string" } }, frontierRef: { type: "string" }, collectionId: { type: "string" }, itemRefCount: { type: "integer", minimum: 0 }, hiddenCount: { type: "integer", minimum: 0 },
		containerRole: { type: "string" }, containerNameContext: { type: "string" }, containerNameSource: { type: "string" }, itemRole: { type: "string" },
		paginationControl: { type: "object" },
		dataSources: { type: "array", items: { type: "object" } }, evidence: { type: "array", items: { type: "object" } },
	},
	required: ["ref", "kind", "observed", "completeness", "confidence", "itemRefs"],
	additionalProperties: false,
} as const;

export const PAGE_OBSERVATION_V3_JSON_SCHEMA = {
	$id: PAGE_OBSERVATION_SCHEMA_V3,
	type: "object",
	properties: {
		schema: { const: PAGE_OBSERVATION_SCHEMA_V3 }, tool: { const: "browser_observe" }, model: { const: "PageObservation" }, canonical: { const: true },
		target: {
			type: "object",
			properties: { browserSessionId: { type: "string" }, tabId: { type: "integer" }, targetGeneration: { type: "integer" }, pageEpoch: { type: "string" }, url: { type: "string" } },
			additionalProperties: false,
		},
		snapshot: {
			type: "object",
			properties: {
				snapshotId: { type: "string" }, browserSessionId: { type: "string" }, tabId: { type: "integer" }, url: { type: "string" }, targetGeneration: { type: "integer" }, pageEpoch: { type: "string" }, documentId: { type: "string" }, frameScope: { type: "string" }, selectionVersion: { type: "integer" }, sourceMode: { type: "string" }, capturedAt: { type: "number" }, ttlMs: { type: "number" }, networkSeq: { type: "integer" }, hookSeq: { type: "integer" }, invalidatedReason: { type: "string" }, expired: { type: "boolean" },
			},
			required: ["snapshotId", "sourceMode", "capturedAt", "ttlMs"],
			additionalProperties: false,
		},
		reanchorReason: { enum: ["document_changed", "target_replaced", "session_changed", "identity_unproven", "baseline_missing"] }, delta: { const: "session" }, baselineSnapshotId: { type: "string" },
		content: { type: "object", properties: { text: { type: "string" }, headings: { type: "array", items: { type: "string" } }, complete: { type: "boolean" } }, required: ["text", "complete"], additionalProperties: false },
		gist: { type: "object" }, outline: { type: "array", items: { type: "object" } }, entities: { type: "array", items: { type: "object" } },
		actionables: { type: "array", items: { type: "object", properties: { ref: { type: "string" }, kind: { type: "string" }, name: { type: "string" }, state: { type: "object" } }, required: ["ref", "kind"], additionalProperties: false } },
		relations: { type: "object" }, identity: { type: "object" }, inference: { type: "object" }, diff: { type: "object" }, causal: { type: "object" }, treeDiff: { type: "object" }, snapshotProjection: { type: "object" }, collections: { type: "array", items: COLLECTION_SCHEMA },
		providers: { type: "object", additionalProperties: PROVIDER_ITEM_SCHEMA },
		frontier: { type: "object", properties: { items: { type: "array", items: FRONTIER_ITEM_SCHEMA } }, required: ["items"], additionalProperties: false },
		diagnostics: { type: "object" },
		nextActions: { type: "array", items: { type: "string" } },
	},
	required: ["schema", "tool", "model", "canonical", "target", "snapshot", "providers", "frontier"],
	additionalProperties: false,
} as const;

const PUBLIC_PROVIDER_ITEM_SCHEMA = {
	type: "object",
	properties: {
		status: { enum: ["executed", "scan-backed", "skipped", "failed", "degraded"] },
		reason: { type: "string" },
	},
	required: ["status"],
	additionalProperties: false,
} as const;

const PUBLIC_COLLECTION_SCHEMA = {
	type: "object",
	properties: {
		ref: { type: "string", minLength: 1 },
		kind: { type: "string", minLength: 1 },
		name: { type: "string" },
		observed: { type: "integer", minimum: 0 },
		total: { type: "integer", minimum: 0 },
		completeness: { type: "string" },
		confidence: { type: "string" },
		itemRefs: { type: "array", maxItems: 3, items: { type: "string" } },
		frontierRef: { type: "string" },
	},
	required: ["ref", "kind", "observed", "completeness", "confidence", "itemRefs"],
	additionalProperties: false,
} as const;

export const PAGE_OBSERVATION_VIEW_JSON_SCHEMA = {
	$id: "browser-page-observation-view/v1",
	type: "object",
	properties: {
		schema: PAGE_OBSERVATION_V3_JSON_SCHEMA.properties.schema,
		tool: PAGE_OBSERVATION_V3_JSON_SCHEMA.properties.tool,
		model: PAGE_OBSERVATION_V3_JSON_SCHEMA.properties.model,
		canonical: PAGE_OBSERVATION_V3_JSON_SCHEMA.properties.canonical,
		target: { type: "object", properties: { url: { type: "string" } }, additionalProperties: false },
		snapshot: {
			type: "object",
			properties: { snapshotId: { type: "string" }, capturedAt: { type: "number" }, ttlMs: { type: "number" } },
			required: ["snapshotId", "capturedAt", "ttlMs"],
			additionalProperties: false,
		},
		content: { type: "object", properties: { text: { type: "string", maxLength: 6_000 }, headings: { type: "array", maxItems: 16, items: { type: "string" } }, complete: { type: "boolean" } }, required: ["text", "complete"], additionalProperties: false },
		gist: { type: "object" },
		outline: { type: "array", maxItems: 8, items: { type: "object" } },
		actionables: { type: "array", maxItems: 10, items: PAGE_OBSERVATION_V3_JSON_SCHEMA.properties.actionables.items },
		relations: { type: "object" },
		inference: { type: "object" },
		causal: { type: "object" },
		treeDiff: { type: "object" },
		snapshotProjection: { type: "object", properties: { summary: { type: "object" }, templates: { type: "array", maxItems: 12, items: { type: "object" } } }, additionalProperties: false },
		collections: { type: "array", maxItems: 12, items: PUBLIC_COLLECTION_SCHEMA },
		providers: { type: "object", additionalProperties: PUBLIC_PROVIDER_ITEM_SCHEMA },
		frontier: { type: "object", properties: { items: { type: "array", maxItems: 13, items: FRONTIER_ITEM_SCHEMA } }, required: ["items"], additionalProperties: false },
		diagnostics: { type: "object" },
		nextActions: { type: "array", maxItems: 8, items: { type: "string" } },
	},
	required: ["schema", "tool", "model", "canonical", "target", "snapshot", "providers", "frontier"],
	additionalProperties: false,
} as const;
