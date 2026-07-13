import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { ArtifactReaderError, type BrowserArtifactContext } from "./artifactReaderShared.js";

function isInsideOrEqual(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function allowedArtifactRoot(ctx: BrowserArtifactContext): string {
	const base = path.resolve(ctx?.cwd || process.cwd());
	return path.resolve(base, ".browser-pilot", "artifacts");
}

export function resolveInputPath(ctx: BrowserArtifactContext, requested: unknown): string {
	const text = String(requested || "").trim();
	if (!text) throw new ArtifactReaderError("ARTIFACT_PATH_REQUIRED", "browser_artifact requires path");
	if (path.isAbsolute(text)) return path.normalize(text);
	const base = path.resolve(ctx?.cwd || process.cwd());
	const target = path.resolve(base, text);
	const allowed = allowedArtifactRoot(ctx);
	if (!isInsideOrEqual(allowed, target)) {
		throw new ArtifactReaderError("ARTIFACT_PATH_OUTSIDE_ALLOWED_ROOT", "Relative browser_artifact paths must stay under .browser-pilot/artifacts; use an absolute path for explicit files", { requested: text, allowedRoot: allowed });
	}
	return target;
}

export function resolveSearchRoot(ctx: BrowserArtifactContext, requested: unknown): string {
	const allowed = allowedArtifactRoot(ctx);
	const text = String(requested || "").trim();
	if (!text) return allowed;
	const base = path.resolve(ctx?.cwd || process.cwd());
	const target = path.isAbsolute(text) ? path.normalize(text) : path.resolve(base, text);
	if (!isInsideOrEqual(allowed, target)) throw new ArtifactReaderError("ARTIFACT_PATH_OUTSIDE_ALLOWED_ROOT", "browser_artifact root must stay under .browser-pilot/artifacts", { requested: text, allowedRoot: allowed });
	return target;
}

export function publicRequestedArtifactPath(requested: unknown): Record<string, unknown> {
	return typeof requested === "string" && requested.trim() ? { requestedPath: requested } : {};
}

export async function statArtifact(absPath: string, requested: unknown): Promise<Stats> {
	try {
		return await stat(absPath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			throw new ArtifactReaderError("ARTIFACT_NOT_FOUND", "Artifact path was not found", {
				...publicRequestedArtifactPath(requested),
				recovery: { nextActions: ["browser-pilot artifact inspect --path <saved.path> --json", "browser-pilot observe --json"] },
			});
		}
		throw error;
	}
}
