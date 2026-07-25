import type { Entity, EntityAction, EntityState } from "./entity.js";
import type { EntityDiff } from "./diff.js";
import type { CausalEvent, CausalRequest, CausalSummary } from "./causal.js";
import type { TreeDiff } from "./treeDiff.js";
import type { SnapshotProjection } from "./snapshotProjection.js";
import type { RelationSummary } from "./relations.js";
import type { DetectedIntent, InferenceSummary } from "./inference.js";
import type { PageReanchorReason } from "../session/pageIdentity.js";

export const PAGE_OBSERVATION_SCHEMA_V3 = "browser-page-observation/v3" as const;

export type ObservationFrontierState = "folded" | "viewport-window" | "virtualized" | "paginated" | "lazy" | "unavailable";
export type ObservationFrontierKind = "action-space" | "collection-window" | "content" | "details";

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
}
export type ProviderExecutionReport = Record<string, ProviderExecutionItem>;

export interface CompactActionable {
	ref: string;
	kind: string;
	role: string;
	name?: string;
	actions: EntityAction[];
	hint?: string;
	confidence: "high" | "medium";
	scope?: { id: string; position?: number };
	state: EntityState;
}

export interface AgentActionSpace {
	coverage: { captured: number; captureComplete: boolean };
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

export type PublicVisualObservation = Pick<VisualObservation, "ref" | "resourceUri" | "actionableGrounding" | "coordinateSpace" | "targets"> & {
	image: Pick<VisualObservation["image"], "width" | "height">;
};

export type PublicCausalSummary =
	| { requests: CausalRequest[]; requestCount?: number; events?: CausalEvent[]; eventCount?: number }
	| { unavailable: string; events?: CausalEvent[]; eventCount?: number };

export type PublicInferenceSummary = { intents: Array<Pick<DetectedIntent, "intent" | "confidence" | "reason"> & { refs?: string[] }> };
export type PublicRelationSummary = { summary: RelationSummary["summary"]; highlights: Array<Pick<RelationSummary["highlights"][number], "type" | "sourceRef" | "targetRef">>; highlightCount?: number };

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
	target: Pick<PageTarget, "url">;
	content?: PageObservationContent;
	visual?: PublicVisualObservation;
	gist?: Record<string, unknown>;
	outline?: Array<Record<string, unknown>>;
	actionSpace?: AgentActionSpace;
	relations?: PublicRelationSummary;
	inference?: PublicInferenceSummary;
	causal?: PublicCausalSummary;
	treeDiff?: Pick<TreeDiff, "summary">;
	collections?: CompactCollection[];
	frontier?: ObservationFrontier;
	warnings?: string[];
	nextActions?: string[];
}

