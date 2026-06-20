import ts from "typescript";
import type { JsAstAnalysisOptions, JsAstReductionFact, MutableStringArrayCandidate } from "./jsAstTypes.js";
import { collectObjectDispatchCandidates } from "./jsAstCollectors.js";
import { collectAliasMap, collectCandidateStringArrayValues, collectConstBindingMap, collectKnownDecoderMap, collectObjectDispatchImplementationMap, evaluateConstantExpression, reductionLiteralText, resolveAliasName, tryDecodeCall, tryObjectDispatchCall } from "./jsAstReductionContext.js";
import { numericIndexValue } from "./jsAstUtils.js";
import { applyNativeJsAstReduction } from "../../../native/browserPilotNativeKernels.js";

type ReductionPass = "stringArrayElement" | "decoderCall" | "constantExpression" | "aliasPropagation" | "objectDispatch";
type PublicReductionPass = "stringArrayElement" | "decoderCall" | "constantExpression";
type DeterministicReplacement = { start: number; end: number; text: string; from: string; to: string; pass: ReductionPass };

function selectNonOverlappingReplacements(replacements: DeterministicReplacement[]): DeterministicReplacement[] {
	const selected: DeterministicReplacement[] = [];
	for (const candidate of replacements.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)) {
		if (selected.some((item) => candidate.start < item.end && item.start < candidate.end)) continue;
		selected.push(candidate);
	}
	return selected.sort((a, b) => a.start - b.start);
}

export function applyDeterministicReduction(sourceText: string, sourceFile: ts.SourceFile, candidates: Map<string, MutableStringArrayCandidate>, options: Required<JsAstAnalysisOptions>): JsAstReductionFact {
	const objectDispatchCandidates = collectObjectDispatchCandidates(sourceFile, options);
	const native = applyNativeJsAstReduction({
		sourceText,
		candidateNames: Array.from(candidates.keys()),
		objectDispatchNames: objectDispatchCandidates.map((item) => item.name),
		options,
	});
	if (native) return native;
	const candidateValues = collectCandidateStringArrayValues(sourceFile, candidates);
	const decoderMap = collectKnownDecoderMap(sourceFile, candidates);
	const aliases = collectAliasMap(sourceFile);
	const constBindings = collectConstBindingMap(sourceFile);
	const objectDispatchMap = collectObjectDispatchImplementationMap(sourceFile, objectDispatchCandidates);
	const replacements: DeterministicReplacement[] = [];
	function visit(node: ts.Node): void {
		if (ts.isExpression(node)) recordReplacement(sourceFile, node, decoderMap, candidateValues, aliases, constBindings, objectDispatchMap, replacements);
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	const selected = selectNonOverlappingReplacements(replacements);
	if (!selected.length) return { applied: false, replacementCount: 0, passes: [], passCounts: {}, preview: "", truncated: false, examples: [] };
	let reduced = sourceText;
	for (const replacement of selected.sort((a, b) => b.start - a.start)) reduced = `${reduced.slice(0, replacement.start)}${replacement.text}${reduced.slice(replacement.end)}`;
	const truncated = reduced.length > options.maxReductionPreviewChars;
	const passCounts = Object.fromEntries(selected.reduce((map, item) => map.set(item.pass, (map.get(item.pass) || 0) + 1), new Map<string, number>()));
	return { applied: true, replacementCount: selected.length, passes: Array.from(new Set(selected.map((item) => item.pass))).filter((pass): pass is PublicReductionPass => pass === "stringArrayElement" || pass === "decoderCall" || pass === "constantExpression"), passCounts, preview: truncated ? `${reduced.slice(0, options.maxReductionPreviewChars)}…` : reduced, truncated, examples: selected.slice(0, options.maxReductionExamples).map((item) => ({ from: item.from, to: item.to, pass: item.pass })) };
}

function recordReplacement(sourceFile: ts.SourceFile, node: ts.Expression, decoderMap: Map<string, { arrayName: string }>, candidateValues: Map<string, string[]>, aliases: Map<string, string>, constBindings: Map<string, ts.Expression>, objectDispatchMap: Map<string, Map<string, ts.Expression>>, replacements: DeterministicReplacement[]) {
	const constantValue = evaluateConstantExpression(node, decoderMap, candidateValues, aliases, constBindings, objectDispatchMap);
	if (constantValue === undefined || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return;
	let pass: ReductionPass = "constantExpression";
	if (ts.isIdentifier(node) && resolveAliasName(node.text, aliases) !== node.text) pass = "aliasPropagation";
	else if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && candidateValues.has(resolveAliasName(node.expression.text, aliases)) && numericIndexValue(node.argumentExpression) !== undefined) pass = "stringArrayElement";
	else if (ts.isCallExpression(node) && tryObjectDispatchCall(node, objectDispatchMap, decoderMap, candidateValues, aliases, constBindings, 0) !== undefined) pass = "objectDispatch";
	else if (ts.isCallExpression(node) && tryDecodeCall(node, decoderMap, candidateValues) !== undefined) pass = "decoderCall";
	const text = reductionLiteralText(constantValue);
	if (text !== node.getText(sourceFile)) replacements.push({ start: node.getStart(sourceFile), end: node.getEnd(), text, from: node.getText(sourceFile).slice(0, 120), to: text.slice(0, 120), pass });
}
