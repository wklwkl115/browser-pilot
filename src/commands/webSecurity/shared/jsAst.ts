import ts from "typescript";
import { collectExportFacts, collectImportFacts, collectStringArrayCandidates, collectTopLevelCounts } from "./jsAstCollectors.js";
import { collectAnalysisPass } from "./jsAstAnalysisPass.js";
import { boundedOptions, lineAndColumnOf, moduleKindOf, sliceWithTruncation } from "./jsAstUtils.js";
import type { JsAstAnalysis, JsAstAnalysisOptions, JsAstParseDiagnostic } from "../../../kernels/security/jsAstTypes.js";

export type { JsAstAnalysis, JsAstAnalysisOptions, JsAstDecoderCallFact, JsAstExportFact, JsAstFunctionFact, JsAstImportFact, JsAstObjectDispatchCandidate, JsAstParseDiagnostic, JsAstReductionFact, JsAstStringArrayCandidate } from "../../../kernels/security/jsAstTypes.js";

function parseDiagnosticsOf(sourceFile: ts.SourceFile): JsAstParseDiagnostic[] {
	return (((sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics) || []).map((diag: ts.DiagnosticWithLocation) => {
		const position = lineAndColumnOf(sourceFile, diag.start || 0);
		return { code: Number(diag.code), message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"), line: position.line, column: position.column, length: Number(diag.length || 0) };
	});
}

// This facade keeps the public analysis contract stable while the collectors, reduction logic, and analysis pass live in smaller siblings.
export function analyzeJavaScriptSource(sourceText: string, options: JsAstAnalysisOptions = {}): JsAstAnalysis {
	const resolved = boundedOptions(options);
	const sourceFile = ts.createSourceFile(resolved.fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const parseDiagnostics = parseDiagnosticsOf(sourceFile);
	const imports = collectImportFacts(sourceFile, resolved);
	const exportsList = collectExportFacts(sourceFile, resolved);
	const topLevel = collectTopLevelCounts(sourceFile);
	const stringArrayCandidates = collectStringArrayCandidates(sourceFile, resolved);
	const analysis = collectAnalysisPass(sourceText, sourceFile, resolved, stringArrayCandidates);
	const importSlice = sliceWithTruncation(imports, resolved.maxImports);
	const exportSlice = sliceWithTruncation(exportsList, resolved.maxExports);
	return {
		ok: parseDiagnostics.length === 0,
		parser: "typescript",
		sourceType: moduleKindOf(sourceFile),
		bytes: Buffer.byteLength(sourceText, "utf8"),
		lines: sourceFile.getLineAndCharacterOfPosition(sourceText.length).line + 1,
		parseDiagnostics,
		summary: {
			topLevel,
			imports: { count: imports.length, truncated: importSlice.truncated, entries: importSlice.entries },
			exports: { count: exportsList.length, truncated: exportSlice.truncated, entries: exportSlice.entries },
			functions: { total: analysis.functions.length, truncated: analysis.functionSlice.truncated, entries: analysis.functionSlice.entries },
			suspicious: {
				evalCalls: analysis.suspicious.evalCalls,
				functionConstructorCalls: analysis.suspicious.functionConstructorCalls,
				atobCalls: analysis.suspicious.atobCalls,
				unescapeCalls: analysis.suspicious.unescapeCalls,
				computedStringArrayAccessCount: analysis.suspicious.computedStringArrayAccessCount,
				longStringArrayCount: analysis.suspicious.stringArrayCandidates.filter((item) => item.length >= 16).length,
				stringDecoderAliasCount: analysis.suspicious.stringDecoderAliases.size,
				objectDispatchAccessCount: analysis.suspicious.objectDispatchAccessCount || 0,
				whileTrueCount: analysis.suspicious.whileTrueCount,
				switchInLoopCount: analysis.suspicious.switchInLoopCount,
				stringArrayCandidates: { count: analysis.suspicious.stringArrayCandidates.length, truncated: analysis.stringArraySlice.truncated, entries: analysis.stringArraySlice.entries },
				decoderCallCandidates: { count: analysis.decoderCandidates.length, truncated: analysis.decoderSlice.truncated, entries: analysis.decoderSlice.entries },
				objectDispatchCandidates: { count: analysis.suspicious.objectDispatchCandidates.length, truncated: analysis.objectDispatchSlice.truncated, entries: analysis.objectDispatchSlice.entries },
			},
			reduction: analysis.reduction,
		},
	};
}
