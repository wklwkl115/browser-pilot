import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { browserArtifactPrivacyMetadata } from "./artifactPrivacy.js";

const OBSERVATION_ARTIFACT = /^observe-[a-z0-9-]+-\d+\.json$/i;
const OBSERVATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const OBSERVATION_MAX_FILES = 256;
const OBSERVATION_MAX_BYTES = 64 * 1024 * 1024;
let observationPruneTail = Promise.resolve();

export function resolveArtifactPath(ctx: { cwd?: string } | undefined, requested: string | undefined, fallbackName: string): string {
	const base = ctx?.cwd || process.cwd();
	const target = requested?.trim() || path.join(".browser-pilot", "artifacts", fallbackName);
	return path.isAbsolute(target) ? target : path.resolve(base, target);
}

export async function saveTextArtifact(ctx: { cwd?: string } | undefined, requested: string | undefined, fallbackName: string, content: string): Promise<{ path: string; chars: number; bytes: number; privacy: Record<string, unknown> }> {
	const outputPath = resolveArtifactPath(ctx, requested, fallbackName);
	const dir = path.dirname(outputPath);
	const tempPath = path.join(dir, `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.tmp`);
	await mkdir(dir, { recursive: true });
	try {
		await writeFile(tempPath, content, "utf8");
		await rename(tempPath, outputPath);
	} catch (error) {
		await rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
	return { path: outputPath, chars: content.length, bytes: Buffer.byteLength(content, "utf8"), privacy: browserArtifactPrivacyMetadata() };
}

async function pruneObservationArtifactDirectory(outputPath: string): Promise<void> {
	if (!OBSERVATION_ARTIFACT.test(path.basename(outputPath))) return;
	const dir = path.dirname(outputPath);
	const currentPath = path.resolve(outputPath);
	const entries = await readdir(dir, { withFileTypes: true });
	const files = (await Promise.all(entries
		.filter((entry) => entry.isFile() && OBSERVATION_ARTIFACT.test(entry.name))
		.map(async (entry) => {
			const filePath = path.join(dir, entry.name);
			const metadata = await stat(filePath).catch(() => undefined);
			return metadata ? { filePath, size: metadata.size, mtimeMs: metadata.mtimeMs } : undefined;
		})))
		.filter((file): file is { filePath: string; size: number; mtimeMs: number } => file !== undefined)
		.sort((a, b) => Number(path.resolve(b.filePath) === currentPath) - Number(path.resolve(a.filePath) === currentPath) || b.mtimeMs - a.mtimeMs);
	let keptFiles = 0;
	let keptBytes = 0;
	const cutoff = Date.now() - OBSERVATION_MAX_AGE_MS;
	for (const file of files) {
		const current = path.resolve(file.filePath) === currentPath;
		if (!current && (file.mtimeMs < cutoff || keptFiles >= OBSERVATION_MAX_FILES || keptBytes + file.size > OBSERVATION_MAX_BYTES)) {
			await rm(file.filePath, { force: true });
			continue;
		}
		keptFiles += 1;
		keptBytes += file.size;
	}
}

export function pruneObservationArtifacts(outputPath: string): Promise<void> {
	observationPruneTail = observationPruneTail.then(() => pruneObservationArtifactDirectory(outputPath)).catch(() => {});
	return observationPruneTail;
}

function decodeStrictBase64Payload(payload: string): Buffer {
	const compact = payload.replace(/\s+/g, "");
	if (!compact) throw new Error("screenshot result has an empty base64 payload");
	if (compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
		throw new Error("screenshot result has an invalid base64 payload");
	}
	const buffer = Buffer.from(compact, "base64");
	const normalizedInput = compact.replace(/=+$/, "");
	const normalizedRoundTrip = buffer.toString("base64").replace(/=+$/, "");
	if (normalizedInput !== normalizedRoundTrip) throw new Error("screenshot result has an invalid base64 payload");
	return buffer;
}

export async function saveDataUrl(dataUrl: string, outputPath: string): Promise<{ path: string; bytes: number; mime: string }> {
	const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/s);
	if (!match) throw new Error("screenshot result is not a base64 data URL");
	const buffer = decodeStrictBase64Payload(match[2]);
	await mkdir(path.dirname(outputPath), { recursive: true });
	await writeFile(outputPath, buffer);
	return { path: outputPath, bytes: buffer.length, mime: match[1] };
}
