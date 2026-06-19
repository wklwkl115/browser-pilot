import ts from "typescript";
import type { JsAstObjectDispatchCandidate, MutableStringArrayCandidate } from "./jsAstTypes.js";
import { calleeName, isWritableElementAccess, numericIndexValue, propertyNameText, returnsStringArrayIndex, stringLiteralValue } from "./jsAstUtils.js";

export function collectCandidateStringArrayValues(sourceFile: ts.SourceFile, candidates: Map<string, MutableStringArrayCandidate>): Map<string, string[]> {
	const values = new Map<string, string[]>();
	function visit(node: ts.Node): void {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isArrayLiteralExpression(node.initializer) && candidates.has(node.name.text)) values.set(node.name.text, node.initializer.elements.map((element) => stringLiteralValue(ts.isExpression(element) ? element : undefined) || ""));
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return values;
}
export function collectKnownDecoderMap(sourceFile: ts.SourceFile, candidates: Map<string, MutableStringArrayCandidate>): Map<string, { arrayName: string }> {
	const known = new Map<string, { arrayName: string }>();
	function visitFns(node: ts.Node): void {
		if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
			const decoderShape = returnsStringArrayIndex(node);
			if (decoderShape && candidates.has(decoderShape.arrayName)) known.set(node.name.text, { arrayName: decoderShape.arrayName });
		}
		ts.forEachChild(node, visitFns);
	}
	visitFns(sourceFile);
	let changed = true;
	while (changed) changed = visitDecoderAliases(sourceFile, known);
	return known;
}
function visitDecoderAliases(sourceFile: ts.SourceFile, known: Map<string, { arrayName: string }>): boolean {
	let changed = false;
	function visit(node: ts.Node): void {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isIdentifier(node.initializer) && known.has(node.initializer.text) && !known.has(node.name.text)) {
			known.set(node.name.text, known.get(node.initializer.text)!);
			changed = true;
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return changed;
}

export function reductionLiteralText(value: string | number | boolean | null): string {
	return typeof value === "string" ? JSON.stringify(value) : value === null ? "null" : String(value);
}

export function collectAliasMap(sourceFile: ts.SourceFile): Map<string, string> {
	const aliases = new Map<string, string>();
	function visit(node: ts.Node): void {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isIdentifier(node.initializer)) aliases.set(node.name.text, node.initializer.text);
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return aliases;
}
export function collectConstBindingMap(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
	const bindings = new Map<string, ts.Expression>();
	function visit(node: ts.Node): void {
		if (ts.isVariableStatement(node) && (node.declarationList.flags & ts.NodeFlags.Const) !== 0) for (const declaration of node.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.initializer) bindings.set(declaration.name.text, declaration.initializer);
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return bindings;
}
function returnExpressionOf(node: ts.Expression | ts.ObjectLiteralElementLike | undefined): ts.Expression | undefined {
	if (!node) return undefined;
	if (ts.isArrowFunction(node)) return ts.isBlock(node.body) ? undefined : node.body;
	if (ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
		if (!node.body || node.body.statements.length !== 1) return undefined;
		const statement = node.body.statements[0];
		return ts.isReturnStatement(statement) ? statement.expression : undefined;
	}
	return undefined;
}

export function collectObjectDispatchImplementationMap(sourceFile: ts.SourceFile, candidates: JsAstObjectDispatchCandidate[]): Map<string, Map<string, ts.Expression>> {
	const out = new Map<string, Map<string, ts.Expression>>();
	const candidateNames = new Set(candidates.map((item) => item.name));
	function visit(node: ts.Node): void {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && candidateNames.has(node.name.text) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) out.set(node.name.text, objectDispatchEntries(node.initializer));
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return out;
}

function objectDispatchEntries(initializer: ts.ObjectLiteralExpression): Map<string, ts.Expression> {
	const entries = new Map<string, ts.Expression>();
	for (const property of initializer.properties) {
		if (!(ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property))) continue;
		const key = propertyNameText(property.name);
		const expression = ts.isPropertyAssignment(property) ? returnExpressionOf(property.initializer) : returnExpressionOf(property);
		if (key && expression) entries.set(key, expression);
	}
	return entries;
}

export function tryDecodeCall(node: ts.CallExpression, decoderMap: Map<string, { arrayName: string }>, candidateValues: Map<string, string[]>): string | undefined {
	const callee = calleeName(node.expression, node.getSourceFile());
	if (!callee || !decoderMap.has(callee)) return undefined;
	const index = numericIndexValue(node.arguments[0]);
	const arrayName = decoderMap.get(callee)?.arrayName;
	const values = arrayName ? candidateValues.get(arrayName) : undefined;
	return values && index !== undefined && index < values.length ? values[index] : undefined;
}

export function resolveAliasName(name: string, aliases: Map<string, string>): string {
	let current = name;
	const seen = new Set<string>([current]);
	while (aliases.has(current) && !seen.has(String(aliases.get(current)))) {
		current = String(aliases.get(current));
		seen.add(current);
	}
	return current;
}

function objectDispatchTarget(node: ts.CallExpression, aliases: Map<string, string>): { objectName?: string; propertyName?: string } {
	const callee = node.expression;
	if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) return { objectName: resolveAliasName(callee.expression.text, aliases), propertyName: callee.name.text };
	if (ts.isElementAccessExpression(callee) && ts.isIdentifier(callee.expression)) return { objectName: resolveAliasName(callee.expression.text, aliases), propertyName: stringLiteralValue(callee.argumentExpression) ?? (numericIndexValue(callee.argumentExpression) !== undefined ? String(numericIndexValue(callee.argumentExpression)) : undefined) };
	return {};
}

