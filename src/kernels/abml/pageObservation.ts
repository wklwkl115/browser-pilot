import type { CostVector } from "../evidence/cost.js";
import type { Entity } from "./entity.js";
import type { EntityDiff } from "./diff.js";
import type { CausalSummary } from "./causal.js";
import type { TreeDiff } from "./treeDiff.js";
import type { SnapshotProjection } from "./snapshotProjection.js";
import type { RelationSummary } from "./relations.js";
import type { InferenceSummary } from "./inference.js";
import type { PageReanchorReason } from "../session/pageIdentity.js";

export const PAGE_OBSERVATION_SCHEMA_V3 = "browser-page-observation/v3" as const;

export type ObservationFrontierState = "folded" | "viewport-window" | "virtualized" | "paginated" | "lazy" | "truncated" | "unavailable";
export type ObservationFrontierKind = "template-instances" | "collection-window" | "content" | "diagnostics";

export interface ObservationFrontierRead {
	tool: "browser_artifact";
	mode: "json";
	pathRef: "saved.path";
	jsonPath: string;
	offset?: number;
	limit?: number;
}

export interface ObservationFrontierItem {
	ref: string;
	kind: ObservationFrontierKind;
	state: ObservationFrontierState;
	observed?: number;
	total?: number;
	controlRef?: string;
	read?: ObservationFrontierRead;
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
	cost?: CostVector;
}
export type ProviderExecutionReport = Record<string, ProviderExecutionItem>;

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

/** Saved artifacts use the same v3 root while retaining collection evidence. */
export interface CollectionSummary extends CompactCollection {
	collectionId?: string;
	itemRefCount?: number;
	hiddenCount?: number;
	containerRole?: string;
	containerNameContext?: string;
	containerNameSource?: string;
	itemRole?: string;
	continuation?: Record<string, unknown>;
	pageSize?: number;
	paginationControl?: Record<string, unknown>;
	scrollDirection?: string;
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
	saved?: { path?: string };
}

export interface SavedObservationArtifact {
	path: string;
	chars: number;
	bytes: number;
	privacy?: Record<string, unknown>;
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
	limits: { budgetChars: number; cost: CostVector; truncated?: boolean };
	saved?: SavedObservationArtifact;
	artifact_hints?: Record<string, unknown>;
	nextActions?: string[];
}

const COST_VECTOR_SCHEMA = {
	type: "object",
	properties: {
		chars: { type: "integer", minimum: 0 },
		bytes: { type: "integer", minimum: 0 },
		estimatedTokens: { type: "integer", minimum: 0 },
	},
	required: ["chars", "bytes", "estimatedTokens"],
	additionalProperties: false,
} as const;

const FRONTIER_READ_SCHEMA = {
	type: "object",
	properties: {
		tool: { const: "browser_artifact" },
		mode: { const: "json" },
		pathRef: { const: "saved.path" },
		jsonPath: { type: "string", minLength: 1 },
		offset: { type: "integer", minimum: 0 },
		limit: { type: "integer", minimum: 1 },
	},
	required: ["tool", "mode", "pathRef", "jsonPath"],
	additionalProperties: false,
} as const;

