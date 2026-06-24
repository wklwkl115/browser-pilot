import ts from "typescript";
import type { JsAstAnalysis, JsAstAnalysisOptions, JsAstObjectDispatchCandidate, MutableExportFact, MutableImportFact, MutableStringArrayCandidate } from "../../../kernels/security/jsAstTypes.js";
import { identifierText, isTopLevelFunctionLike, lineOf, propertyNameText, textOfModuleSpecifier } from "./jsAstUtils.js";

export function collectImportFacts(sourceFile: ts.SourceFile, options: Required<JsAstAnalysisOptions>): MutableImportFact[] {
	const imports: MutableImportFact[] = [];
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement)) continue;
		const from = textOfModuleSpecifier(statement.moduleSpecifier) || "<dynamic>";
		if (!statement.importClause) { imports.push({ kind: "side-effect", from, specifierCount: 0, localNames: [] }); continue; }
		const localNames = [identifierText(statement.importClause.name), ...(statement.importClause.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) ? statement.importClause.namedBindings.elements.map((element) => identifierText(element.name)) : []), ...(statement.importClause.namedBindings && ts.isNamespaceImport(statement.importClause.namedBindings) ? [identifierText(statement.importClause.namedBindings.name)] : [])].filter((value): value is string => !!value).slice(0, options.maxLocalNamesPerImport);
		const hasDefault = !!statement.importClause.name;
		const hasNamed = !!statement.importClause.namedBindings && ts.isNamedImports(statement.importClause.namedBindings);
		const hasNamespace = !!statement.importClause.namedBindings && ts.isNamespaceImport(statement.importClause.namedBindings);
		imports.push({ kind: hasDefault && hasNamed ? "default+named" : hasDefault && hasNamespace ? "default+namespace" : hasNamespace ? "namespace" : hasNamed ? "named" : "default", from, specifierCount: localNames.length, localNames });
	}
	return imports;
}

export function collectExportFacts(sourceFile: ts.SourceFile, options: Required<JsAstAnalysisOptions>): MutableExportFact[] {
	const exportsList: MutableExportFact[] = [];
	for (const statement of sourceFile.statements) {
		if (ts.isExportAssignment(statement)) { exportsList.push({ kind: "default" }); continue; }
		if (ts.isExportDeclaration(statement)) {
			const from = textOfModuleSpecifier(statement.moduleSpecifier);
			if (!statement.exportClause) { exportsList.push({ kind: "export-all", ...(from ? { from } : {}) }); continue; }
			if (ts.isNamedExports(statement.exportClause)) {
				const names = statement.exportClause.elements.map((element) => element.name.text).slice(0, options.maxExportNames);
				exportsList.push({ kind: from ? "re-export" : "named", ...(from ? { from } : {}), names });
			}
			continue;
		}
		if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
		if (ts.isVariableStatement(statement)) exportsList.push({ kind: "declaration", names: statement.declarationList.declarations.map((decl) => propertyNameText(decl.name)).filter((name): name is string => !!name).slice(0, options.maxExportNames) });
		else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) exportsList.push({ kind: "declaration", name: statement.name?.text });
	}
	return exportsList;
}

export function collectStringArrayCandidates(sourceFile: ts.SourceFile, options: Required<JsAstAnalysisOptions>): Map<string, MutableStringArrayCandidate> {
	const out = new Map<string, MutableStringArrayCandidate>();
	function visit(node: ts.Node): void {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
			const values = node.initializer.elements.map((element) => ts.isStringLiteralLike(element) || ts.isNoSubstitutionTemplateLiteral(element) ? element.text : undefined);
			if (values.every((value) => typeof value === "string") && values.length >= options.minStringArrayCandidateLength) out.set(node.name.text, { name: node.name.text, length: values.length, topLevel: isTopLevelFunctionLike(node.parent?.parent ?? node), sample: values.slice(0, options.maxStringSampleItems) as string[], line: lineOf(sourceFile, node.getStart(sourceFile)) });
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return out;
}

export function collectObjectDispatchCandidates(sourceFile: ts.SourceFile, options: Required<JsAstAnalysisOptions>): JsAstObjectDispatchCandidate[] {
	const candidates: JsAstObjectDispatchCandidate[] = [];
	function visit(node: ts.Node): void {
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
			const keyCount = node.initializer.properties.filter((item) => ts.isPropertyAssignment(item) || ts.isMethodDeclaration(item)).length;
			if (keyCount >= options.minObjectDispatchKeys) candidates.push({ name: node.name.text, keyCount, topLevel: isTopLevelFunctionLike(node.parent?.parent ?? node), line: lineOf(sourceFile, node.getStart(sourceFile)) });
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return candidates.sort((a, b) => a.line - b.line);
}

export function collectTopLevelCounts(sourceFile: ts.SourceFile): JsAstAnalysis["summary"]["topLevel"] {
	return sourceFile.statements.reduce((counts, statement) => {
		counts.statementCount += 1;
		if (ts.isImportDeclaration(statement)) counts.imports += 1;
		if (ts.isExportAssignment(statement) || ts.isExportDeclaration(statement) || ts.canHaveModifiers(statement) && !!ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) counts.exports += 1;
		if (ts.isFunctionDeclaration(statement)) counts.functions += 1;
		if (ts.isVariableStatement(statement)) counts.variables += statement.declarationList.declarations.length;
		if (ts.isClassDeclaration(statement)) counts.classes += 1;
		return counts;
	}, { statementCount: 0, imports: 0, exports: 0, functions: 0, variables: 0, classes: 0 });
}
