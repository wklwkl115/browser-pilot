import path from "node:path";
import { artifactFallbackName } from "../../toolAdapter.js";
import { summarizeJsAstAnalysisData } from "../../summaries/webSecurity/jsAst.js";
import { analyzeJavaScriptArtifactInput, type JsAstArtifactAnalysis, type JsAstArtifactInput } from "./jsAstArtifact.js";
import { saveTextArtifact } from "../../artifacts.js";

export type JsAstShellContext = { cwd?: string } | undefined;

export type JsAstShellParams = JsAstArtifactInput & {
	outputPath?: string;
	maxChars?: number;
	artifactThreshold?: number;
};

export type JsAstShellResult = JsAstArtifactAnalysis & {
	summary: Record<string, unknown>;
	saved?: { path: string; chars: number; bytes: number; privacy: Record<string, unknown> };
};

function resolvedThreshold(value: unknown): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return 8_000;
	return Math.max(512, Math.min(100_000, Math.floor(n)));
}

function reductionArtifactPayload(result: JsAstArtifactAnalysis): string | undefined {
	const reduction = result.analysis.summary.reduction;
	if (!reduction.applied || !reduction.preview) return undefined;
	return JSON.stringify({
		input: result.input,
		reduction,
	}, null, 2);
}

export async function runJsAstShell(params: JsAstShellParams, ctx: JsAstShellContext): Promise<JsAstShellResult> {
	const analyzed = await analyzeJavaScriptArtifactInput(params);
	const summary = summarizeJsAstAnalysisData(analyzed);
	const reductionPayload = reductionArtifactPayload(analyzed);
	let saved: JsAstShellResult["saved"];
	if (reductionPayload) {
		const threshold = resolvedThreshold(params.artifactThreshold ?? params.maxChars);
		if (params.outputPath || reductionPayload.length > threshold || analyzed.analysis.summary.reduction.truncated) {
			const fallback = artifactFallbackName("js-ast-reduction");
			saved = await saveTextArtifact(ctx, params.outputPath, fallback, reductionPayload);
			summary.reductionArtifact = { path: saved.path, bytes: saved.bytes, chars: saved.chars };
			summary.reductionSavedToArtifact = true;
		}
	}
	return { ...analyzed, summary, saved };
}

export function defaultJsAstArtifactPath(ctx: JsAstShellContext, name = "js-ast-analysis.json"): string {
	return path.resolve(ctx?.cwd || process.cwd(), ".pi", "browser-artifacts", name);
}
