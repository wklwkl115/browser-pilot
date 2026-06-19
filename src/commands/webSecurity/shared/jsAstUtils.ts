import ts from "typescript";
import { DEFAULT_OPTIONS, type JsAstAnalysisOptions, type JsAstFunctionFact } from "./jsAstTypes.js";

export function boundedOptions(options: JsAstAnalysisOptions = {}): Required<JsAstAnalysisOptions> {
	return {
		fileName: String(options.fileName || DEFAULT_OPTIONS.fileName),
		maxImports: normalizePositiveInt(options.maxImports, DEFAULT_OPTIONS.maxImports, 1, 200),
		maxExports: normalizePositiveInt(options.maxExports, DEFAULT_OPTIONS.maxExports, 1, 200),
		maxFunctions: normalizePositiveInt(options.maxFunctions, DEFAULT_OPTIONS.maxFunctions, 1, 500),
		maxStringArrayCandidates: normalizePositiveInt(options.maxStringArrayCandidates, DEFAULT_OPTIONS.maxStringArrayCandidates, 1, 100),
		maxDecoderCandidates: normalizePositiveInt(options.maxDecoderCandidates, DEFAULT_OPTIONS.maxDecoderCandidates, 1, 100),
		maxReductionExamples: normalizePositiveInt(options.maxReductionExamples, DEFAULT_OPTIONS.maxReductionExamples, 1, 100),
		maxReductionPreviewChars: normalizePositiveInt(options.maxReductionPreviewChars, DEFAULT_OPTIONS.maxReductionPreviewChars, 100, 20_000),
		maxLocalNamesPerImport: normalizePositiveInt(options.maxLocalNamesPerImport, DEFAULT_OPTIONS.maxLocalNamesPerImport, 1, 100),
		maxExportNames: normalizePositiveInt(options.maxExportNames, DEFAULT_OPTIONS.maxExportNames, 1, 100),
		maxDecoderSampleArgs: normalizePositiveInt(options.maxDecoderSampleArgs, DEFAULT_OPTIONS.maxDecoderSampleArgs, 1, 20),
		maxStringSampleItems: normalizePositiveInt(options.maxStringSampleItems, DEFAULT_OPTIONS.maxStringSampleItems, 1, 20),
		minStringArrayCandidateLength: normalizePositiveInt(options.minStringArrayCandidateLength, DEFAULT_OPTIONS.minStringArrayCandidateLength, 1, 200),
		maxObjectDispatchCandidates: normalizePositiveInt(options.maxObjectDispatchCandidates, DEFAULT_OPTIONS.maxObjectDispatchCandidates, 1, 100),
		minObjectDispatchKeys: normalizePositiveInt(options.minObjectDispatchKeys, DEFAULT_OPTIONS.minObjectDispatchKeys, 1, 100),
	};
}

function normalizePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

export function sliceWithTruncation<T>(items: T[], limit: number): { entries: T[]; truncated: boolean } {
	return { entries: items.slice(0, limit), truncated: items.length > limit };
}

export function lineOf(sourceFile: ts.SourceFile, position: number): number {
	return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

export function lineAndColumnOf(sourceFile: ts.SourceFile, position: number): { line: number; column: number } {
	const loc = sourceFile.getLineAndCharacterOfPosition(position);
	return { line: loc.line + 1, column: loc.character + 1 };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
	return ts.canHaveModifiers(node) ? !!ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) : false;
}

export function moduleKindOf(sourceFile: ts.SourceFile): "module" | "script" {
	return sourceFile.isDeclarationFile || sourceFile.statements.some((statement) => ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || hasModifier(statement, ts.SyntaxKind.ExportKeyword) || hasModifier(statement, ts.SyntaxKind.DefaultKeyword) || ts.isExportAssignment(statement)) ? "module" : "script";
}

export function textOfModuleSpecifier(node: ts.Expression | undefined): string | undefined {
	return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

export function identifierText(node: ts.Node | undefined): string | undefined {
	return node && ts.isIdentifier(node) ? node.text : undefined;
}

export function propertyNameText(node: ts.PropertyName | ts.BindingName | undefined): string | undefined {
	if (!node) return undefined;
	if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return String(node.text);
	return ts.isComputedPropertyName(node) ? undefined : undefined;
}

export function stringLiteralValue(node: ts.Expression | undefined): string | undefined {
	if (!node) return undefined;
	return ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

export function numericIndexValue(node: ts.Expression | undefined): number | undefined {
	if (!node) return undefined;
	if (!ts.isNumericLiteral(node)) return undefined;
	const n = Number(node.text);
	return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export function isTopLevelFunctionLike(node: ts.Node): boolean {
	return !!node.parent && ts.isSourceFile(node.parent);
}

export function inferFunctionName(node: ts.Node, sourceFile: ts.SourceFile): string {
	if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.name) return propertyNameText(node.name) || `<anonymous@${lineOf(sourceFile, node.getStart(sourceFile))}>`;
	if ((ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && ts.isVariableDeclaration(node.parent)) return propertyNameText(node.parent.name) || `<anonymous@${lineOf(sourceFile, node.getStart(sourceFile))}>`;
	return `<anonymous@${lineOf(sourceFile, node.getStart(sourceFile))}>`;
}

export function classifyFunctionKind(node: ts.Node): JsAstFunctionFact["kind"] {
	if (ts.isArrowFunction(node)) return "arrow";
	if (ts.isMethodDeclaration(node)) return ts.isClassLike(node.parent) ? "class-method" : "method";
	if (ts.isGetAccessorDeclaration(node)) return "getter";
	if (ts.isSetAccessorDeclaration(node)) return "setter";
	if (ts.isFunctionExpression(node)) return "function-expression";
	return "function";
}

export function calleeName(node: ts.LeftHandSideExpression, sourceFile: ts.SourceFile): string | undefined {
	if (ts.isIdentifier(node)) return node.text;
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
	return sourceFile.text.slice(node.getStart(sourceFile), node.getEnd()).slice(0, 120);
}

export function sampleArgument(node: ts.Expression, sourceFile: ts.SourceFile): string {
	const text = sourceFile.text.slice(node.getStart(sourceFile), node.getEnd());
	return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

export function isInfiniteWhile(node: ts.WhileStatement): boolean {
	return node.expression.kind === ts.SyntaxKind.TrueKeyword;
}

export function isWritableElementAccess(node: ts.ElementAccessExpression): boolean {
	const parent = node.parent;
	return (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === node) || (ts.isPostfixUnaryExpression(parent) && parent.operand === node) || (ts.isPrefixUnaryExpression(parent) && parent.operand === node);
}

export function returnsStringArrayIndex(node: ts.FunctionLikeDeclarationBase): { arrayName: string; argName?: string } | undefined {
	if (!node.body || !ts.isBlock(node.body) || node.body.statements.length !== 1) return undefined;
	const statement = node.body.statements[0];
	if (!ts.isReturnStatement(statement) || !statement.expression || !ts.isElementAccessExpression(statement.expression) || !ts.isIdentifier(statement.expression.expression)) return undefined;
	const arg = statement.expression.argumentExpression;
	const argName = arg && ts.isIdentifier(arg) ? arg.text : undefined;
	return { arrayName: statement.expression.expression.text, ...(argName ? { argName } : {}) };
}
