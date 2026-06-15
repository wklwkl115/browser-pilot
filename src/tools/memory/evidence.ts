import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { BrowserBridgeServer } from "../../driver/BrowserBridgeServer.js";
import { createCodedError } from "../../utils/codedError.js";
import { containsSensitiveEvidence } from "../../utils/redaction.js";
import { computeEtag } from "../../utils/fileFreshness.js";
import { resolveArtifactPath } from "../artifacts.js";
import type { MemoryConfidence, MemoryEvidenceRef, MemoryRecordPayload } from "./types.js";
import { normalizeOriginKeyFromUrl } from "./origin.js";

export type MemoryResolvedEvidenceRef = MemoryEvidenceRef;
export type MemoryResultResourceResolution = { ok: true; path: string; etag?: string; bytes?: number } | { ok: false; code: string; error: string };
export type MemoryResultResourceResolver = (uri: string) => Promise<MemoryResultResourceResolution>;

// Block crystallizing anti-bot EVASION know-how, but not defensive mentions.
// "stealth"/"human behavior" read as evasion intent inside a recorded automation
// SOP, so they are hard-blocked. "captcha" has a legitimate defensive use ("if a
// captcha appears, stop and ask the user"), so it is blocked only when it co-occurs
// with an evasion verb (bypass/solve/defeat/evade/…).
const BLOCKED_CONTENT_RE = /\b(stealth|human[\s-]?behavior)\b/i;
// Evasion verbs only — bare "solve" is excluded so defensive guidance ("ask the
// user to solve the captcha") is allowed while "captcha solver"/"auto-solve"/
// "bypass captcha" stay blocked.
const CAPTCHA_EVASION_VERBS = "bypass\\w*|defeat\\w*|crack\\w*|evad\\w*|circumvent\\w*|auto[\\s-]?solv\\w*|solver";
const CAPTCHA_EVASION_RE = new RegExp(`\\b(${CAPTCHA_EVASION_VERBS})\\b[\\s\\S]{0,40}\\bcaptcha\\b|\\bcaptcha\\b[\\s\\S]{0,40}\\b(${CAPTCHA_EVASION_VERBS})\\b`, "i");

function normalizedEvidenceRef(ref: string | MemoryEvidenceRef): MemoryEvidenceRef {
	if (typeof ref === "string") {
		if (ref.startsWith("browser-result://")) return { kind: "browser-result", uri: ref };
		return { kind: "artifact", path: ref };
	}
	if (ref && typeof ref === "object") return ref;
	throw createCodedError({ name: "MemoryEvidenceError", code: "MEMORY_SCHEMA_INVALID", message: "browser_memory evidenceRefs entries must be strings or objects" });
}

async function ensureReadableFile(filePath: string): Promise<{ etag?: string; bytes?: number }> {
	await readFile(filePath, "utf8").catch(() => { throw createCodedError({ name: "MemoryEvidenceError", code: "MEMORY_EVIDENCE_UNREADABLE", message: "memory evidence path is unreadable", details: { path: filePath } }); });
	const info = await stat(filePath).catch(() => undefined);
	return { etag: computeEtag(filePath), bytes: info?.size };
}

async function resolveArtifactRef(cwd: string | undefined, ref: Extract<MemoryEvidenceRef, { kind: "artifact" }>): Promise<MemoryResolvedEvidenceRef> {
	const filePath = path.isAbsolute(ref.path) ? path.normalize(ref.path) : resolveArtifactPath({ cwd }, ref.path, path.basename(ref.path));
	const { etag, bytes } = await ensureReadableFile(filePath);
	return { kind: "artifact", path: filePath, etag, bytes };
}

async function resolveSnapshotRef(server: BrowserBridgeServer | undefined, ref: Extract<MemoryEvidenceRef, { kind: "snapshot" }>): Promise<MemoryResolvedEvidenceRef> {
	if (!server) throw createCodedError({ name: "MemoryEvidenceError", code: "MEMORY_EVIDENCE_UNRESOLVABLE", message: "snapshot evidence requires a live BrowserBridgeServer", details: { snapshotId: ref.snapshotId } });
	const snapshot = server.getObservationSnapshot(ref.snapshotId);
	if (!snapshot) throw createCodedError({ name: "MemoryEvidenceError", code: "MEMORY_EVIDENCE_UNREADABLE", message: "memory snapshot evidence was not found", details: { snapshotId: ref.snapshotId } });
	if (snapshot.expired) throw createCodedError({ name: "MemoryEvidenceError", code: "MEMORY_EVIDENCE_STALE", message: "memory snapshot evidence is stale", details: { snapshotId: ref.snapshotId, invalidatedReason: snapshot.invalidatedReason } });
	if (!snapshot.saved?.path) throw createCodedError({ name: "MemoryEvidenceError", code: "MEMORY_EVIDENCE_UNREADABLE", message: "memory snapshot evidence has no saved artifact path", details: { snapshotId: ref.snapshotId } });
	const { etag, bytes } = await ensureReadableFile(snapshot.saved.path);
	return { kind: "snapshot", snapshotId: ref.snapshotId, path: snapshot.saved.path, etag, bytes };
}

