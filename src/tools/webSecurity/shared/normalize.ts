import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

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

export function normalizeMethod(value: unknown, fallback = "GET"): string {
	const method = String(value || fallback).trim().toUpperCase();
	if (!/^[A-Z][A-Z0-9_-]{0,31}$/.test(method)) throw new Error(`Invalid HTTP method: ${String(value)}`);
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

export async function readWordlist(value: unknown): Promise<string[]> {
	const filePath = asString(value)?.trim();
	if (!filePath) return [];
	const text = await readFile(filePath, "utf8");
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

export function tryJson(text: string): unknown | undefined {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export function printableText(buffer: Buffer): string | undefined {
	const text = buffer.toString("utf8");
	return /^[\x09\x0a\x0d\x20-\x7e\u0080-\uffff]*$/.test(text) ? text : undefined;
}

export function splitWords(value: unknown): string[] {
	return stringList(value).flatMap((item) => item.split(/[\r\n]+/)).map((item) => item.trim()).filter(Boolean);
}

export function sleep(ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => setTimeout(resolve, ms));
}
