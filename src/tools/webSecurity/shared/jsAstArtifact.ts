import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import { analyzeJavaScriptSource, type JsAstAnalysis, type JsAstAnalysisOptions } from "./jsAst.js";

export const JS_AST_MAX_INPUT_BYTES = 2 * 1024 * 1024;

export type JsAstArtifactErrorCode =
	| "JS_AST_INPUT_CONFLICT"
	| "JS_AST_INPUT_REQUIRED"
	| "JS_AST_INPUT_NOT_FILE"
	| "JS_AST_INPUT_TOO_LARGE";

export class JsAstArtifactError extends Error {
	readonly code: JsAstArtifactErrorCode;
	readonly details: Record<string, unknown>;

	constructor(code: JsAstArtifactErrorCode, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "JsAstArtifactError";
		this.code = code;
		this.details = details;
	}
}

export type JsAstArtifactInput = {
	path?: string;
	text?: string;
	fileName?: string;
	maxBytes?: number;
	analysis?: JsAstAnalysisOptions;
};

export type JsAstArtifactAnalysis = {
	input: {
		mode: "path" | "text";
		path?: string;
		fileName: string;
		bytes: number;
		truncated: boolean;
		privacy: { localOnly: true; artifactFirst: true };
	};
	analysis: JsAstAnalysis;
};

function normalizeMaxBytes(value: unknown): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return JS_AST_MAX_INPUT_BYTES;
	return Math.max(256, Math.min(JS_AST_MAX_INPUT_BYTES, Math.floor(n)));
}

function defaultFileName(value: unknown, fallback = "inline.js"): string {
	const text = String(value || "").trim();
	return text || fallback;
}

function ensureExclusiveInput(input: JsAstArtifactInput): void {
	if (input.path && input.text !== undefined) throw new JsAstArtifactError("JS_AST_INPUT_CONFLICT", "Provide either path or text, not both", { hasPath: true, hasText: true });
	if (!input.path && input.text === undefined) throw new JsAstArtifactError("JS_AST_INPUT_REQUIRED", "Provide explicit JavaScript text or a local file path", {});
}

export async function analyzeJavaScriptArtifactInput(input: JsAstArtifactInput): Promise<JsAstArtifactAnalysis> {
	ensureExclusiveInput(input);
	const maxBytes = normalizeMaxBytes(input.maxBytes);
	if (input.path) {
		const absPath = path.resolve(input.path);
		const info = await stat(absPath);
		if (!info.isFile()) throw new JsAstArtifactError("JS_AST_INPUT_NOT_FILE", "JS AST input path must be a file", { path: absPath });
		if (info.size > maxBytes) throw new JsAstArtifactError("JS_AST_INPUT_TOO_LARGE", "JS AST input exceeds bounded byte limit", { path: absPath, bytes: info.size, maxBytes });
		const text = await readFile(absPath, "utf8");
		return {
			input: {
				mode: "path",
				path: absPath,
				fileName: defaultFileName(input.fileName, path.basename(absPath)),
				bytes: Buffer.byteLength(text, "utf8"),
				truncated: false,
				privacy: { localOnly: true, artifactFirst: true },
			},
			analysis: analyzeJavaScriptSource(text, { ...(input.analysis || {}), fileName: defaultFileName(input.fileName, path.basename(absPath)) }),
		};
	}
	const rawText = String(input.text || "");
	const bytes = Buffer.byteLength(rawText, "utf8");
	if (bytes > maxBytes) throw new JsAstArtifactError("JS_AST_INPUT_TOO_LARGE", "JS AST text input exceeds bounded byte limit", { bytes, maxBytes });
	const fileName = defaultFileName(input.fileName, "inline.js");
	return {
		input: {
			mode: "text",
			fileName,
			bytes,
			truncated: false,
			privacy: { localOnly: true, artifactFirst: true },
		},
		analysis: analyzeJavaScriptSource(rawText, { ...(input.analysis || {}), fileName }),
	};
}
