export type JsAstParseDiagnostic = { code: number; message: string; line: number; column: number; length: number };
export type JsAstImportFact = { kind: "side-effect" | "default" | "named" | "namespace" | "default+named" | "default+namespace"; from: string; specifierCount: number; localNames: string[] };
export type JsAstExportFact = { kind: "named" | "default" | "declaration" | "export-all" | "re-export"; from?: string; name?: string; names?: string[] };
export type JsAstFunctionFact = { name: string; kind: "function" | "arrow" | "method" | "getter" | "setter" | "class-method" | "function-expression"; params: number; async: boolean; generator: boolean; topLevel: boolean; line: number };
export type JsAstStringArrayCandidate = { name: string; length: number; topLevel: boolean; sample: string[]; line: number };
export type JsAstDecoderCallFact = { callee: string; count: number; sampleArgs: string[] };
export type JsAstObjectDispatchCandidate = { name: string; keyCount: number; topLevel: boolean; line: number };
export type JsAstReductionFact = { applied: boolean; replacementCount: number; passes: Array<"stringArrayElement" | "decoderCall" | "constantExpression">; passCounts: Record<string, number>; preview: string; truncated: boolean; examples: Array<{ from: string; to: string; pass?: string }> };

export type JsAstAnalysis = {
	ok: boolean;
	parser: "typescript";
	sourceType: "module" | "script";
	bytes: number;
	lines: number;
	parseDiagnostics: JsAstParseDiagnostic[];
	summary: {
		topLevel: { statementCount: number; imports: number; exports: number; functions: number; variables: number; classes: number };
		imports: { count: number; truncated: boolean; entries: JsAstImportFact[] };
		exports: { count: number; truncated: boolean; entries: JsAstExportFact[] };
		functions: { total: number; truncated: boolean; entries: JsAstFunctionFact[] };
		suspicious: {
			evalCalls: number;
			functionConstructorCalls: number;
			atobCalls: number;
			unescapeCalls: number;
			computedStringArrayAccessCount: number;
			longStringArrayCount: number;
			stringDecoderAliasCount: number;
			objectDispatchAccessCount: number;
			whileTrueCount: number;
			switchInLoopCount: number;
			stringArrayCandidates: { count: number; truncated: boolean; entries: JsAstStringArrayCandidate[] };
			decoderCallCandidates: { count: number; truncated: boolean; entries: JsAstDecoderCallFact[] };
			objectDispatchCandidates: { count: number; truncated: boolean; entries: JsAstObjectDispatchCandidate[] };
		};
		reduction: JsAstReductionFact;
	};
};

export type JsAstAnalysisOptions = {
	fileName?: string;
	maxImports?: number;
	maxExports?: number;
	maxFunctions?: number;
	maxStringArrayCandidates?: number;
	maxDecoderCandidates?: number;
	maxReductionExamples?: number;
	maxReductionPreviewChars?: number;
	maxLocalNamesPerImport?: number;
	maxExportNames?: number;
	maxDecoderSampleArgs?: number;
	maxStringSampleItems?: number;
	minStringArrayCandidateLength?: number;
	maxObjectDispatchCandidates?: number;
	minObjectDispatchKeys?: number;
};

export const DEFAULT_OPTIONS: Required<JsAstAnalysisOptions> = {
	fileName: "inline.js",
	maxImports: 20,
	maxExports: 20,
	maxFunctions: 50,
	maxStringArrayCandidates: 10,
	maxDecoderCandidates: 10,
	maxReductionExamples: 10,
	maxReductionPreviewChars: 2_000,
	maxLocalNamesPerImport: 8,
	maxExportNames: 8,
	maxDecoderSampleArgs: 4,
	maxStringSampleItems: 4,
	minStringArrayCandidateLength: 3,
	maxObjectDispatchCandidates: 10,
	minObjectDispatchKeys: 3,
};

export type MutableImportFact = JsAstImportFact;
export type MutableExportFact = JsAstExportFact;
export type MutableFunctionFact = JsAstFunctionFact;
export type MutableStringArrayCandidate = JsAstStringArrayCandidate;
export type MutableSuspiciousSummary = {
	evalCalls: number;
	functionConstructorCalls: number;
	atobCalls: number;
	unescapeCalls: number;
	computedStringArrayAccessCount: number;
	objectDispatchAccessCount: number;
	whileTrueCount: number;
	switchInLoopCount: number;
	stringArrayCandidates: MutableStringArrayCandidate[];
	decoderCallCounts: Map<string, { count: number; sampleArgs: string[] }>;
	objectDispatchCandidates: JsAstObjectDispatchCandidate[];
	stringDecoderAliases: Set<string>;
	knownDecoderNames: Set<string>;
};
