export type ResourceKind =
	| "raw-result"
	| "summary-section"
	| "http-request"
	| "network-entry"
	| "scan"
	| "evidence"
	| "artifact-slice";

export type ResourceRefLocator =
	| { by: "backendNodeId"; value: number; targetId?: string }
	| { by: "axNodeId"; value: string }
	| { by: "attrSignature"; value: Record<string, string> }
	| { by: "css"; value: string }
	| { by: "xpath"; value: string }
	| { by: "textAnchor"; value: string; role?: string; exact?: boolean }
	| { by: "point"; x: number; y: number };

export type ResourceRefKind =
	| "element"
	| "control"
	| "text"
	| "media"
	| "ax"
	| "region"
	| "frame"
	| "network-entry"
	| "event"
	| "signal"
	| "data-slice";

export type ResourceRefOwner = {
	browserSessionId?: string;
	tabId?: number;
	frameRef?: string;
	targetId?: string;
	topLevelOrigin?: string;
};

export type ResourceRefPolicy = {
	redaction: "default" | "disabled";
	shareableAcrossSessions: boolean;
	liveActionsAllowed: boolean;
};

export type ResourceSnapshotBinding = {
	observationId: string;
	resourceUri?: string;
	jsonPath?: string;
	etag?: string;
	immutable: boolean;
};

export type ResourceDocumentEpoch = {
	frameId?: string;
	loaderId?: string;
	navigationId?: string;
	url?: string;
	mutationEpoch?: number;
	capturedAt: number;
};

export type ResourceSemanticState = Record<string, boolean>;

export type ResourceRefGeometry = {
	box?: { x: number; y: number; w: number; h: number };
	point?: { x: number; y: number };
};

export type ResourceRefDescriptor = {
	refId: string;
	kind: ResourceRefKind;
	locators: ResourceRefLocator[];
	owner: ResourceRefOwner;
	policy: ResourceRefPolicy;
	snapshot?: ResourceSnapshotBinding;
	semantic?: {
		role?: string;
		name?: string;
		value?: string;
		state?: ResourceSemanticState;
		anchor?: {
			scope: "abml-template";
			confidence: "high" | "low";
			mintingEligible?: boolean;
			containerRole?: string;
			containerName?: string;
			setSize?: number;
			role?: string;
			kind?: string;
			name?: string;
			normalizedName?: string;
			posInSet?: number;
		};
	};
	geometry?: ResourceRefGeometry;
	observationId: string;
	documentEpoch?: ResourceDocumentEpoch;
	createdAt: number;
	ttlMs: number;
	stabilityScore?: number;
};

export type BrowserResultResource = {
	id: string;
	uri: string;
	refId: string;
	kind: ResourceKind;
	artifactPath: string;
	section?: string;
	jsonPath?: string;
	mime?: string;
	bytes?: number;
	hash?: string;
	etag?: string;
	immutable: boolean;
	createdAt: number;
	expiresAt: number;
	browserSessionId?: string;
	redaction: "default" | "disabled";
	name: string;
	description?: string;
};

export type RegisteredRefRecord = {
	refId: string;
	descriptor: ResourceRefDescriptor;
	artifactPath?: string;
	resourceKind?: ResourceKind;
	section?: string;
	jsonPath?: string;
	mime?: string;
	bytes?: number;
	hash?: string;
	etag?: string;
	name?: string;
	description?: string;
	redaction: "default" | "disabled";
	immutable: boolean;
	createdAt: number;
	expiresAt?: number;
	browserSessionId?: string;
};

export type ResolvedRefRecord = RegisteredRefRecord & {
	resourceUri?: string;
	fresh?: boolean;
};

export type ResolveRefResult =
	| { ok: true; ref: ResolvedRefRecord }
	| { ok: false; code: "HANDLE_NOT_FOUND" | "HANDLE_EXPIRED" | "REF_STALE"; error: string };

export type RegisterBrowserResultResourceParams = {
	kind: ResourceKind;
	artifactPath: string;
	name: string;
	description?: string;
	section?: string;
	jsonPath?: string;
	mime?: string;
	bytes?: number;
	immutable?: boolean;
	browserSessionId?: string;
	redaction?: "default" | "disabled";
};

export type RegisterRefDescriptorParams = {
	descriptor: Omit<ResourceRefDescriptor, "refId"> & { refId?: string };
	artifactPath?: string;
	resourceKind?: ResourceKind;
	section?: string;
	mime?: string;
	bytes?: number;
	hash?: string;
	etag?: string;
	name?: string;
	description?: string;
	redaction?: "default" | "disabled";
	immutable?: boolean;
	browserSessionId?: string;
};

export interface ResourceRefStorePort {
	isResourceFresh(resource: BrowserResultResource): boolean;
	registerBrowserResultResource(params: RegisterBrowserResultResourceParams): string;
	registerRefDescriptor(params: RegisterRefDescriptorParams): string;
	resolveResourceUri(uri: string): BrowserResultResource | undefined;
	resolveRefUri(uri: string): ResolvedRefRecord | undefined;
	resolveRefUriDetailed(uri: string): ResolveRefResult;
	listResources(): BrowserResultResource[];
	pruneExpired(): void;
	clearResourceStore(): void;
}
