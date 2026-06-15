/**
 * Browser result resource store / ABML ref registry.
 *
 * Maintains the existing browser-result:// resource registry and a generic
 * bp-ref:// registry. browser-result:// remains the externally visible
 * resource surface; bp-ref:// is the ABML ref surface. A browser-result://
 * resource is also resolvable as a kind:"data-slice" bp-ref wrapper.
 *
 * Invariants:
 * - No local path is returned in URIs or resource metadata.
 * - browser-result:// compatibility is preserved.
 * - bp-ref:// wrappers inherit TTL / etag / redaction / session binding.
 * - Expired resources/refs are pruned on registration and resolution.
 */
import { randomUUID } from "node:crypto";
import type { RefDescriptor, RefKind } from "../kernels/abml/types.js";
import { defaultRefPolicyForKind } from "../kernels/abml/refPolicy.js";
import { makeBrowserPilotRefUri, stableRefIdForDescriptor } from "../kernels/abml/refId.js";
import { parseRef } from "../kernels/refs/index.js";
import type { BrowserResultResource, RegisteredRefRecord, RegisterBrowserResultResourceParams, RegisterRefDescriptorParams, ResolveRefResult, ResolvedRefRecord, ResourceRefStorePort } from "../ports/ResourceRefStorePort.js";
import { computeContentHash, computeEtag, isFreshEtag } from "../utils/fileFreshness.js";

export const RESOURCE_URI_SCHEME = "browser-result";
export const BROWSER_PILOT_REF_URI_SCHEME = "bp-ref";
const TTL_MS = 60 * 60 * 1000; // 1 hour
export const RESOURCE_STORE_MAX_ENTRIES = 10_000;
export const REF_STORE_MAX_ENTRIES = 10_000;
const PRUNE_EXPIRED_EVERY_REGISTRATIONS = 128;

/**
 * True if the artifact on disk still matches the etag recorded at registration.
 * A mismatch means the file was rewritten/replaced under the handle (staleness).
 */
export function isResourceFresh(resource: BrowserResultResource): boolean {
	return isFreshEtag(resource.artifactPath, resource.etag);
}

const resourceStore = new Map<string, BrowserResultResource>();
const refStore = new Map<string, RegisteredRefRecord>();
let registrationsSincePrune = 0;

/** Construct the opaque URI for a given resource id. */
function makeUri(id: string): string {
	return `${RESOURCE_URI_SCHEME}://${id}`;
}

function wrapperBrowserPilotRefUriForResource(resource: Pick<BrowserResultResource, "id">): string {
	return makeBrowserPilotRefUri("data-slice", resource.id);
}

/** Extract id from a `browser-result://{id}` URI. Returns undefined for unrecognized URIs. */
export function parseResourceUri(uri: string): string | undefined {
	const prefix = `${RESOURCE_URI_SCHEME}://`;
	if (!uri.startsWith(prefix)) return undefined;
	const id = uri.slice(prefix.length).split("/")[0].split("?")[0];
	return id || undefined;
}

export function parseBrowserPilotRefUri(uri: string): { kind?: RefKind; id: string } | undefined {
	try {
		const parsed = parseRef(uri.split("?")[0] ?? uri);
		return { kind: parsed.kind as RefKind, id: parsed.id };
	} catch {
		return undefined;
	}
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
		const parsed = parseBrowserPilotRefUri(record.refId);
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
export function registerBrowserResultResource(params: RegisterBrowserResultResourceParams): string {
	pruneExpiredAmortized();
	const id = randomUUID();
	const uri = makeUri(id);
	const now = Date.now();
	const etag = computeEtag(params.artifactPath);
	const hash = params.kind === "http-request" ? computeContentHash(params.artifactPath, params.jsonPath) : undefined;
	const resource: BrowserResultResource = {
		id,
		uri,
		refId: wrapperBrowserPilotRefUriForResource({ id }),
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
	enforceMaxEntries(resourceStore, RESOURCE_STORE_MAX_ENTRIES, (item) => item.createdAt);
	return uri;
}

export function registerRefDescriptor(params: RegisterRefDescriptorParams): string {
	pruneExpiredAmortized();
	const refId = params.descriptor.refId || stableRefIdForDescriptor(params.descriptor) || makeBrowserPilotRefUri(params.descriptor.kind, randomUUID());
	const parsed = parseBrowserPilotRefUri(refId);
	if (!parsed) throw new Error(`Invalid bp-ref URI: ${refId}`);
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
	enforceMaxEntries(refStore, REF_STORE_MAX_ENTRIES, (item) => item.createdAt);
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
	const parsed = parseBrowserPilotRefUri(uri);
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
	registrationsSincePrune = 0;
}

/** Clear all resources and refs (e.g., on server shutdown). */
export function clearResourceStore(): void {
	resourceStore.clear();
	refStore.clear();
	registrationsSincePrune = 0;
}

export const resourceRefStore: ResourceRefStorePort = {
	isResourceFresh,
	registerBrowserResultResource,
	registerRefDescriptor,
	resolveResourceUri,
	resolveRefUri,
	resolveRefUriDetailed,
	listResources,
	pruneExpired,
	clearResourceStore,
};

function pruneExpiredAmortized(): void {
	registrationsSincePrune += 1;
	if (registrationsSincePrune >= PRUNE_EXPIRED_EVERY_REGISTRATIONS) pruneExpired();
}

function enforceMaxEntries<T>(store: Map<string, T>, maxEntries: number, createdAt: (item: T) => number): void {
	while (store.size > maxEntries) {
		let oldestId: string | undefined;
		let oldestCreatedAt = Infinity;
		for (const [id, item] of store) {
			const itemCreatedAt = createdAt(item);
			if (itemCreatedAt < oldestCreatedAt) {
				oldestCreatedAt = itemCreatedAt;
				oldestId = id;
			}
		}
		if (!oldestId) return;
		store.delete(oldestId);
	}
}
