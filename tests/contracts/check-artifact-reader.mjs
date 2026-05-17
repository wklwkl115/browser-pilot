import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArtifactReaderError, MAX_ARTIFACT_READ_BYTES, readBrowserArtifact } from "../../src/tools/artifactReader.ts";
import { saveTextArtifact } from "../../src/tools/artifacts.ts";

const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-browser-artifact-"));
try {
	await mkdir(path.join(tmp, ".pi", "browser-artifacts"), { recursive: true });
	const artifactPath = path.join(tmp, ".pi", "browser-artifacts", "network.json");
	const payload = { items: Array.from({ length: 80 }, (_, i) => ({ requestId: String(i), url: `https://h${i % 3}.test/r${i}`, method: "GET", status: i % 10 === 0 ? 500 : 200 })) };
	await writeFile(artifactPath, JSON.stringify(payload, null, 2), "utf8");
	assert.equal(existsSync(artifactPath), true);
	const atomic = await saveTextArtifact({ cwd: tmp }, ".pi/browser-artifacts/atomic.txt", "unused.txt", "atomic-ok");
	assert.equal(await readFile(atomic.path, "utf8"), "atomic-ok", "check-artifact write.atomic: content must be committed");
	assert.equal((await readdir(path.dirname(atomic.path))).some((name) => name.includes(".tmp")), false, "check-artifact write.atomic: temp files must not remain after success");

	const textArtifact = await readBrowserArtifact({ path: ".pi/browser-artifacts/network.json", mode: "text", offset: 1, limit: 3, maxChars: 1_000 }, { cwd: tmp });
	assert.equal(textArtifact.mode, "text", "check-artifact text.mode: expected text");
	assert.ok(textArtifact.nextOffset, "check-artifact text.nextOffset: text mode must expose nextOffset");
	assert.equal(textArtifact.summary.lineCount > 3, true, "check-artifact text.summary.lineCount: expected more than 3 lines");

	const jsonArtifact = await readBrowserArtifact({ path: artifactPath, mode: "json", jsonPath: "items", offset: 2, limit: 5 }, { cwd: tmp });
	assert.equal(jsonArtifact.mode, "json", "check-artifact json.mode: expected json");
	assert.equal(jsonArtifact.value.count, 80, "check-artifact json.value.count: expected full array count");
	assert.equal(jsonArtifact.value.items.length, 5, "check-artifact json.value.items.length: expected window size 5");
	assert.equal(jsonArtifact.value.nextOffset, 7, "check-artifact json.value.nextOffset: expected 7");

	const pickArtifact = await readBrowserArtifact({ path: artifactPath, mode: "json", pick: ["items[0].requestId", "items[1].status"], limit: 4 }, { cwd: tmp });
	assert.equal(pickArtifact.value["items[0].requestId"], "0");
	assert.equal(pickArtifact.value["items[1].status"], 200);

	const searchArtifact = await readBrowserArtifact({ path: artifactPath, mode: "search", query: "h1.test", maxMatches: 2 }, { cwd: tmp });
	assert.equal(searchArtifact.mode, "search");
	assert.ok(searchArtifact.matches > 0);
	assert.ok(searchArtifact.snippets[0].text.includes("h1.test"));

	const sampleArtifact = await readBrowserArtifact({ path: artifactPath, mode: "sample", limit: 2, maxChars: 2_000 }, { cwd: tmp });
	assert.equal(sampleArtifact.mode, "sample");
	assert.ok(sampleArtifact.snippets.length >= 2);

	const emptyPath = path.join(tmp, ".pi", "browser-artifacts", "empty.txt");
	await writeFile(emptyPath, "", "utf8");
	const emptyArtifact = await readBrowserArtifact({ path: ".pi/browser-artifacts/empty.txt", mode: "text" }, { cwd: tmp });
	assert.equal(emptyArtifact.summary.chars, 0);

	await assert.rejects(readBrowserArtifact({ path: artifactPath, mode: "search", query: "[", regex: true }, { cwd: tmp }), (error) => {
		assert.equal(error instanceof ArtifactReaderError, true);
		assert.equal(error.code, "ARTIFACT_SEARCH_REGEX_INVALID");
		return true;
	});
	await assert.rejects(readBrowserArtifact({ path: "network.json", mode: "text" }, { cwd: tmp }), (error) => {
		assert.equal(error instanceof ArtifactReaderError, true);
		assert.equal(error.code, "ARTIFACT_PATH_OUTSIDE_ALLOWED_ROOT");
		return true;
	});

	const hugePath = path.join(tmp, ".pi", "browser-artifacts", "huge.txt");
	await writeFile(hugePath, "", "utf8");
	await truncate(hugePath, MAX_ARTIFACT_READ_BYTES + 1);
	await assert.rejects(readBrowserArtifact({ path: hugePath, mode: "text" }, { cwd: tmp }), (error) => {
		assert.equal(error instanceof ArtifactReaderError, true);
		assert.equal(error.code, "ARTIFACT_TOO_LARGE");
		assert.equal(error.details.maxBytes, MAX_ARTIFACT_READ_BYTES);
		return true;
	});
} finally {
	await rm(tmp, { recursive: true, force: true });
}

console.log("artifact reader contract ok");
