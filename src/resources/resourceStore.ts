/**
 * MCP browser result resource store / ABML ref registry.
 *
 * Maintains the existing browser-result:// resource registry and a generic
 * pi-ref:// registry. browser-result:// remains the externally visible MCP
 * resource surface; pi-ref:// is the ABML ref surface. A browser-result://
 * resource is also resolvable as a kind:"data-slice" pi-ref wrapper.
 *
 * Invariants:
 * - No local path is returned in URIs or resource metadata.
 * - browser-result:// compatibility is preserved.
 * - pi-ref:// wrappers inherit TTL / etag / redaction / session binding.
 * - Expired resources/refs are pruned on registration and resolution.
 */
import { randomUUID } from "node:crypto";
import type { RefDescriptor, RefKind } from "../abml/types.js";
import { defaultRefPolicyForKind } from "../abml/refPolicy.js";
import { computeContentHash, computeEtag, isFreshEtag } from "./resourceFreshness.js";

export const RESOURCE_URI_SCHEME = "browser-result";
export const PI_REF_URI_SCHEME = "pi-ref";
const TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * True if the artifact on disk still matches the etag recorded at registration.
 * A mismatch means the file was rewritten/replaced under the handle (staleness).
 */
export function isResourceFresh(resource: BrowserResultResource): boolean {
	return isFreshEtag(resource.artifactPath, resource.etag);
}

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

const resourceStore = new Map<string, BrowserResultResource>();
const refStore = new Map<string, RegisteredRefRecord>();

/** Construct the opaque URI for a given resource id. */
function makeUri(id: string): string {
	return `${RESOURCE_URI_SCHEME}://${id}`;
}

function makePiRefUri(kind: RefKind, id: string): string {
	return `${PI_REF_URI_SCHEME}://${kind}/${id}`;
}

function wrapperPiRefUriForResource(resource: Pick<BrowserResultResource, "id">): string {
	return makePiRefUri("data-slice", resource.id);
}

/** Extract id from a `browser-result://{id}` URI. Returns undefined for unrecognized URIs. */
export function parseResourceUri(uri: string): string | undefined {
	const prefix = `${RESOURCE_URI_SCHEME}://`;
	if (!uri.startsWith(prefix)) return undefined;
	const id = uri.slice(prefix.length).split("/")[0].split("?")[0];
	return id || undefined;
}

export function parsePiRefUri(uri: string): { kind?: RefKind; id: string } | undefined {
	const prefix = `${PI_REF_URI_SCHEME}://`;
	if (!uri.startsWith(prefix)) return undefined;
	const rest = uri.slice(prefix.length).split("?")[0];
	const segments = rest.split("/").filter(Boolean);
	if (segments.length === 1) return { id: segments[0] };
	if (segments.length >= 2) return { kind: segments[0] as RefKind, id: segments[segments.length - 1] };
	return undefined;
}

function ttlMsFor(resource: Pick<BrowserResultResource, "createdAt" | "expiresAt">): number {
	return Math.max(0, resource.expiresAt - resource.createdAt);
}

function resourceToDataSliceRef(resource: BrowserResultResource): RefDescriptor {
	return {
		refId: resource.refId,
		kind: "data-slice",
		locators: [],
		owner: {
			...(resource.browserSessionId ? { browserSessionId: resource.browserSessionId } : {}),
		},
		policy: defaultRefPolicyForKind("data-slice", {
			hasOwnerBinding: Boolean(resource.browserSessionId),
			sensitive: resource.redaction === "disabled",
		}),
		snapshot: {
			observationId: `browser-result:${resource.id}`,
			resourceUri: resource.uri,
			jsonPath: resource.jsonPath,
			etag: resource.etag,
			immutable: resource.immutable,
		},
		observationId: `browser-result:${resource.id}`,
		createdAt: resource.createdAt,
		ttlMs: ttlMsFor(resource),
	};
}

function resourceToResolvedRef(resource: BrowserResultResource): ResolvedRefRecord {
	return {
		refId: resource.refId,
		descriptor: resourceToDataSliceRef(resource),
		artifactPath: resource.artifactPath,
		resourceKind: resource.kind,
		section: resource.section,
		jsonPath: resource.jsonPath,
		mime: resource.mime,
		bytes: resource.bytes,
		hash: resource.hash,
		etag: resource.etag,
		name: resource.name,
		description: resource.description,
		redaction: resource.redaction,
		immutable: resource.immutable,
		createdAt: resource.createdAt,
		expiresAt: resource.expiresAt,
		browserSessionId: resource.browserSessionId,
		resourceUri: resource.uri,
		fresh: !resource.etag || isFreshEtag(resource.artifactPath, resource.etag),
	};
}

