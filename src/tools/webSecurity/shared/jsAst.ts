import ts from "typescript";

export type JsAstParseDiagnostic = {
	code: number;
	message: string;
	line: number;
	column: number;
	length: number;
};

export type JsAstImportFact = {
	kind: "side-effect" | "default" | "named" | "namespace" | "default+named" | "default+namespace";
	from: string;
	specifierCount: number;
	localNames: string[];
};

export type JsAstExportFact = {
	kind: "named" | "default" | "declaration" | "export-all" | "re-export";
	from?: string;
	name?: string;
	names?: string[];
};

export type JsAstFunctionFact = {
	name: string;
	kind: "function" | "arrow" | "method" | "getter" | "setter" | "class-method" | "function-expression";
	params: number;
	async: boolean;
	generator: boolean;
	topLevel: boolean;
	line: number;
};

export type JsAstStringArrayCandidate = {
	name: string;
	length: number;
	topLevel: boolean;
	sample: string[];
	line: number;
};

export type JsAstDecoderCallFact = {
	callee: string;
	count: number;
	sampleArgs: string[];
};

export type JsAstObjectDispatchCandidate = {
	name: string;
	keyCount: number;
	topLevel: boolean;
	line: number;
};

export type JsAstReductionFact = {
	applied: boolean;
	replacementCount: number;
	passes: Array<"stringArrayElement" | "decoderCall" | "constantExpression">;
	passCounts: Record<string, number>;
	preview: string;
	truncated: boolean;
	examples: Array<{ from: string; to: string; pass?: string }>;
};

