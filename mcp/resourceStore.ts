/**
 * MCP browser result resource store.
 *
 * Maintains an in-memory registry of browser tool artifacts as MCP resources.
 * Opaque `browser-result://{id}` URIs are the only externally visible form
 * of a saved result — local absolute paths stay server-side only.
 *
 * Invariants:
 * - No local path is returned in URIs or resource metadata.
 * - Default redaction applies unless explicitly disabled.
 * - Resources expire after TTL_MS (default 1 hour); pruneExpired() is
 *   called on registration to keep memory bounded.
 */
import { randomUUID } from "node:crypto";

export const RESOURCE_URI_SCHEME = "browser-result";
const TTL_MS = 60 * 60 * 1000; // 1 hour

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

const store = new Map<string, BrowserResultResource>();

/** Construct the opaque URI for a given resource id. */
function makeUri(id: string): string {
	return `${RESOURCE_URI_SCHEME}://${id}`;
}

/** Extract id from a `browser-result://{id}` URI. Returns undefined for unrecognized URIs. */
export function parseResourceUri(uri: string): string | undefined {
	const prefix = `${RESOURCE_URI_SCHEME}://`;
	if (!uri.startsWith(prefix)) return undefined;
	const id = uri.slice(prefix.length).split("/")[0].split("?")[0];
	return id || undefined;
}

/** Register a new resource and return its URI. Never exposes local path. */
export function registerBrowserResultResource(params: {
	kind: ResourceKind;
	artifactPath: string;
	name: string;
	description?: string;
	section?: string;
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
	const resource: BrowserResultResource = {
		id,
		uri,
		kind: params.kind,
		artifactPath: params.artifactPath,
		section: params.section,
		mime: params.mime,
		bytes: params.bytes,
		immutable: params.immutable ?? true,
		createdAt: now,
		expiresAt: now + TTL_MS,
		browserSessionId: params.browserSessionId,
		redaction: params.redaction ?? "default",
		name: params.name,
		description: params.description,
	};
	store.set(id, resource);
	return uri;
}

/** Resolve a `browser-result://` URI to its resource record. Returns undefined if not found or expired. */
export function resolveResourceUri(uri: string): BrowserResultResource | undefined {
	const id = parseResourceUri(uri);
	if (!id) return undefined;
	const resource = store.get(id);
	if (!resource) return undefined;
	if (Date.now() > resource.expiresAt) {
		store.delete(id);
		return undefined;
	}
	return resource;
}

/** List all non-expired resources. */
export function listResources(): BrowserResultResource[] {
	pruneExpired();
	return Array.from(store.values()).sort((a, b) => b.createdAt - a.createdAt);
}

/** Remove all expired resources. */
export function pruneExpired(): void {
	const now = Date.now();
	for (const [id, resource] of store) {
		if (now > resource.expiresAt) store.delete(id);
	}
}

/** Clear all resources (e.g., on server shutdown). */
export function clearResourceStore(): void {
	store.clear();
}