async function resolveResultRef(resolver: MemoryResultResourceResolver | undefined, ref: Extract<MemoryEvidenceRef, { kind: "browser-result" }>): Promise<MemoryResolvedEvidenceRef> {
	if (!resolver) throw createCodedError({ name: "MemoryEvidenceError", code: "MEMORY_EVIDENCE_UNRESOLVABLE", message: "browser-result evidence requires a resource resolver", details: { uri: ref.uri } });
	const resolved = await resolver(ref.uri);
	if (!resolved.ok) throw createCodedError({ name: "MemoryEvidenceError", code: resolved.code, message: resolved.error, details: { uri: ref.uri } });
	return { kind: "browser-result", uri: ref.uri, path: resolved.path, etag: resolved.etag, bytes: resolved.bytes };
}

function resolveOperationRef(ref: Extract<MemoryEvidenceRef, { kind: "operation" }>): MemoryResolvedEvidenceRef {
	return { kind: "operation", operationId: ref.operationId, path: ref.path, etag: ref.etag, bytes: ref.bytes };
}

export async function resolveMemoryEvidenceRefs(options: {
	cwd?: string;
	server?: BrowserBridgeServer;
	resolver?: MemoryResultResourceResolver;
	evidenceRefs: Array<string | MemoryEvidenceRef>;
}): Promise<MemoryResolvedEvidenceRef[]> {
	// Evidence is OPTIONAL provenance (GA-style: a successful task can crystallize
	// without an artifact). But anything the caller DOES cite must be real — a
	// provided ref is still resolved/validated so recorded provenance stays honest.
	const resolved: MemoryResolvedEvidenceRef[] = [];
	for (const raw of options.evidenceRefs) {
		const ref = normalizedEvidenceRef(raw);
		if (ref.kind === "artifact") {
			resolved.push(await resolveArtifactRef(options.cwd, ref));
			continue;
		}
		if (ref.kind === "browser-result") {
			resolved.push(await resolveResultRef(options.resolver, ref));
			continue;
		}
		if (ref.kind === "snapshot") {
			resolved.push(await resolveSnapshotRef(options.server, ref));
			continue;
		}
		resolved.push(resolveOperationRef(ref));
	}
	return resolved;
}

export function validateMemoryRecordPayloadShape(payload: MemoryRecordPayload): { scopeKey: string; scopeKind: "origin" | "task" | "project"; confidence: MemoryConfidence } {
	const scopeKind = payload.scopeKind ?? "origin";
	const scopeKey = scopeKind === "origin"
		? (payload.scopeKey?.trim() || (payload.url ? normalizeOriginKeyFromUrl(payload.url) : ""))
		: String(payload.scopeKey || "").trim();
	if (!scopeKey) throw createCodedError({ name: "MemoryValidationError", code: "MEMORY_SCOPE_REQUIRED", message: `browser_memory requires scopeKey${scopeKind === "origin" ? " or url" : ""} for scopeKind=${scopeKind}` });
	const title = String(payload.title || "").trim();
	if (!title) throw createCodedError({ name: "MemoryValidationError", code: "MEMORY_SCHEMA_INVALID", message: "browser_memory record requires title" });
	if (!Array.isArray(payload.triggers) || payload.triggers.length === 0 || payload.triggers.some((item) => typeof item !== "string" || !item.trim())) {
		throw createCodedError({ name: "MemoryValidationError", code: "MEMORY_SCHEMA_INVALID", message: "browser_memory record requires non-empty triggers[]" });
	}
	const body = String(payload.body || "");
	if (!body.trim()) throw createCodedError({ name: "MemoryValidationError", code: "MEMORY_SCHEMA_INVALID", message: "browser_memory record requires body" });
	const lineCap = payload.kind === "fact" ? 160 : 120;
	if (body.split(/\r?\n/).length > lineCap || body.length > 16 * 1024) throw createCodedError({ name: "MemoryValidationError", code: "MEMORY_SCHEMA_INVALID", message: "browser_memory body exceeds size caps", details: { lineCap, chars: body.length } });
	const blockedHaystack = `${title}\n${payload.triggers.join(" ")}\n${body}`;
	if (containsSensitiveEvidence(title) || containsSensitiveEvidence(payload.triggers) || containsSensitiveEvidence(body) || BLOCKED_CONTENT_RE.test(blockedHaystack) || CAPTCHA_EVASION_RE.test(blockedHaystack)) throw createCodedError({ name: "MemoryValidationError", code: "MEMORY_SECRET_DETECTED", message: "browser_memory payload contains blocked or sensitive content" });
	return { scopeKey, scopeKind, confidence: payload.confidence ?? "verified" };
}
