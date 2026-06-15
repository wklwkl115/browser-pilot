import type { RefDescriptor } from "../kernels/abml/types.js";

export type ResourceKind =
	| "raw-result"
	| "summary-section"
	| "http-request"
	| "network-entry"
	| "scan"
	| "evidence"
	| "artifact-slice";

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
	descriptor: RefDescriptor;
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
	descriptor: Omit<RefDescriptor, "refId"> & { refId?: string };
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