function resolveStoredResourceUriDetailed(uri: string):
	| { ok: true; resource: BrowserResultResource }
	| { ok: false; code: "HANDLE_NOT_FOUND" | "HANDLE_EXPIRED"; error: string } {
	const id = parseResourceUri(uri);
	if (!id) return { ok: false, code: "HANDLE_NOT_FOUND", error: `Unrecognized resource URI: ${uri}` };
	const resource = resourceStore.get(id);
	if (!resource) return { ok: false, code: "HANDLE_NOT_FOUND", error: `Resource not found: ${uri}` };
	if (Date.now() > resource.expiresAt) {
		resourceStore.delete(id);
		return { ok: false, code: "HANDLE_EXPIRED", error: `Resource expired: ${uri}` };
	}
	return { ok: true, resource };
}

function resolveStoredRefRecordDetailed(parsed: { id: string }):
	| { ok: true; record: RegisteredRefRecord }
	| { ok: false; code: "REF_STALE" | "HANDLE_NOT_FOUND"; error: string } {
	const record = refStore.get(parsed.id);
	if (!record) return { ok: false, code: "HANDLE_NOT_FOUND", error: `Ref not found: ${parsed.id}` };
	if (Date.now() > record.descriptor.createdAt + record.descriptor.ttlMs) {
		refStore.delete(parsed.id);
		return { ok: false, code: "REF_STALE", error: `Ref expired: ${record.refId}` };
	}
	return { ok: true, record };
}

function normalizeResolvedRef(record: RegisteredRefRecord): ResolveRefResult {
	if (Date.now() > record.descriptor.createdAt + record.descriptor.ttlMs) {
		const parsed = parsePiRefUri(record.refId);
		if (parsed) refStore.delete(parsed.id);
		return { ok: false, code: "REF_STALE", error: `Ref expired: ${record.refId}` };
	}
	if (record.artifactPath) {
		return {
			ok: true,
			ref: {
				...record,
				fresh: !record.etag || isFreshEtag(record.artifactPath, record.etag),
			},
		};
	}
	const backingUri = record.descriptor.snapshot?.resourceUri;
	if (backingUri && parseResourceUri(backingUri)) {
		const resolved = resolveStoredResourceUriDetailed(backingUri);
		if (!resolved.ok) return resolved;
		return {
			ok: true,
			ref: {
				...record,
				artifactPath: resolved.resource.artifactPath,
				resourceKind: record.resourceKind ?? resolved.resource.kind,
				section: record.section ?? resolved.resource.section,
				jsonPath: record.jsonPath ?? record.descriptor.snapshot?.jsonPath ?? resolved.resource.jsonPath,
				mime: record.mime ?? resolved.resource.mime,
				bytes: record.bytes ?? resolved.resource.bytes,
				hash: record.hash ?? resolved.resource.hash,
				etag: record.etag ?? resolved.resource.etag,
				name: record.name ?? resolved.resource.name,
				description: record.description ?? resolved.resource.description,
				redaction: record.redaction,
				immutable: record.immutable,
				createdAt: record.createdAt,
				expiresAt: resolved.resource.expiresAt,
				browserSessionId: record.browserSessionId ?? resolved.resource.browserSessionId,
				resourceUri: resolved.resource.uri,
				fresh: !resolved.resource.etag || isFreshEtag(resolved.resource.artifactPath, resolved.resource.etag),
			},
		};
	}
	return { ok: true, ref: { ...record } };
}

