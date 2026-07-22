import { statSync } from "node:fs";

/** Cheap change-detection token from a single stat: `${size}-${mtimeMs}`. */
export function computeEtag(filePath: string): string | undefined {
	try {
		const s = statSync(filePath);
		return `${s.size}-${Math.floor(s.mtimeMs)}`;
	} catch {
		return undefined;
	}
}

export function isFreshEtag(filePath: string, etag: string | undefined): boolean {
	if (!etag) return true;
	return computeEtag(filePath) === etag;
}
