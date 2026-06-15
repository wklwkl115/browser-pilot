import path from "node:path";
import { isResourceFresh, resolveResourceUri } from "./resourceRefs.js";

export type BrowserResultEvidenceResolution =
	| { ok: true; path: string; etag?: string; bytes?: number }
	| { ok: false; code: string; error: string };

export async function resolveBrowserResultEvidence(uri: string): Promise<BrowserResultEvidenceResolution> {
	const resource = resolveResourceUri(uri);
	if (!resource) return { ok: false, code: "MEMORY_EVIDENCE_UNRESOLVABLE", error: `Resource not found or expired: ${uri}` };
	if (!isResourceFresh(resource)) return { ok: false, code: "MEMORY_EVIDENCE_STALE", error: `Resource is stale: ${uri}` };
	return { ok: true, path: path.normalize(resource.artifactPath), etag: resource.etag, bytes: resource.bytes };
}