/** Register a new resource and return its URI. Never exposes local path. */
export function registerBrowserResultResource(params: {
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
}): string {
	pruneExpired();
	const id = randomUUID();
	const uri = makeUri(id);
	const now = Date.now();
	const etag = computeEtag(params.artifactPath);
	const hash = params.kind === "http-request" ? computeContentHash(params.artifactPath, params.jsonPath) : undefined;
	const resource: BrowserResultResource = {
		id,
		uri,
		refId: wrapperPiRefUriForResource({ id }),
		kind: params.kind,
		artifactPath: params.artifactPath,
		section: params.section,
		jsonPath: params.jsonPath,
		mime: params.mime,
		bytes: params.bytes,
		hash,
		etag,
		immutable: params.immutable ?? true,
		createdAt: now,
		expiresAt: now + TTL_MS,
		browserSessionId: params.browserSessionId,
		redaction: params.redaction ?? "default",
		name: params.name,
		description: params.description,
	};
	resourceStore.set(id, resource);
	return uri;
}

export function registerRefDescriptor(params: {
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
}): string {
	pruneExpired();
	const refId = params.descriptor.refId || makePiRefUri(params.descriptor.kind, randomUUID());
	const parsed = parsePiRefUri(refId);
	if (!parsed) throw new Error(`Invalid pi-ref URI: ${refId}`);
	const jsonPath = params.descriptor.snapshot?.jsonPath;
	const artifactPath = params.artifactPath;
	const etag = params.etag ?? (artifactPath ? computeEtag(artifactPath) : params.descriptor.snapshot?.etag);
	const hash = params.hash ?? (artifactPath && params.resourceKind === "http-request" ? computeContentHash(artifactPath, jsonPath) : undefined);
	const descriptor: RefDescriptor = { ...params.descriptor, refId };
	refStore.set(parsed.id, {
		refId,
		descriptor,
		artifactPath,
		resourceKind: params.resourceKind,
		section: params.section,
		jsonPath,
		mime: params.mime,
		bytes: params.bytes,
		hash,
		etag,
		name: params.name,
		description: params.description,
		redaction: params.redaction ?? descriptor.policy.redaction,
		immutable: params.immutable ?? descriptor.snapshot?.immutable ?? false,
		createdAt: descriptor.createdAt,
		expiresAt: descriptor.createdAt + descriptor.ttlMs,
		browserSessionId: params.browserSessionId ?? descriptor.owner.browserSessionId,
	});
	return refId;
}

/** Resolve a `browser-result://` URI to its resource record. Returns undefined if not found or expired. */
export function resolveResourceUri(uri: string): BrowserResultResource | undefined {
	const resolved = resolveStoredResourceUriDetailed(uri);
	return resolved.ok ? resolved.resource : undefined;
}

export function resolveRefUri(uri: string): ResolvedRefRecord | undefined {
	const resolved = resolveRefUriDetailed(uri);
	return resolved.ok ? resolved.ref : undefined;
}

export function resolveRefUriDetailed(uri: string): ResolveRefResult {
	if (parseResourceUri(uri)) {
		const resolved = resolveStoredResourceUriDetailed(uri);
		return resolved.ok ? { ok: true, ref: resourceToResolvedRef(resolved.resource) } : resolved;
	}
	const parsed = parsePiRefUri(uri);
	if (!parsed) return { ok: false, code: "HANDLE_NOT_FOUND", error: `Unrecognized ref URI: ${uri}` };
	const stored = resolveStoredRefRecordDetailed(parsed);
	if (stored.ok) return normalizeResolvedRef(stored.record);
	if (stored.code === "REF_STALE") return stored;
	if (parsed.kind === "data-slice") {
		const wrapped = resolveStoredResourceUriDetailed(makeUri(parsed.id));
		return wrapped.ok ? { ok: true, ref: resourceToResolvedRef(wrapped.resource) } : wrapped;
	}
	return { ok: false, code: "HANDLE_NOT_FOUND", error: `Ref not found: ${uri}` };
}

/** List all non-expired resources. */
export function listResources(): BrowserResultResource[] {
	pruneExpired();
	return Array.from(resourceStore.values()).sort((a, b) => b.createdAt - a.createdAt);
}

/** Remove all expired resources and refs. */
export function pruneExpired(): void {
	const now = Date.now();
	for (const [id, resource] of resourceStore) {
		if (now > resource.expiresAt) resourceStore.delete(id);
	}
	for (const [id, record] of refStore) {
		if (now > record.descriptor.createdAt + record.descriptor.ttlMs) refStore.delete(id);
	}
}

/** Clear all resources and refs (e.g., on server shutdown). */
export function clearResourceStore(): void {
	resourceStore.clear();
	refStore.clear();
}
