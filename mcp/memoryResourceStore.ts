import { existsSync } from "node:fs";
import path from "node:path";
import { computeEtag, isFreshEtag } from "./resourceFreshness.js";
import { resolveMemoryPath } from "../src/tools/memory/paths.js";
import { readMemoryIndex } from "../src/tools/memory/indexStore.js";
import { resolveResourceUri } from "./resourceStore.js";

export const MEMORY_RESOURCE_URI_SCHEME = "browser-memory";

export type BrowserMemoryResource = {
	uri: string;
	kind: "index" | "sop" | "fact";
	id?: string;
	filePath: string;
	etag?: string;
	updatedAt?: string;
	name: string;
	description?: string;
	mime?: string;
};

function makeUri(kind: BrowserMemoryResource["kind"], id?: string, etag?: string): string {
	const base = kind === "index" ? `${MEMORY_RESOURCE_URI_SCHEME}://index` : `${MEMORY_RESOURCE_URI_SCHEME}://${kind}/${id}`;
	return etag ? `${base}?etag=${encodeURIComponent(etag)}` : base;
}

export function parseMemoryResourceUri(uri: string): { kind: "index" | "sop" | "fact"; id?: string } | undefined {
	const prefix = `${MEMORY_RESOURCE_URI_SCHEME}://`;
	if (!uri.startsWith(prefix)) return undefined;
	const rest = uri.slice(prefix.length).split("?")[0];
	if (rest === "index") return { kind: "index" };
	const [kind, id] = rest.split("/");
	if ((kind === "sop" || kind === "fact") && id) return { kind, id };
	return undefined;
}

export async function listMemoryResources(cwd?: string): Promise<BrowserMemoryResource[]> {
	const index = await readMemoryIndex(cwd);
	const out: BrowserMemoryResource[] = [{
		uri: makeUri("index", undefined, computeEtag(resolveMemoryPath(cwd, "index.json"))),
		kind: "index",
		filePath: resolveMemoryPath(cwd, "index.json"),
		etag: computeEtag(resolveMemoryPath(cwd, "index.json")),
		updatedAt: index.generatedAt,
		name: "browser memory index",
		mime: "application/json",
	}];
	for (const entry of index.entries) {
		const kind = entry.kind === "fact" ? "fact" : "sop";
		const filePath = resolveMemoryPath(cwd, kind === "fact" ? "facts" : "sop", `${entry.id}.md`);
		out.push({
			uri: makeUri(kind, entry.id, computeEtag(filePath)),
			kind,
			id: entry.id,
			filePath,
			etag: computeEtag(filePath),
			updatedAt: entry.updatedAt,
			name: `${entry.kind}: ${entry.title}`,
			description: `${entry.scopeKind}:${entry.scopeKey}`,
			mime: "text/markdown",
		});
	}
	return out;
}

export async function resolveMemoryResourceUri(uri: string, cwd?: string): Promise<BrowserMemoryResource | undefined> {
	const parsed = parseMemoryResourceUri(uri);
	if (!parsed) return undefined;
	if (parsed.kind === "index") {
		const filePath = resolveMemoryPath(cwd, "index.json");
		if (!existsSync(filePath)) await readMemoryIndex(cwd);
		return { uri: makeUri("index", undefined, computeEtag(filePath)), kind: "index", filePath, etag: computeEtag(filePath), name: "browser memory index", mime: "application/json" };
	}
	const filePath = resolveMemoryPath(cwd, parsed.kind === "fact" ? "facts" : "sop", `${parsed.id}.md`);
	if (!existsSync(filePath)) return undefined;
	return { uri: makeUri(parsed.kind, parsed.id, computeEtag(filePath)), kind: parsed.kind, id: parsed.id, filePath, etag: computeEtag(filePath), name: `${parsed.kind}: ${parsed.id}`, mime: "text/markdown" };
}

export function isMemoryResourceFresh(resource: BrowserMemoryResource): boolean {
	return isFreshEtag(resource.filePath, resource.etag);
}

export function memoryResourceTemplates() {
	return [
		{ uriTemplate: "browser-memory://index", name: "Browser memory index", description: "Derived browser memory index. Supports ?mode=json&jsonPath=...", mimeType: "application/json" },
		{ uriTemplate: "browser-memory://sop/{id}", name: "Browser memory SOP", description: "Browser memory SOP entry. Supports ?mode=text|json&offset=&limit=&jsonPath=...", mimeType: "text/markdown" },
		{ uriTemplate: "browser-memory://fact/{id}", name: "Browser memory fact", description: "Browser memory fact entry. Supports ?mode=text|json&offset=&limit=&jsonPath=...", mimeType: "text/markdown" },
	];
}

export async function resolveBrowserResultEvidence(uri: string): Promise<{ ok: true; path: string; etag?: string; bytes?: number } | { ok: false; code: string; error: string }> {
	const resource = resolveResourceUri(uri);
	if (!resource) return { ok: false, code: "MEMORY_EVIDENCE_UNRESOLVABLE", error: `Resource not found or expired: ${uri}` };
	if (!isFreshEtag(resource.artifactPath, resource.etag)) return { ok: false, code: "MEMORY_EVIDENCE_STALE", error: `Resource is stale: ${uri}` };
	return { ok: true, path: path.normalize(resource.artifactPath), etag: resource.etag, bytes: resource.bytes };
}
