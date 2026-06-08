import { createHash } from "node:crypto";
import { statSync, readFileSync } from "node:fs";
import { parseJsonOrThrow } from "./json.js";
import { getJsonPath } from "./jsonPath.js";

/** Cheap change-detection token from a single stat: `${size}-${mtimeMs}`. */
export function computeEtag(filePath: string): string | undefined {
	try {
		const s = statSync(filePath);
		return `${s.size}-${Math.floor(s.mtimeMs)}`;
	} catch {
		return undefined;
	}
}

/** Full content hash. Optional jsonPath scopes the hash to a selected JSON slice. */
export function computeContentHash(filePath: string, jsonPath?: string): string | undefined {
	try {
		const raw = readFileSync(filePath, "utf8");
		if (!jsonPath) return createHash("sha256").update(raw).digest("hex");
		const parsed = parseJsonOrThrow(raw, `computeContentHash ${filePath}`) as unknown;
		const selected = getJsonPath(parsed, jsonPath);
		if (!selected.exists) return undefined;
		return createHash("sha256").update(JSON.stringify(selected.value)).digest("hex");
	} catch {
		return undefined;
	}
}

export function isFreshEtag(filePath: string, etag: string | undefined): boolean {
	if (!etag) return true;
	return computeEtag(filePath) === etag;
}
