import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeJavaScriptSource } from "../../../../src/tools/webSecurity/shared/jsAst.ts";
import { analyzeJavaScriptArtifactInput, JS_AST_MAX_INPUT_BYTES, JsAstArtifactError } from "../../../../src/tools/webSecurity/shared/jsAstArtifact.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const readFixture = (name: string) => readFileSync(path.join(root, "tests", "fixtures", "browser-workflows", name), "utf8");

test("jsAst extracts bounded module facts and suspicious usage from minified fixture", () => {
	const source = readFixture("js-ast-minified.js");
	const result = analyzeJavaScriptSource(source, { maxReductionPreviewChars: 500 });
	assert.equal(result.ok, true);
	assert.equal(result.sourceType, "module");
	assert.equal(result.summary.imports.count, 1);
	assert.equal(result.summary.exports.count >= 2, true);
	assert.equal(result.summary.functions.total >= 2, true);
	assert.equal(result.summary.suspicious.evalCalls, 1);
	assert.equal(result.summary.suspicious.functionConstructorCalls, 1);
	assert.equal(result.summary.suspicious.atobCalls, 1);
	assert.equal(result.summary.suspicious.unescapeCalls, 1);
	assert.equal(result.summary.suspicious.stringArrayCandidates.count, 1);
	assert.equal(result.summary.suspicious.computedStringArrayAccessCount, 0);
	assert.equal(result.summary.reduction.applied, false);
});

test("jsAst applies deterministic string-array reduction for literal indices", () => {
	const source = readFixture("js-ast-reduction.js");
	const result = analyzeJavaScriptSource(source, { maxReductionPreviewChars: 500 });
	assert.equal(result.summary.reduction.applied, true);
	assert.equal(result.summary.reduction.replacementCount >= 1, true);
	assert.equal(result.summary.reduction.preview.includes('"onetwo"') || (result.summary.reduction.preview.includes('"one"') && result.summary.reduction.preview.includes('"two"')), true);
});

test("jsAst returns bounded parse diagnostics for malformed JS", () => {
	const source = readFixture("js-ast-malformed.js");
	const result = analyzeJavaScriptSource(source);
	assert.equal(result.ok, false);
	assert.equal(result.parseDiagnostics.length >= 1, true);
	assert.equal(typeof result.parseDiagnostics[0]?.line, "number");
	assert.equal(typeof result.parseDiagnostics[0]?.column, "number");
	assert.equal(result.summary.imports.count, 0);
});

test("jsAst reports decoder aliases and object dispatch candidates", () => {
	const source = readFixture("js-ast-patterns.js");
	const result = analyzeJavaScriptSource(source);
	assert.equal(result.summary.suspicious.decoderCallCandidates.count >= 1, true);
	assert.equal(result.summary.suspicious.stringDecoderAliasCount >= 1, true);
	assert.equal(result.summary.suspicious.objectDispatchCandidates.count, 1);
	assert.equal(result.summary.suspicious.objectDispatchAccessCount >= 1, true);
});

test("jsAst folds deterministic constant expressions", () => {
	const source = readFixture("js-ast-constant-folding.js");
	const result = analyzeJavaScriptSource(source, { maxReductionPreviewChars: 500 });
	assert.equal(result.summary.reduction.applied, true);
	assert.equal(result.summary.reduction.passCounts.constantExpression >= 3, true);
	assert.equal(result.summary.reduction.preview.includes("9"), true);
	assert.equal(result.summary.reduction.preview.includes('"abc"') || result.summary.reduction.preview.includes("'abc'"), true);
	assert.equal(result.summary.reduction.preview.includes("true"), true);
});

test("jsAst inlines deterministic decoder calls", () => {
	const source = readFixture("js-ast-decoder-inline.js");
	const result = analyzeJavaScriptSource(source, { maxReductionPreviewChars: 500 });
	assert.equal(result.summary.reduction.applied, true);
	assert.equal(result.summary.reduction.replacementCount >= 1, true);
	assert.equal(result.summary.reduction.preview.includes('"one-two"'), true);
});

