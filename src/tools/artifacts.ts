import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { browserArtifactPrivacyMetadata } from "./artifactPrivacy";

export function resolveArtifactPath(ctx: { cwd?: string } | undefined, requested: string | undefined, fallbackName: string): string {
	const base = ctx?.cwd || process.cwd();
	const target = requested?.trim() || path.join(".pi", "browser-artifacts", fallbackName);
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
