import test from "node:test";
import assert from "node:assert/strict";
import { analyzeJavaScriptArtifactInput } from "../../../src/tools/webSecurity/shared/jsAstArtifact.ts";
import { summarizeJsAstAnalysisData } from "../../../src/tools/summaries/webSecurity/jsAst.ts";

test("jsAst summary adapter emits compact artifact-first summary", async () => {
	const analyzed = await analyzeJavaScriptArtifactInput({
		text: "const table=['x','y']; function dec(i){ return table[i] } const alias=dec; export default alias(1)",
		fileName: "inline.js",
	});
	const summary = summarizeJsAstAnalysisData(analyzed);
	assert.equal(summary.input && typeof summary.input === "object", true);
	assert.equal(summary.sourceType, "module");
	assert.equal(summary.parseDiagnosticsCount, 0);
	assert.equal(summary.functions && typeof summary.functions === "object", true);
	assert.equal(summary.suspicious && typeof summary.suspicious === "object", true);
	assert.equal(Array.isArray(summary.nextActions), true);
});
