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
import { randomUUID, createHash } from "node:crypto";
import { statSync, readFileSync } from "node:fs";

export const RESOURCE_URI_SCHEME = "browser-result";
const TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Cheap change-detection token from a single stat: `${size}-${mtimeMs}`.
 * Detects rename/rewrite/external-edit without reading content — correct
 * strength for an immutable, atomically-written (temp+rename) artifact store.
 * Returns undefined if the path can't be stat'd (caller leaves etag unset).
 */
export function computeEtag(artifactPath: string): string | undefined {
	try {
		const s = statSync(artifactPath);
		return `${s.size}-${Math.floor(s.mtimeMs)}`;
	} catch {
		return undefined;
	}
}

/**
 * Full content hash (sha256). Only used for small, security-sensitive
 * `http-request` ingress templates — never on the raw-result hot path.
 */
function computeContentHash(artifactPath: string): string | undefined {
	try {
		return createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
	} catch {
		return undefined;
	}
}

/**
 * True if the artifact on disk still matches the etag recorded at registration.
 * A mismatch means the file was rewritten/replaced under the handle (staleness).
 */
export function isResourceFresh(resource: BrowserResultResource): boolean {
	if (!resource.etag) return true; // etag couldn't be computed at register time — don't block
	return computeEtag(resource.artifactPath) === resource.etag;
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
	// etag (cheap stat) for all kinds; content hash only for security-sensitive
	// http-request ingress templates (small files, content identity matters).
	const etag = computeEtag(params.artifactPath);
	const hash = params.kind === "http-request" ? computeContentHash(params.artifactPath) : undefined;
	const resource: BrowserResultResource = {
		id,
		uri,
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
