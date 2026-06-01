import { createHash } from "node:crypto";
import { statSync, readFileSync } from "node:fs";
import { parseJsonOrThrow } from "./json.js";

function parseJsonPath(jsonPath: string): Array<string | number> {
	const text = jsonPath.trim();
	if (!text || text === "$") return [];
	const normalized = text.startsWith("$.") ? text.slice(2) : text.startsWith("$") ? text.slice(1) : text;
	const tokens: Array<string | number> = [];
	for (const part of normalized.split(".")) {
		if (!part) continue;
		const re = /([^[]+)|\[(\d+)\]/g;
		let match: RegExpExecArray | null;
		while ((match = re.exec(part))) tokens.push(match[1] !== undefined ? match[1] : Number(match[2]));
	}
	return tokens;
}

function getJsonPath(value: unknown, jsonPath: string): { exists: boolean; value: unknown } {
	let current = value;
	for (const token of parseJsonPath(jsonPath)) {
		if (current === null || current === undefined || typeof current !== "object") return { exists: false, value: undefined };
		if (!Object.prototype.hasOwnProperty.call(current, token)) return { exists: false, value: undefined };
		current = (current as Record<string | number, unknown>)[token];
	}
	return { exists: true, value: current };
}

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
