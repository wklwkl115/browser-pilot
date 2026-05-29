import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runJsAstShell } from "../../../../src/tools/webSecurity/shared/jsAstShell.ts";

test("jsAst shell saves large reduction payloads to artifact when threshold is exceeded", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-jsast-shell-"));
	try {
		const result = await runJsAstShell({
			text: "const arr=['zero','one','two'];\nfunction pick(){ return arr[1] + arr[2]; }",
			artifactThreshold: 20,
		}, { cwd });
		assert.equal(result.summary.reductionSavedToArtifact, true);
		assert.equal(typeof result.saved?.path, "string");
		const savedText = await readFile(String(result.saved?.path), "utf8");
		assert.match(savedText, /reduction/);
		assert.match(savedText, /arr\[1\]/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
