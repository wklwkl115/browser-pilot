import { textPreview, type Summary, summaryTable } from "../common.js";
import type { JsAstArtifactAnalysis } from "../../webSecurity/shared/jsAstArtifact.js";
import { isRecord } from "../common.js";

function diagnosticsPreview(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.slice(0, 5).map((item) => {
		const record = isRecord(item) ? item : {};
		return {
			code: record.code,
			line: record.line,
			column: record.column,
			message: typeof record.message === "string" ? textPreview(record.message, 120) : record.message,
		};
	});
}

export function summarizeJsAstAnalysisData(value: unknown): Summary {
	const root = isRecord(value) ? value : {};
	const input = isRecord(root.input) ? root.input : {};
	const analysisMode = typeof root.analysisMode === "string" ? root.analysisMode : "ast";
	const lexical = isRecord(root.lexical) ? root.lexical : {};
	if (analysisMode === "lexical") {
		const lexicalSummary = isRecord(lexical.summary) ? lexical.summary : {};
		const tableFor = (name: string) => {
			const group = isRecord(lexicalSummary[name]) ? lexicalSummary[name] : {};
			return {
				count: group.count,
				truncated: group.truncated,
				table: summaryTable(Array.isArray(group.entries) ? group.entries : [], [
					{ key: "kind", value: (item) => isRecord(item) ? item.kind : undefined },
					{ key: "value", value: (item) => isRecord(item) && typeof item.value === "string" ? textPreview(item.value, 120) : undefined },
					{ key: "method", value: (item) => isRecord(item) ? item.method : undefined },
					{ key: "line", value: (item) => isRecord(item) ? item.line : undefined },
					{ key: "column", value: (item) => isRecord(item) ? item.column : undefined },
				], 12),
			};
		};
		return {
			ok: lexical.ok,
			analysisMode,
			input: { mode: input.mode, path: input.path, fileName: input.fileName, bytes: input.bytes, slice: input.slice, privacy: input.privacy },
			parser: lexical.parser,
			sourceType: lexical.sourceType,
			lines: lexical.lines,
			bytes: lexical.bytes,
			endpoints: tableFor("endpoints"),
			sinks: tableFor("sinks"),
			storage: tableFor("storage"),
			riskyCalls: tableFor("riskyCalls"),
			sourceMaps: tableFor("sourceMaps"),
			nextActions: [
				"large JavaScript used lexical inventory; rerun JavaScript AST reduction on a smaller slice or source-map archived source",
				"use browser_artifact search with contextChars or text columnOffset/columnLimit for exact long-line snippets",
			],
		};
	}
	const analysis = isRecord(root.analysis) ? root.analysis : {};
	const summary = isRecord(analysis.summary) ? analysis.summary : {};
	const imports = isRecord(summary.imports) ? summary.imports : {};
	const exportsSummary = isRecord(summary.exports) ? summary.exports : {};
	const functions = isRecord(summary.functions) ? summary.functions : {};
	const suspicious = isRecord(summary.suspicious) ? summary.suspicious : {};
	const reduction = isRecord(summary.reduction) ? summary.reduction : {};
	const stringArrays = isRecord(suspicious.stringArrayCandidates) ? suspicious.stringArrayCandidates : {};
	const decoderCalls = isRecord(suspicious.decoderCallCandidates) ? suspicious.decoderCallCandidates : {};
	const objectDispatch = isRecord(suspicious.objectDispatchCandidates) ? suspicious.objectDispatchCandidates : {};
	return {
		ok: analysis.ok,
		analysisMode,
		input: {
			mode: input.mode,
			path: input.path,
			fileName: input.fileName,
			bytes: input.bytes,
			privacy: input.privacy,
		},
		sourceType: analysis.sourceType,
		lines: analysis.lines,
		bytes: analysis.bytes,
		parseDiagnosticsCount: Array.isArray(analysis.parseDiagnostics) ? analysis.parseDiagnostics.length : 0,
		parseDiagnostics: diagnosticsPreview(analysis.parseDiagnostics),
		topLevel: summary.topLevel,
		imports: {
			count: imports.count,
			truncated: imports.truncated,
			table: summaryTable(Array.isArray(imports.entries) ? imports.entries : [], [
				{ key: "kind", value: (item) => isRecord(item) ? item.kind : undefined },
				{ key: "from", value: (item) => isRecord(item) ? item.from : undefined },
				{ key: "specifiers", value: (item) => isRecord(item) ? item.specifierCount : undefined },
				{ key: "locals", value: (item) => isRecord(item) && Array.isArray(item.localNames) ? item.localNames.join(",") : undefined },
			], 8),
		},
		exports: {
			count: exportsSummary.count,
			truncated: exportsSummary.truncated,
			table: summaryTable(Array.isArray(exportsSummary.entries) ? exportsSummary.entries : [], [
				{ key: "kind", value: (item) => isRecord(item) ? item.kind : undefined },
				{ key: "from", value: (item) => isRecord(item) ? item.from : undefined },
				{ key: "name", value: (item) => isRecord(item) ? item.name : undefined },
				{ key: "names", value: (item) => isRecord(item) && Array.isArray(item.names) ? item.names.join(",") : undefined },
			], 8),
		},
		functions: {
			total: functions.total,
			truncated: functions.truncated,
			table: summaryTable(Array.isArray(functions.entries) ? functions.entries : [], [
				{ key: "name", value: (item) => isRecord(item) ? item.name : undefined },
				{ key: "kind", value: (item) => isRecord(item) ? item.kind : undefined },
				{ key: "params", value: (item) => isRecord(item) ? item.params : undefined },
				{ key: "async", value: (item) => isRecord(item) ? item.async : undefined },
				{ key: "generator", value: (item) => isRecord(item) ? item.generator : undefined },
				{ key: "line", value: (item) => isRecord(item) ? item.line : undefined },
			], 10),
		},
		suspicious: {
			evalCalls: suspicious.evalCalls,
			functionConstructorCalls: suspicious.functionConstructorCalls,
			atobCalls: suspicious.atobCalls,
			unescapeCalls: suspicious.unescapeCalls,
			computedStringArrayAccessCount: suspicious.computedStringArrayAccessCount,
			longStringArrayCount: suspicious.longStringArrayCount,
			stringDecoderAliasCount: suspicious.stringDecoderAliasCount,
			objectDispatchAccessCount: suspicious.objectDispatchAccessCount,
			whileTrueCount: suspicious.whileTrueCount,
			switchInLoopCount: suspicious.switchInLoopCount,
			stringArrayCandidates: summaryTable(Array.isArray(stringArrays.entries) ? stringArrays.entries : [], [
				{ key: "name", value: (item) => isRecord(item) ? item.name : undefined },
				{ key: "length", value: (item) => isRecord(item) ? item.length : undefined },
				{ key: "sample", value: (item) => isRecord(item) && Array.isArray(item.sample) ? item.sample.join(",") : undefined },
			], 8),
			decoderCallCandidates: summaryTable(Array.isArray(decoderCalls.entries) ? decoderCalls.entries : [], [
				{ key: "callee", value: (item) => isRecord(item) ? item.callee : undefined },
				{ key: "count", value: (item) => isRecord(item) ? item.count : undefined },
				{ key: "sampleArgs", value: (item) => isRecord(item) && Array.isArray(item.sampleArgs) ? item.sampleArgs.join(",") : undefined },
			], 8),
			objectDispatchCandidates: summaryTable(Array.isArray(objectDispatch.entries) ? objectDispatch.entries : [], [
				{ key: "name", value: (item) => isRecord(item) ? item.name : undefined },
				{ key: "keys", value: (item) => isRecord(item) ? item.keyCount : undefined },
				{ key: "line", value: (item) => isRecord(item) ? item.line : undefined },
			], 8),
		},
		reduction: {
			applied: reduction.applied,
			replacementCount: reduction.replacementCount,
			passes: reduction.passes,
			passCounts: reduction.passCounts,
			truncated: reduction.truncated,
			preview: typeof reduction.preview === "string" ? textPreview(reduction.preview, 240) : reduction.preview,
			examples: Array.isArray(reduction.examples) ? reduction.examples.slice(0, 5) : [],
		},
		nextActions: [
			"read the saved artifact by path for full AST facts when the summary is insufficient",
			"narrow maxFunctions/maxImports/maxExports or suspicious-pattern focus for follow-up bounded analysis",
		],
	};
}

export type { JsAstArtifactAnalysis };