export function tryObjectDispatchCall(node: ts.CallExpression, objectDispatchMap: Map<string, Map<string, ts.Expression>>, decoderMap: Map<string, { arrayName: string }>, candidateValues: Map<string, string[]>, aliases: Map<string, string>, constBindings: Map<string, ts.Expression>, depth: number): string | number | boolean | null | undefined {
	const { objectName, propertyName } = objectDispatchTarget(node, aliases);
	if (!objectName || !propertyName || !objectDispatchMap.has(objectName)) return undefined;
	const expression = objectDispatchMap.get(objectName)?.get(propertyName);
	return expression ? evaluateConstantExpression(expression, decoderMap, candidateValues, aliases, constBindings, objectDispatchMap, depth + 1) : undefined;
}

export function evaluateConstantExpression(node: ts.Expression, decoderMap: Map<string, { arrayName: string }>, candidateValues: Map<string, string[]>, aliases: Map<string, string>, constBindings: Map<string, ts.Expression>, objectDispatchMap: Map<string, Map<string, ts.Expression>>, depth = 0): string | number | boolean | null | undefined {
	if (depth > 12) return undefined;
	if (ts.isParenthesizedExpression(node)) return evaluateConstantExpression(node.expression, decoderMap, candidateValues, aliases, constBindings, objectDispatchMap, depth + 1);
	if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	if (ts.isNumericLiteral(node)) {
		const n = Number(node.text);
		return Number.isFinite(n) ? n : undefined;
	}
	if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
	if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
	if (node.kind === ts.SyntaxKind.NullKeyword) return null;
	if (ts.isIdentifier(node)) return evaluateIdentifier(node, decoderMap, candidateValues, aliases, constBindings, objectDispatchMap, depth);
	if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && !isWritableElementAccess(node)) {
		const values = candidateValues.get(resolveAliasName(node.expression.text, aliases));
		const index = numericIndexValue(node.argumentExpression);
		return values && index !== undefined && index < values.length ? values[index] : undefined;
	}
	if (ts.isCallExpression(node)) return tryObjectDispatchCall(node, objectDispatchMap, decoderMap, candidateValues, aliases, constBindings, depth) ?? tryDecodeCall(node, decoderMap, candidateValues);
	if (ts.isPrefixUnaryExpression(node)) return evaluatePrefix(node, decoderMap, candidateValues, aliases, constBindings, objectDispatchMap, depth);
	if (ts.isBinaryExpression(node)) return evaluateBinary(node, decoderMap, candidateValues, aliases, constBindings, objectDispatchMap, depth);
	return undefined;
}