const FRONTIER_ITEM_SCHEMA = {
	type: "object",
	properties: {
		ref: { type: "string", minLength: 1 },
		kind: { enum: ["template-instances", "collection-window", "content", "diagnostics"] },
		state: { enum: ["folded", "viewport-window", "virtualized", "paginated", "lazy", "truncated", "unavailable"] },
		observed: { type: "integer", minimum: 0 },
		total: { type: "integer", minimum: 0 },
		controlRef: { type: "string", minLength: 1 },
		read: FRONTIER_READ_SCHEMA,
		unavailableReason: { type: "string", minLength: 1 },
	},
	required: ["ref", "kind", "state"],
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
		cost: COST_VECTOR_SCHEMA,
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
		continuation: { type: "object" }, pageSize: { type: "integer", minimum: 0 }, paginationControl: { type: "object" }, scrollDirection: { type: "string" },
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
				snapshotId: { type: "string" }, browserSessionId: { type: "string" }, tabId: { type: "integer" }, url: { type: "string" }, targetGeneration: { type: "integer" }, pageEpoch: { type: "string" }, documentId: { type: "string" }, frameScope: { type: "string" }, selectionVersion: { type: "integer" }, sourceMode: { type: "string" }, capturedAt: { type: "number" }, ttlMs: { type: "number" }, networkSeq: { type: "integer" }, hookSeq: { type: "integer" }, invalidatedReason: { type: "string" }, expired: { type: "boolean" }, saved: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
			},
			required: ["snapshotId", "sourceMode", "capturedAt", "ttlMs"],
			additionalProperties: false,
		},
		reanchorReason: { enum: ["document_changed", "target_replaced", "session_changed", "identity_unproven", "baseline_missing"] }, delta: { const: "session" }, baselineSnapshotId: { type: "string" },
		gist: { type: "object" }, outline: { type: "array", items: { type: "object" } }, entities: { type: "array", items: { type: "object" } },
		actionables: { type: "array", items: { type: "object", properties: { ref: { type: "string" }, kind: { type: "string" }, name: { type: "string" }, state: { type: "object" } }, required: ["ref", "kind"], additionalProperties: false } },
		relations: { type: "object" }, identity: { type: "object" }, inference: { type: "object" }, diff: { type: "object" }, causal: { type: "object" }, treeDiff: { type: "object" }, snapshotProjection: { type: "object" }, collections: { type: "array", items: COLLECTION_SCHEMA },
		providers: { type: "object", additionalProperties: PROVIDER_ITEM_SCHEMA },
		frontier: { type: "object", properties: { items: { type: "array", items: FRONTIER_ITEM_SCHEMA } }, required: ["items"], additionalProperties: false },
		diagnostics: { type: "object" },
		limits: { type: "object", properties: { budgetChars: { type: "integer", minimum: 1 }, cost: COST_VECTOR_SCHEMA, truncated: { type: "boolean" } }, required: ["budgetChars", "cost"], additionalProperties: false },
		saved: { type: "object", properties: { path: { type: "string" }, chars: { type: "integer", minimum: 0 }, bytes: { type: "integer", minimum: 0 }, privacy: { type: "object" } }, required: ["path", "chars", "bytes"], additionalProperties: false },
		artifact_hints: {
			type: "object",
			properties: {
				jsonPaths: { type: "object", additionalProperties: { type: "string" } },
				preferredReads: {
					type: "array",
					items: { type: "object", properties: { label: { type: "string" }, jsonPath: { type: "string" }, kind: { type: "string" } }, required: ["label", "jsonPath", "kind"], additionalProperties: false },
				},
			},
			additionalProperties: false,
		},
		nextActions: { type: "array", items: { type: "string" } },
	},
	required: ["schema", "tool", "model", "canonical", "target", "snapshot", "providers", "frontier", "limits"],
	additionalProperties: false,
} as const;

const PAGE_OBSERVATION_ROOT_KEYS = new Set(Object.keys(PAGE_OBSERVATION_V3_JSON_SCHEMA.properties));
const COST_KEYS = new Set(["chars", "bytes", "estimatedTokens"]);
const TARGET_KEYS = new Set(["browserSessionId", "tabId", "targetGeneration", "pageEpoch", "url"]);
const SNAPSHOT_KEYS = new Set(["snapshotId", "browserSessionId", "tabId", "url", "targetGeneration", "pageEpoch", "documentId", "frameScope", "selectionVersion", "sourceMode", "capturedAt", "ttlMs", "networkSeq", "hookSeq", "invalidatedReason", "expired", "saved"]);
const PROVIDER_KEYS = new Set(["planned", "status", "reason", "reservedMs", "actualMs", "bridgeRoundTrips", "cost"]);
const FRONTIER_KEYS = new Set(["ref", "kind", "state", "observed", "total", "controlRef", "read", "unavailableReason"]);
const FRONTIER_READ_KEYS = new Set(["tool", "mode", "pathRef", "jsonPath", "offset", "limit"]);
const LIMIT_KEYS = new Set(["budgetChars", "cost", "truncated"]);
const SAVED_KEYS = new Set(["path", "chars", "bytes", "privacy"]);
const ACTIONABLE_KEYS = new Set(["ref", "kind", "name", "state"]);
const COLLECTION_KEYS = new Set(Object.keys(COLLECTION_SCHEMA.properties));

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function validCost(value: unknown): value is CostVector {
	return isRecord(value)
		&& exactKeys(value, COST_KEYS)
		&& [value.chars, value.bytes, value.estimatedTokens].every((item) => typeof item === "number" && Number.isInteger(item) && item >= 0);
}

function validFrontier(value: unknown): value is ObservationFrontier {
	if (!isRecord(value) || !exactKeys(value, new Set(["items"])) || !Array.isArray(value.items)) return false;
	return value.items.every((raw) => {
		if (!isRecord(raw) || !exactKeys(raw, FRONTIER_KEYS)) return false;
		if (typeof raw.ref !== "string" || !["template-instances", "collection-window", "content", "diagnostics"].includes(String(raw.kind))) return false;
		if (!["folded", "viewport-window", "virtualized", "paginated", "lazy", "truncated", "unavailable"].includes(String(raw.state))) return false;
		if (raw.read === undefined) return typeof raw.unavailableReason === "string" && raw.unavailableReason.length > 0;
		return isRecord(raw.read)
			&& exactKeys(raw.read, FRONTIER_READ_KEYS)
			&& raw.read.tool === "browser_artifact" && raw.read.mode === "json" && raw.read.pathRef === "saved.path" && typeof raw.read.jsonPath === "string" && raw.read.jsonPath.length > 0;
	});
}

function validOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function validOptionalInteger(value: unknown): boolean {
	return value === undefined || typeof value === "number" && Number.isInteger(value);
}

function validTarget(value: unknown): value is PageTarget {
	return isRecord(value)
		&& exactKeys(value, TARGET_KEYS)
		&& validOptionalString(value.browserSessionId) && validOptionalInteger(value.tabId)
		&& validOptionalInteger(value.targetGeneration) && validOptionalString(value.pageEpoch) && validOptionalString(value.url);
}

function validSnapshot(value: unknown): value is ObservationSnapshot {
	if (!isRecord(value) || !exactKeys(value, SNAPSHOT_KEYS)) return false;
	if (typeof value.snapshotId !== "string" || typeof value.sourceMode !== "string" || typeof value.capturedAt !== "number" || typeof value.ttlMs !== "number") return false;
	if (![value.capturedAt, value.ttlMs].every((item) => Number.isFinite(item))) return false;
	if (![value.tabId, value.targetGeneration, value.selectionVersion, value.networkSeq, value.hookSeq].every(validOptionalInteger)) return false;
	if (![value.browserSessionId, value.url, value.pageEpoch, value.documentId, value.frameScope, value.invalidatedReason].every(validOptionalString)) return false;
	if (value.expired !== undefined && typeof value.expired !== "boolean") return false;
	return value.saved === undefined || isRecord(value.saved) && exactKeys(value.saved, new Set(["path"])) && validOptionalString(value.saved.path);
}

function validProvider(value: unknown): value is ProviderExecutionItem {
	if (!isRecord(value) || !exactKeys(value, PROVIDER_KEYS) || typeof value.planned !== "boolean") return false;
	if (!["executed", "scan-backed", "skipped", "failed", "degraded"].includes(String(value.status))) return false;
	if (!validOptionalString(value.reason)) return false;
	if (![value.reservedMs, value.actualMs].every((item) => item === undefined || typeof item === "number" && Number.isFinite(item) && item >= 0)) return false;
	if (value.bridgeRoundTrips !== undefined && (!Number.isInteger(value.bridgeRoundTrips) || Number(value.bridgeRoundTrips) < 0)) return false;
	return value.cost === undefined || validCost(value.cost);
}

function validLimits(value: unknown): value is PageObservationV3["limits"] {
	return isRecord(value) && exactKeys(value, LIMIT_KEYS)
		&& typeof value.budgetChars === "number" && Number.isInteger(value.budgetChars) && value.budgetChars >= 1
		&& validCost(value.cost) && (value.truncated === undefined || typeof value.truncated === "boolean");
}

function validSaved(value: unknown): value is SavedObservationArtifact {
	return isRecord(value) && exactKeys(value, SAVED_KEYS) && typeof value.path === "string"
		&& typeof value.chars === "number" && Number.isInteger(value.chars) && value.chars >= 0
		&& typeof value.bytes === "number" && Number.isInteger(value.bytes) && value.bytes >= 0
		&& (value.privacy === undefined || isRecord(value.privacy));
}

function validActionables(value: unknown): boolean {
	return value === undefined || Array.isArray(value) && value.every((item) => isRecord(item) && exactKeys(item, ACTIONABLE_KEYS) && typeof item.ref === "string" && typeof item.kind === "string" && validOptionalString(item.name) && (item.state === undefined || isRecord(item.state)));
}

function validCollections(value: unknown): boolean {
	return value === undefined || Array.isArray(value) && value.every((item) => isRecord(item) && exactKeys(item, COLLECTION_KEYS)
		&& typeof item.ref === "string" && typeof item.kind === "string" && typeof item.observed === "number" && Number.isInteger(item.observed)
		&& typeof item.completeness === "string" && typeof item.confidence === "string" && Array.isArray(item.itemRefs) && item.itemRefs.every((ref) => typeof ref === "string"));
}

/** Strict runtime guard used at cache/artifact boundaries. */
export function isPageObservationV3(value: unknown): value is PageObservationV3 {
	if (!isRecord(value) || !exactKeys(value, PAGE_OBSERVATION_ROOT_KEYS)) return false;
	if (value.schema !== PAGE_OBSERVATION_SCHEMA_V3 || value.tool !== "browser_observe" || value.model !== "PageObservation" || value.canonical !== true) return false;
	if (!validTarget(value.target) || !validSnapshot(value.snapshot) || !isRecord(value.providers) || !validFrontier(value.frontier) || !validLimits(value.limits)) return false;
	if (!Object.values(value.providers).every(validProvider) || !validActionables(value.actionables) || !validCollections(value.collections)) return false;
	if (value.saved !== undefined && !validSaved(value.saved)) return false;
	if (value.nextActions !== undefined && (!Array.isArray(value.nextActions) || !value.nextActions.every((item) => typeof item === "string"))) return false;
	return true;
}
