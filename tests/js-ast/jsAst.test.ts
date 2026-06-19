import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeJavaScriptSource } from "../../src/commands/webSecurity/shared/jsAst.ts";
import { analyzeJavaScriptArtifactInput } from "../../src/commands/webSecurity/shared/jsAstArtifact.ts";

test("analyzeJavaScriptSource reports top-level facts and suspicious markers", () => {
	const source = 'import x from "a"; export const value = 1; const arr=["alpha","beta","gamma"]; function dec(i){ return arr[i]; } eval("1"); while(true){switch(x){case 1:break; default: break;}}';
	const result = analyzeJavaScriptSource(source);
	assert.equal(result.ok, true);
	assert.equal(result.sourceType, "module");
	assert.equal(result.summary.topLevel.imports, 1);
	assert.equal(result.summary.topLevel.exports, 1);
	assert.equal(result.summary.functions.total, 1);
	assert.equal(result.summary.suspicious.evalCalls, 1);
	assert.equal(result.summary.suspicious.whileTrueCount, 1);
	assert.equal(result.summary.suspicious.switchInLoopCount, 1);
	assert.equal(result.summary.suspicious.stringArrayCandidates.count, 1);
	assert.equal(result.summary.reduction.applied, true);
	assert.equal(result.summary.reduction.passCounts.constantExpression, 1);
	assert.equal(result.summary.functions.entries[0]?.name, "dec");
});

test("analyzeJavaScriptSource surfaces parse diagnostics for invalid input", () => {
	const result = analyzeJavaScriptSource("function {");
	assert.equal(result.ok, false);
	assert.ok(result.parseDiagnostics.length > 0);
	assert.ok(result.parseDiagnostics[0].line >= 1);
	assert.ok(result.parseDiagnostics[0].column >= 1);
});

test("analyzeJavaScriptArtifactInput falls back to lexical mode for large default inputs", async () => {
	const large = "fetch('/api/demo');\n".repeat(130000);
	const result = await analyzeJavaScriptArtifactInput({ text: large });
	assert.equal(result.analysisMode, "lexical");
	assert.equal(result.input.mode, "text");
	assert.ok((result.lexical?.summary.endpoints.count ?? 0) > 0);
	assert.equal(result.input.privacy.localOnly, true);
});

test("decoder calls and string-array candidates remain observable", () => {
	const source = 'const arr=["a","b","c"]; function dec(i){ return arr[i]; } const ops={go(){ return "ok"; }}; dec(1); ops.go();';
	const result = analyzeJavaScriptSource(source);
	assert.equal(result.summary.suspicious.stringArrayCandidates.count, 1);
	assert.equal(result.summary.suspicious.decoderCallCandidates.count, 1);
	assert.equal(result.summary.suspicious.decoderCallCandidates.entries[0]?.callee, "dec");
});

test("object-dispatch candidates and reduction preview remain observable", () => {
	const source = 'const ops={a(){return 1},b(){return 2},c(){return 3}}; ops["a"]();';
	const result = analyzeJavaScriptSource(source);
	assert.equal(result.summary.suspicious.objectDispatchCandidates.count, 1);
	assert.equal(result.summary.suspicious.objectDispatchAccessCount, 1);
	assert.equal(result.summary.reduction.passCounts.objectDispatch, 1);
	assert.match(result.summary.reduction.preview, /; 1;/);
});

test("decoder aliases keep alias counts and reduced previews", () => {
	const source = 'const arr=["x","y","z"]; function dec(i){ return arr[i]; } const alias = dec; alias(2);';
	const result = analyzeJavaScriptSource(source);
	assert.equal(result.summary.suspicious.stringDecoderAliasCount, 1);
	assert.equal(result.summary.suspicious.decoderCallCandidates.entries[0]?.callee, "alias");
	assert.match(result.summary.reduction.preview, /"z";/);
});

test("import and export kinds remain classified", () => {
	const source = 'import foo, * as ns from "pkg"; export * from "lib"; export { foo as bar };';
	const result = analyzeJavaScriptSource(source);
	assert.equal(result.summary.imports.entries[0]?.kind, "default+namespace");
	assert.equal(result.summary.exports.entries[0]?.kind, "export-all");
	assert.equal(result.summary.exports.entries[1]?.kind, "named");
});

test("artifact input rejects conflicting text and path sources", async () => {
	await assert.rejects(
		analyzeJavaScriptArtifactInput({ text: "x", path: "./x.js" }),
		(error: unknown) => error instanceof Error && (error as { code?: string }).code === "JS_AST_INPUT_CONFLICT",
	);
});

test("artifact input honors explicit maxBytes limits", async () => {
	await assert.rejects(
		analyzeJavaScriptArtifactInput({ text: "x".repeat(400), maxBytes: 256 }),
		(error: unknown) => error instanceof Error && (error as { code?: string }).code === "JS_AST_INPUT_TOO_LARGE",
	);
});

test("path-backed slice analysis keeps path metadata and slice bounds", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-js-ast-"));
	const filePath = path.join(dir, "demo.js");
	writeFileSync(filePath, "const token = 1;", "utf8");
	const result = await analyzeJavaScriptArtifactInput({ path: filePath, slice: { offset: 6, length: 5 } });
	assert.equal(result.input.mode, "path");
	assert.equal(result.input.fileName, "demo.js");
	assert.deepEqual(result.input.slice, { offset: 6, length: 5 });
	assert.equal(result.analysisMode, "ast");
});

test("jsAst refactor target stays within the file-size budget", () => {
	const filePath = path.join(process.cwd(), "src/commands/webSecurity/shared/jsAst.ts");
	const lines = readFileSync(filePath, "utf8").split(/\r?\n/).length;
	assert.ok(lines <= 200, `expected src/commands/webSecurity/shared/jsAst.ts to stay within 200 lines, got ${lines}`);
});