test("jsAst applies simple alias propagation for const bindings", () => {
	const source = readFixture("js-ast-alias-propagation.js");
	const result = analyzeJavaScriptSource(source, { maxReductionPreviewChars: 500 });
	assert.equal(result.summary.reduction.applied, true);
	assert.equal(result.summary.reduction.passCounts.aliasPropagation >= 1 || result.summary.reduction.passCounts.constantExpression >= 1, true);
	assert.equal(result.summary.reduction.preview.includes('"alpha"'), true);
});

test("jsAst reduces deterministic object-dispatch calls", () => {
	const source = readFixture("js-ast-object-dispatch.js");
	const result = analyzeJavaScriptSource(source, { maxReductionPreviewChars: 500 });
	assert.equal(result.summary.reduction.applied, true);
	assert.equal(result.summary.reduction.passCounts.objectDispatch >= 1 || result.summary.reduction.passCounts.constantExpression >= 1, true);
	assert.equal(result.summary.reduction.preview.includes('"done"'), true);
});

test("jsAst artifact input supports explicit local file paths", async () => {
	const fixturePath = path.join(root, "tests", "fixtures", "browser-workflows", "js-ast-minified.js");
	const result = await analyzeJavaScriptArtifactInput({ path: fixturePath });
	assert.equal(result.input.mode, "path");
	assert.equal(result.input.path, fixturePath);
	assert.equal(result.analysis.summary.imports.count, 1);
});

test("jsAst artifact input rejects oversized text when caller sets an explicit bound", async () => {
	const huge = "a".repeat(Math.min(4096, JS_AST_MAX_INPUT_BYTES + 1));
	await assert.rejects(() => analyzeJavaScriptArtifactInput({ text: huge, maxBytes: 1024 }), (error: unknown) => {
		assert.equal(error instanceof JsAstArtifactError, true);
		assert.equal((error as JsAstArtifactError).code, "JS_AST_INPUT_TOO_LARGE");
		return true;
	});
});

test("jsAst artifact input falls back to lexical inventory for large default-bounded bundles", async () => {
	const large = `${"a".repeat(JS_AST_MAX_INPUT_BYTES + 1)};fetch('/api/v1/items');el.innerHTML=x;localStorage.getItem('token');//# sourceMappingURL=app.js.map`;
	const result = await analyzeJavaScriptArtifactInput({ text: large, fileName: "large-bundle.js" });
	assert.equal(result.analysisMode, "lexical");
	assert.equal(result.lexical?.summary.endpoints.count >= 1, true);
	assert.equal(result.lexical?.summary.sinks.count >= 1, true);
	assert.equal(result.lexical?.summary.storage.count >= 1, true);
	assert.equal(result.lexical?.summary.sourceMaps.count, 1);
});

test("jsAst artifact input supports explicit slices for large files", async () => {
	const large = `${"x".repeat(2048)}export const answer = 42;${"y".repeat(2048)}`;
	const result = await analyzeJavaScriptArtifactInput({ text: large, fileName: "slice.js", slice: { offset: 2048, length: 25 } });
	assert.equal(result.analysisMode, "ast");
	assert.equal(result.input.slice?.offset, 2048);
	assert.equal(result.analysis?.summary.exports.count, 1);
});

test("jsAst bounds large summary collections", () => {
	const source = [
		"const arr=['a','b','c'];",
		...Array.from({ length: 12 }, (_, i) => `function f${i}(x){ return arr[${i % 3}] + x }`),
	].join("\n");
	const result = analyzeJavaScriptSource(source, { maxFunctions: 5, maxStringArrayCandidates: 1, maxReductionExamples: 2, maxReductionPreviewChars: 120 });
	assert.equal(result.summary.functions.total, 12);
	assert.equal(result.summary.functions.entries.length, 5);
	assert.equal(result.summary.functions.truncated, true);
	assert.equal(result.summary.suspicious.stringArrayCandidates.entries.length, 1);
	assert.equal(result.summary.reduction.examples.length <= 2, true);
	assert.equal(result.summary.reduction.preview.length <= 121, true);
});