function evaluateIdentifier(node: ts.Identifier, decoderMap: Map<string, { arrayName: string }>, candidateValues: Map<string, string[]>, aliases: Map<string, string>, constBindings: Map<string, ts.Expression>, objectDispatchMap: Map<string, Map<string, ts.Expression>>, depth: number) {
	const resolved = resolveAliasName(node.text, aliases);
	const binding = constBindings.get(resolved);
	if (binding) return evaluateConstantExpression(binding, decoderMap, candidateValues, aliases, constBindings, objectDispatchMap, depth + 1);
	if (resolved !== node.text) return evaluateConstantExpression(ts.factory.createIdentifier(resolved), decoderMap, candidateValues, aliases, constBindings, objectDispatchMap, depth + 1);
	return undefined;
}

function evaluatePrefix(node: ts.PrefixUnaryExpression, decoderMap: Map<string, { arrayName: string }>, candidateValues: Map<string, string[]>, aliases: Map<string, string>, constBindings: Map<string, ts.Expression>, objectDispatchMap: Map<string, Map<string, ts.Expression>>, depth: number) {
	const value = evaluateConstantExpression(node.operand, decoderMap, candidateValues, aliases, constBindings, objectDispatchMap, depth + 1);
	if (value === undefined) return undefined;
	if (node.operator === ts.SyntaxKind.ExclamationToken) return !value;
	if (typeof value !== "number") return undefined;
	if (node.operator === ts.SyntaxKind.PlusToken) return +value;
	if (node.operator === ts.SyntaxKind.MinusToken) return -value;
	if (node.operator === ts.SyntaxKind.TildeToken) return ~value;
	return undefined;
}

function evaluateBinary(node: ts.BinaryExpression, decoderMap: Map<string, { arrayName: string }>, candidateValues: Map<string, string[]>, aliases: Map<string, string>, constBindings: Map<string, ts.Expression>, objectDispatchMap: Map<string, Map<string, ts.Expression>>, depth: number) {
	const left = evaluateConstantExpression(node.left, decoderMap, candidateValues, aliases, constBindings, objectDispatchMap, depth + 1);
	const right = evaluateConstantExpression(node.right, decoderMap, candidateValues, aliases, constBindings, objectDispatchMap, depth + 1);
	if (left === undefined || right === undefined) return undefined;
	return applyBinaryOperator(node.operatorToken.kind, left, right);
}

function applyBinaryOperator(kind: ts.SyntaxKind, left: string | number | boolean | null, right: string | number | boolean | null) {
	switch (kind) {
		case ts.SyntaxKind.PlusToken: return typeof left === "string" || typeof right === "string" ? String(left) + String(right) : typeof left === "number" && typeof right === "number" ? left + right : undefined;
		case ts.SyntaxKind.MinusToken: return typeof left === "number" && typeof right === "number" ? left - right : undefined;
		case ts.SyntaxKind.AsteriskToken: return typeof left === "number" && typeof right === "number" ? left * right : undefined;
		case ts.SyntaxKind.SlashToken: return typeof left === "number" && typeof right === "number" ? left / right : undefined;
		case ts.SyntaxKind.PercentToken: return typeof left === "number" && typeof right === "number" ? left % right : undefined;
		case ts.SyntaxKind.AsteriskAsteriskToken: return typeof left === "number" && typeof right === "number" ? left ** right : undefined;
		case ts.SyntaxKind.AmpersandAmpersandToken: return left && right;
		case ts.SyntaxKind.BarBarToken: return left || right;
		case ts.SyntaxKind.QuestionQuestionToken: return left ?? right;
		case ts.SyntaxKind.EqualsEqualsEqualsToken: return left === right;
		case ts.SyntaxKind.ExclamationEqualsEqualsToken: return left !== right;
		case ts.SyntaxKind.EqualsEqualsToken: return left == right;
		case ts.SyntaxKind.ExclamationEqualsToken: return left != right;
		case ts.SyntaxKind.LessThanToken: return (left as never) < (right as never);
		case ts.SyntaxKind.LessThanEqualsToken: return (left as never) <= (right as never);
		case ts.SyntaxKind.GreaterThanToken: return (left as never) > (right as never);
		case ts.SyntaxKind.GreaterThanEqualsToken: return (left as never) >= (right as never);
		default: return undefined;
	}
}
