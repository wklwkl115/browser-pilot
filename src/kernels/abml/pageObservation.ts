import type { Entity, EntityAction, EntityState } from "./entity.js";
import type { EntityDiff } from "./diff.js";
import type { CausalSummary } from "./causal.js";
import type { TreeDiff } from "./treeDiff.js";
import type { SnapshotProjection } from "./snapshotProjection.js";
import type { RelationSummary } from "./relations.js";
import type { InferenceSummary } from "./inference.js";
import type { PageReanchorReason } from "../session/pageIdentity.js";

export const PAGE_OBSERVATION_SCHEMA_V3 = "browser-page-observation/v3" as const;

export type ObservationFrontierState = "folded" | "viewport-window" | "virtualized" | "paginated" | "lazy" | "unavailable";
export type ObservationFrontierKind = "action-space" | "template-instances" | "collection-window" | "content" | "details";

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
	role: string;
	name?: string;
	actions: EntityAction[];
	hint?: string;
	confidence: "high" | "medium";
	scope?: { id: string; position?: number };
	state?: Partial<EntityState>;
}

export interface AgentActionSpace {
	defaults: { state: EntityState };
	coverage: { captured: number; returned: number; captureComplete: boolean; projectionComplete: boolean };
	scopes: Array<{ id: string; name?: string; size?: number }>;
	items: CompactActionable[];
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

export interface VisualObservation {
	ref: string;
	resourceUri: string;
	captureMethod: string;
	actionableGrounding: boolean;
	coordinateSpace: "normalized-image";
	image: { width: number; height: number; sha256: string };
	basis: {
		observationId: string;
		changeSeq: number;
		url?: string;
		scrollX: number;
		scrollY: number;
		viewportWidth: number;
		viewportHeight: number;
		devicePixelRatio: number;
		imageToCss: [number, number, number, number, number, number];
	};
	targets: Array<{ ref: string; box: { x: number; y: number; w: number; h: number } }>;
}

/** Saved artifacts use the same v3 root while retaining collection evidence. */
export interface CollectionSummary extends CompactCollection {
	collectionId?: string;
	itemRefCount?: number;
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
	visual?: VisualObservation;
	gist?: Record<string, unknown>;
	outline?: Array<Record<string, unknown>>;
	entities?: Entity[];
	actionSpace?: AgentActionSpace;
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
	canonical: false;
	target: Pick<PageTarget, "url">;
	snapshot: Pick<ObservationSnapshot, "snapshotId" | "capturedAt" | "ttlMs">;
	content?: PageObservationContent;
	visual?: VisualObservation;
	gist?: Record<string, unknown>;
	outline?: Array<Record<string, unknown>>;
	actionSpace?: AgentActionSpace;
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
		kind: { enum: ["action-space", "template-instances", "collection-window", "content", "details"] },
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

const ENTITY_STATE_PROPERTIES = {
	visible: { type: "boolean" }, occluded: { type: "boolean" }, disabled: { type: "boolean" }, focused: { type: "boolean" },
	checked: { type: "boolean" }, selected: { type: "boolean" }, pressed: { type: "boolean" }, expanded: { type: "boolean" },
	current: { anyOf: [{ type: "boolean" }, { type: "string" }] }, editable: { type: "boolean" }, inViewport: { type: "boolean" },
} as const;

const ACTION_SPACE_SCHEMA = {
	type: "object",
	properties: {
		defaults: { type: "object", properties: { state: { type: "object", properties: ENTITY_STATE_PROPERTIES, required: ["visible", "occluded", "disabled", "focused", "editable", "inViewport"], additionalProperties: false } }, required: ["state"], additionalProperties: false },
		coverage: { type: "object", properties: { captured: { type: "integer", minimum: 0 }, returned: { type: "integer", minimum: 0 }, captureComplete: { type: "boolean" }, projectionComplete: { type: "boolean" } }, required: ["captured", "returned", "captureComplete", "projectionComplete"], additionalProperties: false },
		scopes: { type: "array", items: { type: "object", properties: { id: { type: "string", minLength: 1 }, name: { type: "string" }, size: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false } },
		items: { type: "array", items: { type: "object", properties: {
			ref: { type: "string", minLength: 1 }, kind: { type: "string", minLength: 1 }, role: { type: "string", minLength: 1 }, name: { type: "string" },
			actions: { type: "array", minItems: 1, items: { enum: ["click", "edit"] } }, hint: { type: "string" }, confidence: { enum: ["high", "medium"] },
			scope: { type: "object", properties: { id: { type: "string", minLength: 1 }, position: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false },
			state: { type: "object", properties: ENTITY_STATE_PROPERTIES, additionalProperties: false },
		}, required: ["ref", "kind", "role", "actions", "confidence"], additionalProperties: false } },
	},
	required: ["defaults", "coverage", "scopes", "items"],
	additionalProperties: false,
} as const;

const VISUAL_OBSERVATION_SCHEMA = {
	type: "object",
	properties: {
		ref: { type: "string", pattern: "^bp-ref://" },
		resourceUri: { type: "string", pattern: "^browser-pilot://artifact/" },
		captureMethod: { type: "string", minLength: 1 },
		actionableGrounding: { type: "boolean" },
		coordinateSpace: { const: "normalized-image" },
		image: { type: "object", properties: { width: { type: "number", exclusiveMinimum: 0 }, height: { type: "number", exclusiveMinimum: 0 }, sha256: { type: "string", pattern: "^[0-9a-f]{64}$" } }, required: ["width", "height", "sha256"], additionalProperties: false },
		basis: {
			type: "object",
			properties: {
				observationId: { type: "string", minLength: 1 }, changeSeq: { type: "number" }, url: { type: "string" },
				scrollX: { type: "number" }, scrollY: { type: "number" }, viewportWidth: { type: "number", exclusiveMinimum: 0 }, viewportHeight: { type: "number", exclusiveMinimum: 0 }, devicePixelRatio: { type: "number", exclusiveMinimum: 0 },
				imageToCss: { type: "array", minItems: 6, maxItems: 6, items: { type: "number" } },
			},
			required: ["observationId", "changeSeq", "scrollX", "scrollY", "viewportWidth", "viewportHeight", "devicePixelRatio", "imageToCss"],
			additionalProperties: false,
		},
		targets: { type: "array", maxItems: 128, items: { type: "object", properties: { ref: { type: "string", pattern: "^bp-ref://" }, box: { type: "object", properties: { x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 }, w: { type: "number", minimum: 0, maximum: 1 }, h: { type: "number", minimum: 0, maximum: 1 } }, required: ["x", "y", "w", "h"], additionalProperties: false } }, required: ["ref", "box"], additionalProperties: false } },
	},
	required: ["ref", "resourceUri", "captureMethod", "actionableGrounding", "coordinateSpace", "image", "basis", "targets"],
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
		itemRefs: { type: "array", items: { type: "string" } }, frontierRef: { type: "string" }, collectionId: { type: "string" }, itemRefCount: { type: "integer", minimum: 0 },
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
		visual: VISUAL_OBSERVATION_SCHEMA,
		gist: { type: "object" }, outline: { type: "array", items: { type: "object" } }, entities: { type: "array", items: { type: "object" } },
		actionSpace: ACTION_SPACE_SCHEMA,
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
		canonical: { const: false },
		target: { type: "object", properties: { url: { type: "string" } }, additionalProperties: false },
		snapshot: {
			type: "object",
			properties: { snapshotId: { type: "string" }, capturedAt: { type: "number" }, ttlMs: { type: "number" } },
			required: ["snapshotId", "capturedAt", "ttlMs"],
			additionalProperties: false,
		},
		content: { type: "object", properties: { text: { type: "string", maxLength: 6_000 }, headings: { type: "array", maxItems: 16, items: { type: "string" } }, complete: { type: "boolean" } }, required: ["text", "complete"], additionalProperties: false },
		visual: VISUAL_OBSERVATION_SCHEMA,
		gist: { type: "object" },
		outline: { type: "array", maxItems: 8, items: { type: "object" } },
		actionSpace: ACTION_SPACE_SCHEMA,
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