export type JsAstAnalysis = {
	ok: boolean;
	parser: "typescript";
	sourceType: "module" | "script";
	bytes: number;
	lines: number;
	parseDiagnostics: JsAstParseDiagnostic[];
	summary: {
		topLevel: {
			statementCount: number;
			imports: number;
			exports: number;
			functions: number;
			variables: number;
			classes: number;
		};
		imports: {
			count: number;
			truncated: boolean;
			entries: JsAstImportFact[];
		};
		exports: {
			count: number;
			truncated: boolean;
			entries: JsAstExportFact[];
		};
		functions: {
			total: number;
			truncated: boolean;
			entries: JsAstFunctionFact[];
		};
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
			stringArrayCandidates: {
				count: number;
				truncated: boolean;
				entries: JsAstStringArrayCandidate[];
			};
			decoderCallCandidates: {
				count: number;
				truncated: boolean;
				entries: JsAstDecoderCallFact[];
			};
			objectDispatchCandidates: {
				count: number;
				truncated: boolean;
				entries: JsAstObjectDispatchCandidate[];
			};
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

const DEFAULT_OPTIONS: Required<JsAstAnalysisOptions> = {
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

type MutableImportFact = JsAstImportFact;
type MutableExportFact = JsAstExportFact;
type MutableFunctionFact = JsAstFunctionFact;
type MutableStringArrayCandidate = JsAstStringArrayCandidate;

type MutableSuspiciousSummary = {
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

function boundedOptions(options: JsAstAnalysisOptions = {}): Required<JsAstAnalysisOptions> {
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

function sliceWithTruncation<T>(items: T[], limit: number): { entries: T[]; truncated: boolean } {
	return { entries: items.slice(0, limit), truncated: items.length > limit };
}

function lineOf(sourceFile: ts.SourceFile, position: number): number {
	return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function lineAndColumnOf(sourceFile: ts.SourceFile, position: number): { line: number; column: number } {
	const loc = sourceFile.getLineAndCharacterOfPosition(position);
	return { line: loc.line + 1, column: loc.character + 1 };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
	return ts.canHaveModifiers(node) ? !!ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) : false;
}

function moduleKindOf(sourceFile: ts.SourceFile): "module" | "script" {
	return sourceFile.isDeclarationFile || sourceFile.statements.some((statement) => ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || hasModifier(statement, ts.SyntaxKind.ExportKeyword) || hasModifier(statement, ts.SyntaxKind.DefaultKeyword) || (ts.isExportAssignment(statement))) ? "module" : "script";
}

function textOfModuleSpecifier(node: ts.Expression | undefined): string | undefined {
	return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function identifierText(node: ts.Node | undefined): string | undefined {
	return node && ts.isIdentifier(node) ? node.text : undefined;
}

function propertyNameText(node: ts.PropertyName | ts.BindingName | undefined): string | undefined {
	if (!node) return undefined;
	if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return String(node.text);
	if (ts.isComputedPropertyName(node)) return undefined;
	return undefined;
}

function stringLiteralValue(node: ts.Expression | undefined): string | undefined {
	if (!node) return undefined;
	if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	return undefined;
}

function numericIndexValue(node: ts.Expression | undefined): number | undefined {
	if (!node) return undefined;
	if (ts.isNumericLiteral(node)) {
		const n = Number(node.text);
		return Number.isInteger(n) && n >= 0 ? n : undefined;
	}
	return undefined;
}

function isTopLevelFunctionLike(node: ts.Node): boolean {
	let current: ts.Node | undefined = node;
	while (current?.parent) {
		if (ts.isSourceFile(current.parent)) return true;
		if (ts.isBlock(current.parent) || ts.isModuleBlock(current.parent)) return false;
		current = current.parent;
	}
	return false;
}

function inferFunctionName(node: ts.Node, sourceFile: ts.SourceFile): string {
	if ((node as ts.FunctionLikeDeclarationBase & { name?: ts.Node }).name) {
		const direct = identifierText((node as ts.FunctionLikeDeclarationBase & { name?: ts.Node }).name);
		if (direct) return direct;
	}
	const parent = node.parent;
	if (ts.isVariableDeclaration(parent)) {
		const variableName = propertyNameText(parent.name);
		if (variableName) return variableName;
	}
	if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) {
		const property = propertyNameText(parent.name);
		if (property) return property;
	}
	if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
		return parent.left.getText(sourceFile).slice(0, 120);
	}
	return "<anonymous>";
}

function classifyFunctionKind(node: ts.Node): JsAstFunctionFact["kind"] {
	if (ts.isArrowFunction(node)) return "arrow";
	if (ts.isFunctionExpression(node)) return "function-expression";
	if (ts.isGetAccessorDeclaration(node)) return "getter";
	if (ts.isSetAccessorDeclaration(node)) return "setter";
	if (ts.isMethodDeclaration(node)) return ts.isClassLike(node.parent) ? "class-method" : "method";
	return "function";
}

function calleeName(node: ts.LeftHandSideExpression, sourceFile: ts.SourceFile): string | undefined {
	if (ts.isIdentifier(node)) return node.text;
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	if (ts.isElementAccessExpression(node)) return node.expression.getText(sourceFile).slice(0, 120);
	return undefined;
}

function sampleArgument(node: ts.Expression, sourceFile: ts.SourceFile): string {
	if (ts.isNumericLiteral(node)) return node.text;
	if (ts.isStringLiteralLike(node)) return JSON.stringify(node.text);
	return node.getText(sourceFile).slice(0, 80);
}

function isInfiniteWhile(node: ts.WhileStatement): boolean {
	return node.expression.kind === ts.SyntaxKind.TrueKeyword;
}

function isWritableElementAccess(node: ts.ElementAccessExpression): boolean {
	const parent = node.parent;
	if (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true;
	if (ts.isPrefixUnaryExpression(parent) && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) return true;
	if (ts.isPostfixUnaryExpression(parent) && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) return true;
	if (ts.isDeleteExpression(parent)) return true;
	return false;
}

function returnsStringArrayIndex(node: ts.FunctionLikeDeclarationBase): { arrayName: string; argName?: string } | undefined {
	if (!node.body || !ts.isBlock(node.body) || node.body.statements.length !== 1) return undefined;
	const statement = node.body.statements[0];
	if (!ts.isReturnStatement(statement) || !statement.expression || !ts.isElementAccessExpression(statement.expression)) return undefined;
	if (!ts.isIdentifier(statement.expression.expression)) return undefined;
	const argName = node.parameters[0] && ts.isIdentifier(node.parameters[0].name) ? node.parameters[0].name.text : undefined;
	return { arrayName: statement.expression.expression.text, argName };
}

function collectImportFacts(sourceFile: ts.SourceFile, options: Required<JsAstAnalysisOptions>): MutableImportFact[] {
	const facts: MutableImportFact[] = [];
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		const from = textOfModuleSpecifier(statement.moduleSpecifier) || "<unknown>";
		const clause = statement.importClause;
		if (!clause) {
			facts.push({ kind: "side-effect", from, specifierCount: 0, localNames: [] }) || [];
			continue;
		}
		const localNames: string[] = [];
		if (clause.name) localNames.push(clause.name.text);
		let kind: MutableImportFact["kind"] = clause.name ? "default" : "named";
		let specifierCount = clause.name ? 1 : 0;
		if (clause.namedBindings) {
			if (ts.isNamespaceImport(clause.namedBindings)) {
				localNames.push(clause.namedBindings.name.text);
				specifierCount += 1;
				kind = clause.name ? "default+namespace" : "namespace";
			} else {
				for (const element of clause.namedBindings.elements.slice(0, options.maxLocalNamesPerImport)) {
					localNames.push(element.name.text);
				}
				specifierCount += clause.namedBindings.elements.length;
				kind = clause.name ? "default+named" : "named";
			}
		}
		facts.push({ kind, from, specifierCount, localNames: localNames.slice(0, options.maxLocalNamesPerImport) });
	}
	return facts;
}

function collectExportFacts(sourceFile: ts.SourceFile, options: Required<JsAstAnalysisOptions>): MutableExportFact[] {
	const facts: MutableExportFact[] = [];
	for (const statement of sourceFile.statements) {
		if (ts.isExportAssignment(statement)) {
			facts.push({ kind: hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? "default" : "named", name: statement.expression.getText(sourceFile).slice(0, 120) });
			continue;
		}
		if (ts.isExportDeclaration(statement)) {
			const from = textOfModuleSpecifier(statement.moduleSpecifier);
			if (!statement.exportClause) {
				facts.push({ kind: "export-all", from });
				continue;
			}
			if (ts.isNamespaceExport(statement.exportClause)) {
				facts.push({ kind: "re-export", from, names: [statement.exportClause.name.text] });
				continue;
			}
			facts.push({ kind: from ? "re-export" : "named", from, names: statement.exportClause.elements.slice(0, options.maxExportNames).map((item) => item.name.text) });
			continue;
		}
		if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
		if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
			facts.push({ kind: hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? "default" : "declaration", name: identifierText(statement.name) || "<anonymous>" });
			continue;
		}
		if (ts.isVariableStatement(statement)) {
			facts.push({ kind: hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? "default" : "declaration", names: statement.declarationList.declarations.slice(0, options.maxExportNames).map((decl) => propertyNameText(decl.name) || "<binding>") });
		}
	}
	return facts;
}

function collectStringArrayCandidates(sourceFile: ts.SourceFile, options: Required<JsAstAnalysisOptions>): Map<string, MutableStringArrayCandidate> {
	const candidates = new Map<string, MutableStringArrayCandidate>();
	function visit(node: ts.Node): void {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
			const values = node.initializer.elements.map((element) => stringLiteralValue(ts.isExpression(element) ? element : undefined));
			if (values.length >= options.minStringArrayCandidateLength && values.every((value) => value !== undefined)) {
				candidates.set(node.name.text, {
					name: node.name.text,
					length: values.length,
					topLevel: isTopLevelFunctionLike(node),
					sample: values.slice(0, options.maxStringSampleItems) as string[],
					line: lineOf(sourceFile, node.getStart(sourceFile)),
				});
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return candidates;
}

function collectObjectDispatchCandidates(sourceFile: ts.SourceFile, options: Required<JsAstAnalysisOptions>): JsAstObjectDispatchCandidate[] {
	const candidates: JsAstObjectDispatchCandidate[] = [];
	function visit(node: ts.Node): void {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
			const keyCount = node.initializer.properties.filter((item) => ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item) || ts.isMethodDeclaration(item)).length;
			if (keyCount >= options.minObjectDispatchKeys) {
				candidates.push({ name: node.name.text, keyCount, topLevel: isTopLevelFunctionLike(node), line: lineOf(sourceFile, node.getStart(sourceFile)) });
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return candidates.sort((a, b) => a.line - b.line);
}

function collectTopLevelCounts(sourceFile: ts.SourceFile): JsAstAnalysis["summary"]["topLevel"] {
	const summary = {
		statementCount: sourceFile.statements.length,
		imports: 0,
		exports: 0,
		functions: 0,
		variables: 0,
		classes: 0,
	};
	for (const statement of sourceFile.statements) {
		if (ts.isImportDeclaration(statement)) summary.imports += 1;
		if (ts.isFunctionDeclaration(statement)) summary.functions += 1;
		if (ts.isVariableStatement(statement)) summary.variables += statement.declarationList.declarations.length;
		if (ts.isClassDeclaration(statement)) summary.classes += 1;
		if (ts.isExportAssignment(statement) || ts.isExportDeclaration(statement) || hasModifier(statement, ts.SyntaxKind.ExportKeyword)) summary.exports += 1;
	}
	return summary;
}

type ReductionPass = "stringArrayElement" | "decoderCall" | "constantExpression" | "aliasPropagation" | "objectDispatch";
type PublicReductionPass = "stringArrayElement" | "decoderCall" | "constantExpression";

type DeterministicReplacement = {
	start: number;
	end: number;
	text: string;
	from: string;
	to: string;
	pass: ReductionPass;
};

function collectCandidateStringArrayValues(sourceFile: ts.SourceFile, candidates: Map<string, MutableStringArrayCandidate>): Map<string, string[]> {
	const values = new Map<string, string[]>();
	function visit(node: ts.Node): void {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isArrayLiteralExpression(node.initializer) && candidates.has(node.name.text)) {
			values.set(node.name.text, node.initializer.elements.map((element) => stringLiteralValue(ts.isExpression(element) ? element : undefined) || ""));
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return values;
}

function collectKnownDecoderMap(sourceFile: ts.SourceFile, candidates: Map<string, MutableStringArrayCandidate>): Map<string, { arrayName: string }> {
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
	while (changed) {
		changed = false;
		function visitAliases(node: ts.Node): void {
			if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isIdentifier(node.initializer) && known.has(node.initializer.text) && !known.has(node.name.text)) {
				known.set(node.name.text, known.get(node.initializer.text)!);
				changed = true;
			}
			ts.forEachChild(node, visitAliases);
		}
		visitAliases(sourceFile);
	}
	return known;
}

function reductionLiteralText(value: string | number | boolean | null): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (value === null) return "null";
	return String(value);
}

function collectAliasMap(sourceFile: ts.SourceFile): Map<string, string> {
	const aliases = new Map<string, string>();
	function visit(node: ts.Node): void {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isIdentifier(node.initializer)) aliases.set(node.name.text, node.initializer.text);
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return aliases;
}

function collectConstBindingMap(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
	const bindings = new Map<string, ts.Expression>();
	function visit(node: ts.Node): void {
		if (ts.isVariableStatement(node) && (node.declarationList.flags & ts.NodeFlags.Const) !== 0) {
			for (const declaration of node.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name) && declaration.initializer) bindings.set(declaration.name.text, declaration.initializer);
			}
		}
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

function collectObjectDispatchImplementationMap(sourceFile: ts.SourceFile, candidates: JsAstObjectDispatchCandidate[]): Map<string, Map<string, ts.Expression>> {
	const out = new Map<string, Map<string, ts.Expression>>();
	const candidateNames = new Set(candidates.map((item) => item.name));
	function visit(node: ts.Node): void {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && candidateNames.has(node.name.text) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
			const entries = new Map<string, ts.Expression>();
			for (const property of node.initializer.properties) {
				if (!(ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property))) continue;
				const key = propertyNameText(property.name);
				const expression = ts.isPropertyAssignment(property) ? returnExpressionOf(property.initializer) : returnExpressionOf(property);
				if (key && expression) entries.set(key, expression);
			}
			out.set(node.name.text, entries);
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return out;
}

function tryDecodeCall(node: ts.CallExpression, decoderMap: Map<string, { arrayName: string }>, candidateValues: Map<string, string[]>): string | undefined {
	const callee = calleeName(node.expression, node.getSourceFile());
	if (!callee || !decoderMap.has(callee)) return undefined;
	const index = numericIndexValue(node.arguments[0]);
	const arrayName = decoderMap.get(callee)?.arrayName;
	const values = arrayName ? candidateValues.get(arrayName) : undefined;
	return values && index !== undefined && index < values.length ? values[index] : undefined;
}

function resolveAliasName(name: string, aliases: Map<string, string>): string {
	let current = name;
	const seen = new Set<string>([current]);
	while (aliases.has(current) && !seen.has(String(aliases.get(current)))) {
		current = String(aliases.get(current));
		seen.add(current);
	}
	return current;
}

function tryObjectDispatchCall(node: ts.CallExpression, objectDispatchMap: Map<string, Map<string, ts.Expression>>, decoderMap: Map<string, { arrayName: string }>, candidateValues: Map<string, string[]>, aliases: Map<string, string>, constBindings: Map<string, ts.Expression>, depth: number): string | number | boolean | null | undefined {
	const callee = node.expression;
	let objectName: string | undefined;
	let propertyName: string | undefined;
	if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
		objectName = resolveAliasName(callee.expression.text, aliases);
		propertyName = callee.name.text;
	} else if (ts.isElementAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
		objectName = resolveAliasName(callee.expression.text, aliases);
		propertyName = stringLiteralValue(callee.argumentExpression) ?? (numericIndexValue(callee.argumentExpression) !== undefined ? String(numericIndexValue(callee.argumentExpression)) : undefined);
	}
	if (!objectName || !propertyName || !objectDispatchMap.has(objectName)) return undefined;
	const expression = objectDispatchMap.get(objectName)?.get(propertyName);
	return expression ? evaluateConstantExpression(expression, decoderMap, candidateValues, aliases, constBindings, objectDispatchMap, depth + 1) : undefined;
}

function evaluateConstantExpression(node: ts.Expression, decoderMap: Map<string, { arrayName: string }>, candidateValues: Map<string, string[]>, aliases: Map<string, string>, constBindings: Map<string, ts.Expression>, objectDispatchMap: Map<string, Map<string, ts.Expression>>, depth = 0): string | number | boolean | null | undefined {
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
	if (ts.isIdentifier(node)) {
		const resolved = resolveAliasName(node.text, aliases);
		const binding = constBindings.get(resolved);
		if (binding) return evaluateConstantExpression(binding, decoderMap, candidateValues, aliases, constBindings, objectDispatchMap, depth + 1);
		if (resolved !== node.text) return evaluateConstantExpression(ts.factory.createIdentifier(resolved), decoderMap, candidateValues, aliases, constBindings, objectDispatchMap, depth + 1);
	}
	if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && !isWritableElementAccess(node)) {
		const values = candidateValues.get(resolveAliasName((node.expression as ts.Identifier).text, aliases));
		const index = numericIndexValue(node.argumentExpression);
		return values && index !== undefined && index < values.length ? values[index] : undefined;
	}
	if (ts.isCallExpression(node)) return tryObjectDispatchCall(node, objectDispatchMap, decoderMap, candidateValues, aliases, constBindings, depth) ?? tryDecodeCall(node, decoderMap, candidateValues);
	if (ts.isPrefixUnaryExpression(node)) {
		const value = evaluateConstantExpression(node.operand, decoderMap, candidateValues, aliases, constBindings, objectDispatchMap, depth + 1);
		if (value === undefined) return undefined;
		if (node.operator === ts.SyntaxKind.ExclamationToken) return !value;
		if (typeof value !== "number") return undefined;
		if (node.operator === ts.SyntaxKind.PlusToken) return +value;
		if (node.operator === ts.SyntaxKind.MinusToken) return -value;
		if (node.operator === ts.SyntaxKind.TildeToken) return ~value;
		return undefined;
	}
	if (ts.isBinaryExpression(node)) {
		const left = evaluateConstantExpression(node.left, decoderMap, candidateValues, aliases, constBindings, objectDispatchMap, depth + 1);
		const right = evaluateConstantExpression(node.right, decoderMap, candidateValues, aliases, constBindings, objectDispatchMap, depth + 1);
		if (left === undefined || right === undefined) return undefined;
		switch (node.operatorToken.kind) {
			case ts.SyntaxKind.PlusToken:
				if (typeof left === "string" || typeof right === "string") return String(left) + String(right);
				if (typeof left === "number" && typeof right === "number") return left + right;
				return undefined;
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
	return undefined;
}

function selectNonOverlappingReplacements(replacements: DeterministicReplacement[]): DeterministicReplacement[] {
	const selected: DeterministicReplacement[] = [];
	for (const candidate of replacements.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)) {
		if (selected.some((item) => candidate.start < item.end && item.start < candidate.end)) continue;
		selected.push(candidate);
	}
	return selected.sort((a, b) => a.start - b.start);
}

function applyDeterministicReduction(sourceText: string, sourceFile: ts.SourceFile, candidates: Map<string, MutableStringArrayCandidate>, options: Required<JsAstAnalysisOptions>): JsAstReductionFact {
	const candidateValues = collectCandidateStringArrayValues(sourceFile, candidates);
	const decoderMap = collectKnownDecoderMap(sourceFile, candidates);
	const aliases = collectAliasMap(sourceFile);
	const constBindings = collectConstBindingMap(sourceFile);
	const objectDispatchMap = collectObjectDispatchImplementationMap(sourceFile, collectObjectDispatchCandidates(sourceFile, options));
	const replacements: DeterministicReplacement[] = [];
	function visit(node: ts.Node): void {
		if (ts.isExpression(node)) {
			const constantValue = evaluateConstantExpression(node, decoderMap, candidateValues, aliases, constBindings, objectDispatchMap);
			if (constantValue !== undefined && !ts.isStringLiteralLike(node) && !ts.isNumericLiteral(node) && node.kind !== ts.SyntaxKind.TrueKeyword && node.kind !== ts.SyntaxKind.FalseKeyword && node.kind !== ts.SyntaxKind.NullKeyword) {
				let pass: ReductionPass = "constantExpression";
				if (ts.isIdentifier(node) && resolveAliasName(node.text, aliases) !== node.text) pass = "aliasPropagation";
				else if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && candidateValues.has(resolveAliasName((node.expression as ts.Identifier).text, aliases)) && numericIndexValue(node.argumentExpression) !== undefined) pass = "stringArrayElement";
				else if (ts.isCallExpression(node) && tryObjectDispatchCall(node, objectDispatchMap, decoderMap, candidateValues, aliases, constBindings, 0) !== undefined) pass = "objectDispatch";
				else if (ts.isCallExpression(node) && tryDecodeCall(node, decoderMap, candidateValues) !== undefined) pass = "decoderCall";
				const text = reductionLiteralText(constantValue);
				if (text !== node.getText(sourceFile)) replacements.push({ start: node.getStart(sourceFile), end: node.getEnd(), text, from: node.getText(sourceFile).slice(0, 120), to: text.slice(0, 120), pass });
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	const selected = selectNonOverlappingReplacements(replacements);
	if (!selected.length) return { applied: false, replacementCount: 0, passes: [], passCounts: {}, preview: "", truncated: false, examples: [] };
	let reduced = sourceText;
	for (const replacement of selected.sort((a, b) => b.start - a.start)) reduced = `${reduced.slice(0, replacement.start)}${replacement.text}${reduced.slice(replacement.end)}`;
	const truncated = reduced.length > options.maxReductionPreviewChars;
	const passCounts = Object.fromEntries(selected.reduce((map, item) => map.set(item.pass, (map.get(item.pass) || 0) + 1), new Map<string, number>()));
	return {
		applied: true,
		replacementCount: selected.length,
		passes: Array.from(new Set(selected.map((item) => item.pass))).filter((pass): pass is PublicReductionPass => pass === "stringArrayElement" || pass === "decoderCall" || pass === "constantExpression"),
		passCounts,
		preview: truncated ? `${reduced.slice(0, options.maxReductionPreviewChars)}…` : reduced,
		truncated,
		examples: selected.slice(0, options.maxReductionExamples).map((item) => ({ from: item.from, to: item.to, pass: item.pass })),
	};
}

export function analyzeJavaScriptSource(sourceText: string, options: JsAstAnalysisOptions = {}): JsAstAnalysis {
	const resolved = boundedOptions(options);
	const sourceFile = ts.createSourceFile(resolved.fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const parseDiagnostics: JsAstParseDiagnostic[] = (((sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics) || []).map((diag: ts.DiagnosticWithLocation) => {
		const position = lineAndColumnOf(sourceFile, diag.start || 0);
		return {
			code: Number(diag.code),
			message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
			line: position.line,
			column: position.column,
			length: Number(diag.length || 0),
		};
	});
	const imports = collectImportFacts(sourceFile, resolved);
	const exportsList = collectExportFacts(sourceFile, resolved);
	const topLevel = collectTopLevelCounts(sourceFile);
	const stringArrayCandidates = collectStringArrayCandidates(sourceFile, resolved);
	const suspicious: MutableSuspiciousSummary = {
		evalCalls: 0,
		functionConstructorCalls: 0,
		atobCalls: 0,
		unescapeCalls: 0,
		computedStringArrayAccessCount: 0,
		objectDispatchAccessCount: 0,
		whileTrueCount: 0,
		switchInLoopCount: 0,
		stringArrayCandidates: Array.from(stringArrayCandidates.values()).sort((a, b) => a.line - b.line),
		decoderCallCounts: new Map(),
		objectDispatchCandidates: collectObjectDispatchCandidates(sourceFile, resolved),
		stringDecoderAliases: new Set(),
		knownDecoderNames: new Set(),
	};
	const functions: MutableFunctionFact[] = [];
	function visit(node: ts.Node, loopDepth = 0): void {
		if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
			functions.push({
				name: inferFunctionName(node, sourceFile),
				kind: classifyFunctionKind(node),
				params: node.parameters.length,
				async: hasModifier(node, ts.SyntaxKind.AsyncKeyword),
				generator: !!(node as ts.FunctionLikeDeclarationBase).asteriskToken,
				topLevel: isTopLevelFunctionLike(node),
				line: lineOf(sourceFile, node.getStart(sourceFile)),
			});
		}
		if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
			const decoderShape = returnsStringArrayIndex(node);
			if (decoderShape && stringArrayCandidates.has(decoderShape.arrayName)) suspicious.knownDecoderNames.add(node.name.text);
		}
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isIdentifier(node.initializer) && suspicious.knownDecoderNames.has(node.initializer.text)) {
			suspicious.stringDecoderAliases.add(node.name.text);
			suspicious.knownDecoderNames.add(node.name.text);
		}
		if (ts.isCallExpression(node)) {
			const name = calleeName(node.expression, sourceFile);
			if (name === "eval") suspicious.evalCalls += 1;
			if (name === "atob") suspicious.atobCalls += 1;
			if (name === "unescape") suspicious.unescapeCalls += 1;
			if (name && (node.arguments.some((arg) => ts.isNumericLiteral(arg)) || suspicious.knownDecoderNames.has(name))) {
				const bucket = suspicious.decoderCallCounts.get(name) || { count: 0, sampleArgs: [] };
				bucket.count += 1;
				for (const arg of node.arguments) {
					if (bucket.sampleArgs.length >= resolved.maxDecoderSampleArgs) break;
					bucket.sampleArgs.push(sampleArgument(arg, sourceFile));
				}
				suspicious.decoderCallCounts.set(name, bucket);
			}
		}
		if (ts.isNewExpression(node) && calleeName(node.expression, sourceFile) === "Function") suspicious.functionConstructorCalls += 1;
		if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && stringArrayCandidates.has((node.expression as ts.Identifier).text) && numericIndexValue(node.argumentExpression) !== undefined) suspicious.computedStringArrayAccessCount += 1;
		if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && suspicious.objectDispatchCandidates.some((item) => item.name === (node.expression as ts.Identifier).text)) suspicious.objectDispatchAccessCount = (suspicious.objectDispatchAccessCount || 0) + 1;
		if (ts.isWhileStatement(node) && isInfiniteWhile(node)) suspicious.whileTrueCount += 1;
		if (ts.isSwitchStatement(node) && loopDepth > 0) suspicious.switchInLoopCount += 1;
		const nextLoopDepth = loopDepth + (ts.isWhileStatement(node) || ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isDoStatement(node) ? 1 : 0);
		ts.forEachChild(node, (child) => visit(child, nextLoopDepth));
	}
	visit(sourceFile);
	const importSlice = sliceWithTruncation(imports, resolved.maxImports);
	const exportSlice = sliceWithTruncation(exportsList, resolved.maxExports);
	const functionSlice = sliceWithTruncation(functions.sort((a, b) => a.line - b.line), resolved.maxFunctions);
	const stringArraySlice = sliceWithTruncation(suspicious.stringArrayCandidates, resolved.maxStringArrayCandidates);
	const decoderCandidates = Array.from(suspicious.decoderCallCounts.entries())
		.map(([callee, value]) => ({ callee, count: value.count, sampleArgs: value.sampleArgs.slice(0, resolved.maxDecoderSampleArgs) }))
		.sort((a, b) => b.count - a.count || a.callee.localeCompare(b.callee));
	const decoderSlice = sliceWithTruncation(decoderCandidates, resolved.maxDecoderCandidates);
	const objectDispatchSlice = sliceWithTruncation(suspicious.objectDispatchCandidates, resolved.maxObjectDispatchCandidates);
	const reduction = applyDeterministicReduction(sourceText, sourceFile, stringArrayCandidates, resolved);
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
			functions: { total: functions.length, truncated: functionSlice.truncated, entries: functionSlice.entries },
			suspicious: {
				evalCalls: suspicious.evalCalls,
				functionConstructorCalls: suspicious.functionConstructorCalls,
				atobCalls: suspicious.atobCalls,
				unescapeCalls: suspicious.unescapeCalls,
				computedStringArrayAccessCount: suspicious.computedStringArrayAccessCount,
				longStringArrayCount: suspicious.stringArrayCandidates.filter((item) => item.length >= 16).length,
				stringDecoderAliasCount: suspicious.stringDecoderAliases.size,
				objectDispatchAccessCount: suspicious.objectDispatchAccessCount || 0,
				whileTrueCount: suspicious.whileTrueCount,
				switchInLoopCount: suspicious.switchInLoopCount,
				stringArrayCandidates: { count: suspicious.stringArrayCandidates.length, truncated: stringArraySlice.truncated, entries: stringArraySlice.entries },
				decoderCallCandidates: { count: decoderCandidates.length, truncated: decoderSlice.truncated, entries: decoderSlice.entries },
				objectDispatchCandidates: { count: suspicious.objectDispatchCandidates.length, truncated: objectDispatchSlice.truncated, entries: objectDispatchSlice.entries },
			},
			reduction,
		},
	};
}
