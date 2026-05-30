import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { NativeErrorCode } from "../../../protocol/nativeErrorCodes";
import { createCodedError } from "../../../utils/codedError";

export const DEFAULT_MAX_BODY_BYTES = 256_000;
export const DEFAULT_TIMEOUT_MS = 15_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

export function positiveInt(value: unknown, fallback: number): number {
	const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function defaultScheme(value: unknown): "http" | "https" {
	return String(value || "https").toLowerCase() === "http" ? "http" : "https";
}

function normalizeInputError(message: string, details: Record<string, unknown> = {}): Error {
	return createCodedError({ name: "NormalizeInputError", code: "INVALID_RULE" as Extract<NativeErrorCode, "INVALID_RULE">, message, details, suppressStack: false });
}

export function normalizeMethod(value: unknown, fallback = "GET"): string {
	const method = String(value || fallback).trim().toUpperCase();
	if (!/^[A-Z][A-Z0-9_-]{0,31}$/.test(method)) throw normalizeInputError(`Invalid HTTP method: ${String(value)}`, { method: value });
	return method;
}

export function normalizeHeaderName(name: string): string {
	return name.trim().toLowerCase();
}

export function numericList(value: unknown): number[] {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/) : value === undefined ? [] : [value];
	return raw.map((item) => Number(item)).filter((item) => Number.isInteger(item));
}

export function stringList(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
	return raw.map((item) => asString(item)?.trim() || "").filter(Boolean);
}

const WORDLIST_MAX_BYTES = 5 * 1024 * 1024;

function wordlistPathError(message: string, details: Record<string, unknown>): Error {
	return createCodedError({ name: "WordlistPathError", code: "WORDLIST_PATH_BLOCKED" as Extract<NativeErrorCode, "WORDLIST_PATH_BLOCKED">, message, details, suppressStack: false });
}

function allowedWordlistRoots(): string[] {
	const cwd = path.resolve(process.cwd());
	return [cwd, path.join(cwd, ".pi")];
}

function resolveScopedWordlistPath(filePath: string): string {
	const resolved = path.resolve(filePath);
	const allowedRoots = allowedWordlistRoots();
	const allowed = allowedRoots.some((root) => resolved === root || resolved.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`));
	if (!allowed) {
		throw wordlistPathError("browser webSecurity wordlistPath must stay under the current working directory or .pi/", { path: filePath, resolved, allowedRoots });
	}
	return resolved;
}

export async function readWordlist(value: unknown): Promise<string[]> {
	const filePath = asString(value)?.trim();
	if (!filePath) return [];
	const resolved = resolveScopedWordlistPath(filePath);
	const info = await stat(resolved).catch((error: unknown) => {
		throw wordlistPathError("browser webSecurity wordlistPath does not exist", { path: filePath, resolved, cause: error instanceof Error ? error.message : String(error) });
	});
	if (!info.isFile()) throw wordlistPathError("browser webSecurity wordlistPath must point to a regular file", { path: filePath, resolved });
	if (info.size > WORDLIST_MAX_BYTES) throw wordlistPathError("browser webSecurity wordlistPath exceeds the bounded size limit", { path: filePath, resolved, bytes: info.size, maxBytes: WORDLIST_MAX_BYTES });
	const text = await readFile(resolved, "utf8");
	return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

export function sha256Hex(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

export function base64UrlDecode(value: string): Buffer | undefined {
	try {
		const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
		return Buffer.from(`${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`, "base64");
	} catch {
		return undefined;
	}
}

export function base64UrlEncode(value: string | Buffer): string {
	return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function printableText(buffer: Buffer): string | undefined {
	const text = buffer.toString("utf8");
	return /^[\x09\x0a\x0d\x20-\x7e\u0080-\uffff]*$/.test(text) ? text : undefined;
}

export function splitWords(value: unknown): string[] {
	return stringList(value).flatMap((item) => item.split(/[\r\n]+/)).map((item) => item.trim()).filter(Boolean);
}

export function parseCommandArgs(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((item) => asString(item)?.trim() || "").filter(Boolean);
	const input = asString(value)?.trim();
	if (!input) return [];
	const args: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;
	for (const char of input) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
				continue;
			}
			current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (escaped) throw normalizeInputError("Command args end with an unfinished escape sequence", { input });
	if (quote) throw normalizeInputError(`Command args contain an unclosed ${quote} quote`, { input, quote });
	if (current) args.push(current);
	return args;
}

export function sleep(ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => setTimeout(resolve, ms));
}
