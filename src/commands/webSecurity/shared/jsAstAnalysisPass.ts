import ts from "typescript";
import type { JsAstAnalysisOptions, MutableFunctionFact, MutableSuspiciousSummary } from "./jsAstTypes.js";
import { calleeName, classifyFunctionKind, inferFunctionName, isInfiniteWhile, isTopLevelFunctionLike, lineOf, numericIndexValue, returnsStringArrayIndex, sampleArgument, sliceWithTruncation } from "./jsAstUtils.js";
import { collectObjectDispatchCandidates } from "./jsAstCollectors.js";
import { applyDeterministicReduction } from "./jsAstReduction.js";

export function collectAnalysisPass(sourceText: string, sourceFile: ts.SourceFile, resolved: Required<JsAstAnalysisOptions>, stringArrayCandidates: Map<string, { name: string; length: number; topLevel: boolean; sample: string[]; line: number }>) {
	const suspicious: MutableSuspiciousSummary = { evalCalls: 0, functionConstructorCalls: 0, atobCalls: 0, unescapeCalls: 0, computedStringArrayAccessCount: 0, objectDispatchAccessCount: 0, whileTrueCount: 0, switchInLoopCount: 0, stringArrayCandidates: Array.from(stringArrayCandidates.values()).sort((a, b) => a.line - b.line), decoderCallCounts: new Map(), objectDispatchCandidates: collectObjectDispatchCandidates(sourceFile, resolved), stringDecoderAliases: new Set(), knownDecoderNames: new Set() };
	const functions: MutableFunctionFact[] = [];
	visitAnalysis(sourceFile, sourceFile, resolved, stringArrayCandidates, suspicious, functions);
	const functionSlice = sliceWithTruncation(functions.sort((a, b) => a.line - b.line), resolved.maxFunctions);
	const stringArraySlice = sliceWithTruncation(suspicious.stringArrayCandidates, resolved.maxStringArrayCandidates);
	const decoderCandidates = Array.from(suspicious.decoderCallCounts.entries()).map(([callee, value]) => ({ callee, count: value.count, sampleArgs: value.sampleArgs.slice(0, resolved.maxDecoderSampleArgs) })).sort((a, b) => b.count - a.count || a.callee.localeCompare(b.callee));
	const decoderSlice = sliceWithTruncation(decoderCandidates, resolved.maxDecoderCandidates);
	const objectDispatchSlice = sliceWithTruncation(suspicious.objectDispatchCandidates, resolved.maxObjectDispatchCandidates);
	return { functionSlice, stringArraySlice, decoderCandidates, decoderSlice, objectDispatchSlice, suspicious, reduction: applyDeterministicReduction(sourceText, sourceFile, stringArrayCandidates, resolved), functions };
}

function visitAnalysis(sourceFile: ts.SourceFile, node: ts.Node, resolved: Required<JsAstAnalysisOptions>, stringArrayCandidates: Map<string, { name: string; length: number; topLevel: boolean; sample: string[]; line: number }>, suspicious: MutableSuspiciousSummary, functions: MutableFunctionFact[], loopDepth = 0): void {
	if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) functions.push({ name: inferFunctionName(node, sourceFile), kind: classifyFunctionKind(node), params: node.parameters.length, async: ts.canHaveModifiers(node) ? !!ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) : false, generator: !!(node as ts.FunctionLikeDeclarationBase).asteriskToken, topLevel: isTopLevelFunctionLike(node), line: lineOf(sourceFile, node.getStart(sourceFile)) });
	if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
		const decoderShape = returnsStringArrayIndex(node);
		if (decoderShape && stringArrayCandidates.has(decoderShape.arrayName)) suspicious.knownDecoderNames.add(node.name.text);
	}
	if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isIdentifier(node.initializer) && suspicious.knownDecoderNames.has(node.initializer.text)) {
		suspicious.stringDecoderAliases.add(node.name.text);
		suspicious.knownDecoderNames.add(node.name.text);
	}
	if (ts.isCallExpression(node)) recordSuspiciousCall(sourceFile, node, resolved, suspicious);
	if (ts.isNewExpression(node) && calleeName(node.expression, sourceFile) === "Function") suspicious.functionConstructorCalls += 1;
	if (ts.isElementAccessExpression(node)) {
		const target = node.expression;
		if (ts.isIdentifier(target) && stringArrayCandidates.has(target.text) && numericIndexValue(node.argumentExpression) !== undefined) suspicious.computedStringArrayAccessCount += 1;
		if (ts.isIdentifier(target) && suspicious.objectDispatchCandidates.some((item) => item.name === target.text)) suspicious.objectDispatchAccessCount = (suspicious.objectDispatchAccessCount || 0) + 1;
	}
	if (ts.isWhileStatement(node) && isInfiniteWhile(node)) suspicious.whileTrueCount += 1;
	if (ts.isSwitchStatement(node) && loopDepth > 0) suspicious.switchInLoopCount += 1;
	const nextLoopDepth = loopDepth + (ts.isWhileStatement(node) || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isDoStatement(node) ? 1 : 0);
	ts.forEachChild(node, (child) => visitAnalysis(sourceFile, child, resolved, stringArrayCandidates, suspicious, functions, nextLoopDepth));
}

function recordSuspiciousCall(sourceFile: ts.SourceFile, node: ts.CallExpression, resolved: Required<JsAstAnalysisOptions>, suspicious: MutableSuspiciousSummary): void {
	const name = calleeName(node.expression, sourceFile);
	if (name === "eval") suspicious.evalCalls += 1;
	if (name === "atob") suspicious.atobCalls += 1;
	if (name === "unescape") suspicious.unescapeCalls += 1;
	if (!name || (!node.arguments.some((arg) => ts.isNumericLiteral(arg)) && !suspicious.knownDecoderNames.has(name))) return;
	const bucket = suspicious.decoderCallCounts.get(name) || { count: 0, sampleArgs: [] };
	bucket.count += 1;
	for (const arg of node.arguments) {
		if (bucket.sampleArgs.length >= resolved.maxDecoderSampleArgs) break;
		bucket.sampleArgs.push(sampleArgument(arg, sourceFile));
	}
	suspicious.decoderCallCounts.set(name, bucket);
}