const FRONTIER_ITEM_SCHEMA = {
	type: "object",
	properties: {
		ref: { type: "string", minLength: 1 },
		kind: { enum: ["action-space", "collection-window", "content", "details"] },
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
		coverage: { type: "object", properties: { captured: { type: "integer", minimum: 0 }, captureComplete: { type: "boolean" } }, required: ["captured", "captureComplete"], additionalProperties: false },
		scopes: { type: "array", items: { type: "object", properties: { id: { type: "string", minLength: 1 }, name: { type: "string" }, size: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false } },
		items: { type: "array", items: { type: "object", properties: {
			ref: { type: "string", minLength: 1 }, kind: { type: "string", minLength: 1 }, role: { type: "string", minLength: 1 }, name: { type: "string" },
			actions: { type: "array", minItems: 1, items: { enum: ["click", "edit"] } }, hint: { type: "string" }, confidence: { enum: ["high", "medium"] },
			scope: { type: "object", properties: { id: { type: "string", minLength: 1 }, position: { type: "integer", minimum: 1 } }, required: ["id"], additionalProperties: false },
			state: { type: "object", properties: ENTITY_STATE_PROPERTIES, required: ["visible", "occluded", "disabled", "focused", "editable", "inViewport"], additionalProperties: false },
		}, required: ["ref", "kind", "role", "actions", "confidence", "state"], additionalProperties: false } },
	},
	required: ["coverage", "scopes", "items"],
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

const PUBLIC_VISUAL_OBSERVATION_SCHEMA = {
	type: "object",
	properties: {
		ref: { type: "string", pattern: "^bp-ref://" },
		resourceUri: { type: "string", pattern: "^browser-pilot://artifact/" },
		actionableGrounding: { type: "boolean" },
		coordinateSpace: { const: "normalized-image" },
		image: { type: "object", properties: { width: { type: "number", exclusiveMinimum: 0 }, height: { type: "number", exclusiveMinimum: 0 } }, required: ["width", "height"], additionalProperties: false },
		targets: { type: "array", maxItems: 128, items: { type: "object", properties: { ref: { type: "string", pattern: "^bp-ref://" }, box: { type: "object", properties: { x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 }, w: { type: "number", minimum: 0, maximum: 1 }, h: { type: "number", minimum: 0, maximum: 1 } }, required: ["x", "y", "w", "h"], additionalProperties: false } }, required: ["ref", "box"], additionalProperties: false } },
	},
	required: ["ref", "resourceUri", "actionableGrounding", "coordinateSpace", "image", "targets"],
	additionalProperties: false,
} as const;

const GIST_SCHEMA = {
	type: "object",
	properties: {
		title: { type: "string" },
		landmarks: { type: "array", items: { type: "string" } },
	},
	additionalProperties: false,
} as const;

const OUTLINE_ITEM_SCHEMA = {
	type: "object",
	properties: {
		container: { type: "string" }, name: { type: "string" }, memberCount: { type: "integer", minimum: 0 }, controlCount: { type: "integer", minimum: 0 },
		memberRefs: { type: "array", maxItems: 3, items: { type: "string", pattern: "^bp-ref://" } },
	},
	required: ["container", "memberCount", "memberRefs"],
	additionalProperties: false,
} as const;

const RELATIONS_SCHEMA = {
	type: "object",
	properties: {
		summary: { type: "object", additionalProperties: { type: "integer", minimum: 0 } },
		highlights: { type: "array", maxItems: 3, items: { type: "object", properties: {
			type: { type: "string" }, sourceRef: { type: "string", pattern: "^bp-ref://" }, targetRef: { type: "string", pattern: "^bp-ref://" },
		}, required: ["type", "sourceRef", "targetRef"], additionalProperties: false } },
		highlightCount: { type: "integer", minimum: 0 },
	},
	required: ["summary", "highlights"],
	additionalProperties: false,
} as const;

const INFERENCE_SCHEMA = {
	type: "object",
	properties: {
		intents: { type: "array", items: { type: "object", properties: {
			intent: { enum: ["login", "search", "filter-panel", "single-choice", "multi-choice", "expandable", "data-grid", "navigation", "dialog", "tabbed-interface", "alert-region", "form-dependency"] },
			confidence: { enum: ["high", "medium", "low"] }, reason: { type: "string" }, refs: { type: "array", items: { type: "string", pattern: "^bp-ref://" } },
		}, required: ["intent", "confidence"], additionalProperties: false } },
	},
	required: ["intents"],
	additionalProperties: false,
} as const;

const CAUSAL_REQUEST_SCHEMA = {
	type: "object",
	properties: {
		ref: { type: "string", pattern: "^bp-ref://" }, method: { type: "string" }, url: { type: "string" }, status: { type: "number" }, type: { type: "string" }, at: { type: "number" }, initiatorType: { type: "string" }, passive: { type: "boolean" },
	},
	required: ["ref"],
	additionalProperties: false,
} as const;

const CAUSAL_EVENT_SCHEMA = {
	type: "object",
	properties: { ref: { type: "string", pattern: "^bp-ref://" }, type: { type: "string" }, at: { type: "number" }, summary: { type: "string" }, selector: { type: "string" } },
	required: ["ref", "type"],
	additionalProperties: false,
} as const;

const CAUSAL_SCHEMA = {
	anyOf: [
		{ type: "object", properties: { requests: { type: "array", maxItems: 3, items: CAUSAL_REQUEST_SCHEMA }, requestCount: { type: "integer", minimum: 0 }, events: { type: "array", maxItems: 3, items: CAUSAL_EVENT_SCHEMA }, eventCount: { type: "integer", minimum: 0 } }, required: ["requests"], additionalProperties: false },
		{ type: "object", properties: { unavailable: { type: "string" }, events: { type: "array", maxItems: 3, items: CAUSAL_EVENT_SCHEMA }, eventCount: { type: "integer", minimum: 0 } }, required: ["unavailable"], additionalProperties: false },
	],
} as const;

const TREE_DIFF_SCHEMA = {
	type: "object",
	properties: {
		summary: { type: "object", properties: {
			templateCount: { type: "integer", minimum: 0 }, changedTemplateCount: { type: "integer", minimum: 0 }, appeared: { type: "integer", minimum: 0 }, disappeared: { type: "integer", minimum: 0 }, changed: { type: "integer", minimum: 0 }, reordered: { type: "integer", minimum: 0 },
			sample: { type: "object", properties: { appeared: { type: "array", items: { type: "string" } }, disappeared: { type: "array", items: { type: "string" } }, changed: { type: "array", items: { type: "string" } } }, additionalProperties: false },
			partialBaseline: { type: "boolean" }, unavailable: { type: "string" },
		}, required: ["templateCount", "changedTemplateCount", "appeared", "disappeared", "changed", "reordered"], additionalProperties: false },
	},
	required: ["summary"],
	additionalProperties: false,
} as const;

export const PAGE_OBSERVATION_VIEW_JSON_SCHEMA = {
	$id: "browser-page-observation-view/v2",
	type: "object",
	properties: {
		target: { type: "object", properties: { url: { type: "string" } }, additionalProperties: false },
		content: { type: "object", properties: { text: { type: "string", maxLength: 6_000 }, headings: { type: "array", maxItems: 16, items: { type: "string" } }, complete: { type: "boolean" } }, required: ["text", "complete"], additionalProperties: false },
		visual: PUBLIC_VISUAL_OBSERVATION_SCHEMA,
		gist: GIST_SCHEMA,
		outline: { type: "array", maxItems: 8, items: OUTLINE_ITEM_SCHEMA },
		actionSpace: ACTION_SPACE_SCHEMA,
		relations: RELATIONS_SCHEMA,
		inference: INFERENCE_SCHEMA,
		causal: CAUSAL_SCHEMA,
		treeDiff: TREE_DIFF_SCHEMA,
		collections: { type: "array", maxItems: 12, items: PUBLIC_COLLECTION_SCHEMA },
		frontier: { type: "object", properties: { items: { type: "array", maxItems: 13, items: FRONTIER_ITEM_SCHEMA } }, required: ["items"], additionalProperties: false },
		warnings: { type: "array", items: { type: "string" } },
		nextActions: { type: "array", maxItems: 8, items: { type: "string" } },
	},
	required: ["target"],
	additionalProperties: false,
} as const;
