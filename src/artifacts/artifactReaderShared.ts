import { SAFE_REGEX_DEFAULT_MAX_INPUT_CHARS, SAFE_REGEX_DEFAULT_MAX_PATTERN_CHARS } from "../utils/safeRegex.js";

export const MAX_ARTIFACT_READ_BYTES = 25 * 1024 * 1024;
export const MAX_ARTIFACT_SEARCH_REGEX_CHARS = SAFE_REGEX_DEFAULT_MAX_PATTERN_CHARS;
export const MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS = SAFE_REGEX_DEFAULT_MAX_INPUT_CHARS;
export const MAX_MULTI_ARTIFACT_FILES = 100;
export const MAX_MULTI_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_MULTI_ARTIFACT_MATCHES_PER_FILE = 20;
export const MAX_MULTI_ARTIFACT_TOTAL_MATCHES = 100;

export type ArtifactReaderErrorCode =
	| "ARTIFACT_NOT_FOUND"
	| "ARTIFACT_PATH_REQUIRED"
	| "ARTIFACT_PATH_OUTSIDE_ALLOWED_ROOT"
	| "ARTIFACT_SEARCH_QUERY_REQUIRED"
	| "ARTIFACT_SEARCH_REGEX_UNSAFE"
	| "ARTIFACT_SEARCH_REGEX_INVALID"
	| "ARTIFACT_MULTI_SEARCH_MODE_INVALID"
	| "ARTIFACT_QUERY_REQUIRES_SEARCH_MODE"
	| "ARTIFACT_JSON_INVALID"
	| "ARTIFACT_TOO_LARGE";

export class ArtifactReaderError extends Error {
	readonly code: ArtifactReaderErrorCode;
	readonly details: Record<string, unknown>;

	constructor(code: ArtifactReaderErrorCode, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "ArtifactReaderError";
		this.code = code;
		this.details = details;
	}
}

export type BrowserArtifactParams = {
	path?: string;
	paths?: string[];
	root?: string;
	glob?: string;
	mode?: string;
	offset?: number;
	limit?: number;
	maxChars?: number;
	jsonPath?: string;
	pick?: string[];
	query?: string;
	regex?: boolean;
	ignoreCase?: boolean;
	contextLines?: number;
	contextChars?: number;
	columnOffset?: number;
	columnLimit?: number;
	maxMatches?: number;
	maxFiles?: number;
	maxBytes?: number;
	maxMatchesPerFile?: number;
	maxTotalMatches?: number;
	redact?: boolean;
};

export type BrowserArtifactContext = { cwd?: string } | undefined;
export type TextSnippet = { lineStart: number; lineEnd: number; text: string; truncated: boolean; columnStart?: number; columnEnd?: number; lineLength?: number; truncatedBefore?: boolean; truncatedAfter?: boolean };
export type SearchSnippet = TextSnippet & { matchLine: number; path?: string; matchColumnStart?: number; matchColumnEnd?: number };
export type SampleSnippet = TextSnippet & { section: string; deduped?: boolean };
export type SkippedFile = { path: string; reason: string; size: number };
export type TruncationInfo = { truncated: true; truncationReason: string; bytesRead?: number; byteLimit?: number; matchesFound?: number; matchLimit?: number; totalMatches?: number; skippedFiles?: SkippedFile[] };

export type BrowserArtifactReadResult =
	| { mode: "text"; summary: Record<string, unknown>; offset: number; limit: number; nextOffset: number | null; snippets: TextSnippet[]; truncation?: TruncationInfo }
	| { mode: "search"; summary: Record<string, unknown>; query: string; regex: boolean; offset: number; matches: number; nextOffset: number | null; snippets: SearchSnippet[]; truncation?: TruncationInfo }
	| { mode: "sample"; summary: Record<string, unknown>; limit: number; snippets: SampleSnippet[]; truncation?: TruncationInfo }
	| { mode: "json"; summary: Record<string, unknown>; jsonPath?: string; pick?: string[]; value: unknown; truncation?: TruncationInfo };

export function summaryFromStats(fileSize: number, absPath: string, lineCount: number | null, chars: number | null = fileSize) {
	return { path: absPath, bytes: fileSize, chars, lineCount };
}
