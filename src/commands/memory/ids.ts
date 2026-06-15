import { createCodedError } from "../../utils/codedError.js";

const MEMORY_ENTRY_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function normalizeMemoryEntryId(id: unknown): string {
	const normalized = String(id || "").trim();
	if (!MEMORY_ENTRY_ID_RE.test(normalized) || normalized === "." || normalized === "..") {
		throw createCodedError({ name: "MemoryReadError", code: "MEMORY_SCHEMA_INVALID", message: "browser_memory entry id is invalid" });
	}
	return normalized;
}
