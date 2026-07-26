import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { browserArtifactPrivacyMetadata } from "./artifactPrivacy.js";
import { atomicWriteText } from "../utils/fsAtomic.js";

const OBSERVATION_ARTIFACT = /^(?:observe-[a-z0-9-]+\.(?:json|png)|(?:visual-effect|screenshot)-[a-z0-9-]+\.png)$/i;
const OBSERVATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const OBSERVATION_MAX_FILES = 256;
const OBSERVATION_MAX_BYTES = 64 * 1024 * 1024;
let observationPruneTail = Promise.resolve();

export function resolveArtifactPath(ctx: { cwd?: string } | undefined, requested: string | undefined, fallbackName: string): string {
	const base = ctx?.cwd || process.cwd();
	const target = requested?.trim() || path.join(".browser-pilot", "artifacts", fallbackName);
	return path.isAbsolute(target) ? target : path.resolve(base, target);
}

export function artifactFallbackName(prefix: string, extension = "json"): string {
	return `${prefix}-${Date.now()}-${randomUUID()}.${extension}`;
}

export function artifactResourceUri(savedPath: string, projectRoot: string): string | undefined {
	const root = path.resolve(projectRoot, ".browser-pilot", "artifacts");
	const target = path.resolve(savedPath);
	const relative = path.relative(root, target);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	return `browser-pilot://artifact/${relative.split(path.sep).map(encodeURIComponent).join("/")}`;
}

export async function saveTextArtifact(ctx: { cwd?: string } | undefined, requested: string | undefined, fallbackName: string, content: string): Promise<{ path: string; chars: number; bytes: number; privacy: Record<string, unknown> }> {
	const outputPath = resolveArtifactPath(ctx, requested, fallbackName);
	await atomicWriteText(outputPath, content);
	return { path: outputPath, chars: content.length, bytes: Buffer.byteLength(content, "utf8"), privacy: browserArtifactPrivacyMetadata() };
}

async function pruneObservationArtifactDirectory(outputPath: string): Promise<void> {
	if (!OBSERVATION_ARTIFACT.test(path.basename(outputPath))) return;
	const dir = path.dirname(outputPath);
	const currentStem = path.parse(path.resolve(outputPath)).name;
	const entries = await readdir(dir, { withFileTypes: true });
	const files = (await Promise.all(entries
		.filter((entry) => entry.isFile() && OBSERVATION_ARTIFACT.test(entry.name))
		.map(async (entry) => {
			const filePath = path.join(dir, entry.name);
			const metadata = await stat(filePath).catch(() => undefined);
			return metadata ? { filePath, size: metadata.size, mtimeMs: metadata.mtimeMs } : undefined;
		})))
		.filter((file): file is { filePath: string; size: number; mtimeMs: number } => file !== undefined)
		.sort((a, b) => Number(path.parse(b.filePath).name === currentStem) - Number(path.parse(a.filePath).name === currentStem) || b.mtimeMs - a.mtimeMs);
	let keptFiles = 0;
	let keptBytes = 0;
	const cutoff = Date.now() - OBSERVATION_MAX_AGE_MS;
	for (const file of files) {
		const current = path.parse(file.filePath).name === currentStem;
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

export function decodeDataUrl(dataUrl: string): { buffer: Buffer; mime: string } {
	const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/s);
	if (!match) throw new Error("screenshot result is not a base64 data URL");
	return { buffer: decodeStrictBase64Payload(match[2]), mime: match[1] };
}

export async function saveBuffer(buffer: Buffer, outputPath: string, mime: string): Promise<{ path: string; bytes: number; mime: string }> {
	await mkdir(path.dirname(outputPath), { recursive: true });
	await writeFile(outputPath, buffer);
	return { path: outputPath, bytes: buffer.length, mime };
}
