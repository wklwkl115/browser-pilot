import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArtifactReaderError, isSafeArtifactSearchRegexPattern, MAX_ARTIFACT_READ_BYTES, MAX_ARTIFACT_SEARCH_REGEX_CHARS, MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS, readBrowserArtifact } from "../../../src/tools/artifactReader.ts";
import { saveDataUrl, saveTextArtifact } from "../../../src/tools/artifacts.ts";

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
	const dataUrlPath = path.join(tmp, ".pi", "browser-artifacts", "data-url.bin");
	const dataUrl = await saveDataUrl("data:application/octet-stream;base64,SGk=", dataUrlPath);
	assert.equal(dataUrl.bytes, 2, "check-artifact data-url.strict: valid base64 bytes must be written");
	assert.equal(await readFile(dataUrl.path, "utf8"), "Hi", "check-artifact data-url.strict: valid base64 payload must round-trip");
	const invalidDataUrlPath = path.join(tmp, ".pi", "browser-artifacts", "invalid-data-url.bin");
	await assert.rejects(saveDataUrl("data:application/octet-stream;base64,SGk!", invalidDataUrlPath), /invalid base64 payload/, "check-artifact data-url.strict: invalid base64 must be rejected before write");
	assert.equal(existsSync(invalidDataUrlPath), false, "check-artifact data-url.strict: invalid base64 must not create an artifact file");

	const textArtifact = await readBrowserArtifact({ path: ".pi/browser-artifacts/network.json", mode: "text", offset: 1, limit: 3, maxChars: 1_000 }, { cwd: tmp });
	assert.equal(textArtifact.mode, "text", "check-artifact text.mode: expected text");
	assert.ok(textArtifact.nextOffset, "check-artifact text.nextOffset: text mode must expose nextOffset");
	assert.equal(textArtifact.summary.lineCount > 3, true, "check-artifact text.summary.lineCount: expected more than 3 lines");

	const jsonArtifact = await readBrowserArtifact({ path: artifactPath, mode: "json", jsonPath: "items", offset: 2, limit: 5 }, { cwd: tmp });
	assert.equal(jsonArtifact.mode, "json", "check-artifact json.mode: expected json");
	assert.equal(jsonArtifact.value.count, 80, "check-artifact json.value.count: expected full array count");
	assert.equal(jsonArtifact.value.items.length, 5, "check-artifact json.value.items.length: expected window size 5");
	assert.equal(jsonArtifact.value.nextOffset, 7, "check-artifact json.value.nextOffset: expected 7");

	const correlationArtifactPath = path.join(tmp, ".pi", "browser-artifacts", "correlation.json");
	await writeFile(correlationArtifactPath, JSON.stringify({
		operation: { operationId: "op-77" },
		snapshot: { snapshotId: "snap-77" },
		target: { browserSessionId: "default", source: "explicit", implicit: false, selectionVersionAtDispatch: 7, selectionVersionAtResolve: 8 },
		data: { requestId: "req-77", waitId: "wait-77", listenerId: "listener-77", sourceMode: "scan" },
	}, null, 2), "utf8");
	const correlationArtifact = await readBrowserArtifact({ path: correlationArtifactPath, mode: "json" }, { cwd: tmp });
	assert.equal(correlationArtifact.summary.correlation.operationId, "op-77", "check-artifact json.correlation.operationId: artifact summary must expose operationId navigation hints");
	assert.equal(correlationArtifact.summary.correlation.snapshotId, "snap-77", "check-artifact json.correlation.snapshotId: artifact summary must expose snapshotId navigation hints");
	assert.equal(correlationArtifact.summary.correlation.requestId, "req-77", "check-artifact json.correlation.requestId: artifact summary must expose requestId navigation hints");
	assert.equal(correlationArtifact.summary.correlation.waitId, "wait-77", "check-artifact json.correlation.waitId: artifact summary must expose waitId navigation hints");
	assert.equal(correlationArtifact.summary.correlation.listenerId, "listener-77", "check-artifact json.correlation.listenerId: artifact summary must expose listenerId navigation hints");
	assert.equal(correlationArtifact.summary.correlationPaths.operationId, "operation.operationId", "check-artifact json.correlation.path.operationId: artifact summary must expose operation jsonPath hint");
	assert.equal(correlationArtifact.summary.correlationPaths.snapshotId, "snapshot.snapshotId", "check-artifact json.correlation.path.snapshotId: artifact summary must expose snapshot jsonPath hint");
	assert.equal(correlationArtifact.summary.correlationPaths.requestId, "data.requestId", "check-artifact json.correlation.path.requestId: artifact summary must expose requestId jsonPath hint");

	const pickArtifact = await readBrowserArtifact({ path: artifactPath, mode: "json", pick: ["items[0].requestId", "items[1].status"], limit: 4 }, { cwd: tmp });
	assert.deepEqual(pickArtifact.value["items[0].requestId"], { exists: true, jsonPath: "items[0].requestId", value: "0" });
	assert.deepEqual(pickArtifact.value["items[1].status"], { exists: true, jsonPath: "items[1].status", value: 200 });
	assert.equal(pickArtifact.summary.keyCount, Object.keys(pickArtifact.value).length, "check-artifact json.pick.summary: summary keyCount must match serialized value keys");

	const missingJsonPathArtifact = await readBrowserArtifact({ path: artifactPath, mode: "json", jsonPath: "items[999].requestId" }, { cwd: tmp });
	assert.deepEqual(missingJsonPathArtifact.value, { exists: false, notFound: true, jsonPath: "items[999].requestId", value: null }, "check-artifact json.missing: missing jsonPath must return an explicit notFound value");
	assert.equal(missingJsonPathArtifact.summary.exists, false, "check-artifact json.missing: summary must expose exists=false");
	assert.equal(missingJsonPathArtifact.summary.notFound, true, "check-artifact json.missing: summary must expose notFound=true");

	const observeArtifactPath = path.join(tmp, ".pi", "browser-artifacts", "observe-scan.json");
	await writeFile(observeArtifactPath, JSON.stringify({
		data: { url: "https://example.test" },
		diff: { summary: { items: [{ kind: "changed", ref: "pi-ref://control/search", signal: "value-changed:pi-ref://control/search:value" }] } },
		envelope: { diff: { summary: { items: [{ kind: "changed", ref: "pi-ref://control/search" }] } } },
		abml: { diff: { summary: { items: [{ kind: "changed", ref: "pi-ref://control/search" }] } } },
	}, null, 2), "utf8");
	const observeDiffPath = await readBrowserArtifact({ path: observeArtifactPath, mode: "json", jsonPath: "diff.summary.items[0].ref" }, { cwd: tmp });
	assert.equal(observeDiffPath.value, "pi-ref://control/search", "check-artifact observe.jsonPath: saved observe artifact exposes live-envelope diff at top-level");
	const observeEnvelopePath = await readBrowserArtifact({ path: observeArtifactPath, mode: "json", jsonPath: "envelope.diff.summary.items[0].kind" }, { cwd: tmp });
	assert.equal(observeEnvelopePath.value, "changed", "check-artifact observe.envelope: saved observe artifact keeps an envelope-compatible mirror");

	const mixedPickArtifact = await readBrowserArtifact({ path: artifactPath, mode: "json", pick: ["items[0].requestId", "items[999].requestId"], limit: 4 }, { cwd: tmp });
	assert.deepEqual(mixedPickArtifact.value["items[0].requestId"], { exists: true, jsonPath: "items[0].requestId", value: "0" }, "check-artifact json.pick.mixed: existing path must stay aligned with requested key");
	assert.deepEqual(mixedPickArtifact.value["items[999].requestId"], { exists: false, notFound: true, jsonPath: "items[999].requestId", value: null }, "check-artifact json.pick.mixed: missing path must not disappear during JSON serialization");
	assert.equal(mixedPickArtifact.summary.keyCount, Object.keys(mixedPickArtifact.value).length, "check-artifact json.pick.mixed: summary keyCount must match value key count");
	assert.equal(JSON.parse(JSON.stringify(mixedPickArtifact.value))["items[999].requestId"].notFound, true, "check-artifact json.pick.mixed: missing placeholder must survive JSON serialization");

	const searchArtifact = await readBrowserArtifact({ path: artifactPath, mode: "search", query: "h1.test", maxMatches: 2 }, { cwd: tmp });
	assert.equal(searchArtifact.mode, "search");
	assert.ok(searchArtifact.matches > 0);
	assert.ok(searchArtifact.snippets[0].text.includes("h1.test"));

	const sensitivePath = path.join(tmp, ".pi", "browser-artifacts", "sensitive-evidence.json");
	const sensitivePayload = {
		request: {
			url: "https://api.example.test/ws?token=query-secret",
			headers: { Cookie: "sid=cookie-secret", Authorization: "Bearer auth-secret" },
			postData: { text: "password=post-secret" },
		},
		response: { headers: { "Set-Cookie": "sid=response-secret" }, body: { text: "token=body-secret", bytes: 17, sha256: "body-hash" } },
		websocket: { payloadData: "ws-secret", opcode: 1 },
	};
	await writeFile(sensitivePath, JSON.stringify(sensitivePayload, null, 2), "utf8");
	const sensitiveJson = await readBrowserArtifact({ path: sensitivePath, mode: "json" }, { cwd: tmp });
	const sensitiveJsonText = JSON.stringify(sensitiveJson);
	for (const secret of ["query-secret", "cookie-secret", "auth-secret", "post-secret", "response-secret", "body-secret", "ws-secret"]) {
		assert.equal(sensitiveJsonText.includes(secret), false, `check-artifact privacy.json: ${secret} must be redacted by default`);
	}
	assert.ok(sensitiveJsonText.includes("[redacted]") && sensitiveJsonText.includes("[redacted body]") && sensitiveJsonText.includes("[redacted postData]"), "check-artifact privacy.json: redaction markers must remain visible");
	assert.equal(sensitiveJson.summary.privacy.classification, "local_raw_evidence", "check-artifact privacy.summary: artifacts must expose local raw evidence classification");
	assert.equal(sensitiveJson.summary.privacy.localOnly, true, "check-artifact privacy.summary: artifacts must remain local-only");
	assert.ok(String(sensitiveJson.summary.privacy.cleanup).includes(".pi/browser-artifacts"), "check-artifact privacy.summary: cleanup hint must name artifact root");
	const sensitiveRaw = await readBrowserArtifact({ path: sensitivePath, mode: "json", redact: false }, { cwd: tmp });
	assert.ok(JSON.stringify(sensitiveRaw).includes("cookie-secret"), "check-artifact privacy.raw: redact:false must allow explicit local raw evidence reads");
	assert.equal(sensitiveRaw.summary.privacy.redaction, "disabled", "check-artifact privacy.raw: summary must record explicit redaction disable");
	const sensitiveText = await readBrowserArtifact({ path: sensitivePath, mode: "text", maxChars: 4_000 }, { cwd: tmp });
	assert.equal(JSON.stringify(sensitiveText).includes("auth-secret"), false, "check-artifact privacy.text: text snippets must redact Authorization values by default");
	const sensitiveSearch = await readBrowserArtifact({ path: sensitivePath, mode: "search", query: "cookie-secret", contextLines: 0, maxChars: 2_000 }, { cwd: tmp });
	assert.equal(JSON.stringify(sensitiveSearch).includes("cookie-secret"), false, "check-artifact privacy.search: search snippets and query must be redacted by default");
	const sensitiveSample = await readBrowserArtifact({ path: sensitivePath, mode: "sample", maxChars: 4_000 }, { cwd: tmp });
	assert.equal(JSON.stringify(sensitiveSample).includes("ws-secret"), false, "check-artifact privacy.sample: sampled websocket payloads must be redacted by default");

	assert.equal(isSafeArtifactSearchRegexPattern("h[12]\\.test"), true, "check-artifact search.regex.safe: simple regex must remain allowed");
	assert.equal(isSafeArtifactSearchRegexPattern("(a+)+$"), false, "check-artifact search.regex.safe: nested-quantifier regex must be rejected before compile");
	const regexSearchArtifact = await readBrowserArtifact({ path: artifactPath, mode: "search", query: "h[12]\\.test", regex: true, maxMatches: 2 }, { cwd: tmp });
	assert.equal(regexSearchArtifact.mode, "search");
	assert.equal(regexSearchArtifact.regex, true);
	assert.ok(regexSearchArtifact.matches > 0, "check-artifact search.regex.safe: safe regex should match");
	assert.equal(regexSearchArtifact.summary.search.regexMaxPatternChars, MAX_ARTIFACT_SEARCH_REGEX_CHARS);
	assert.equal(regexSearchArtifact.summary.search.regexMaxLineChars, MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS);

	const sampleArtifact = await readBrowserArtifact({ path: artifactPath, mode: "sample", limit: 2, maxChars: 2_000 }, { cwd: tmp });
	assert.equal(sampleArtifact.mode, "sample");
	assert.ok(sampleArtifact.snippets.length >= 2);
	for (let i = 1; i < sampleArtifact.snippets.length; i += 1) {
		assert.ok(sampleArtifact.snippets[i].lineStart > sampleArtifact.snippets[i - 1].lineEnd, "check-artifact sample.dedupe: sample snippets must not overlap");
	}

	const smallSamplePath = path.join(tmp, ".pi", "browser-artifacts", "small-sample.txt");
	await writeFile(smallSamplePath, "one\ntwo\nthree\n", "utf8");
	const smallSampleArtifact = await readBrowserArtifact({ path: smallSamplePath, mode: "sample", limit: 20, maxChars: 2_000 }, { cwd: tmp });
	assert.equal(smallSampleArtifact.snippets.length, 1, "check-artifact sample.small: small files must not repeat identical head/middle/tail snippets");
	assert.equal(smallSampleArtifact.snippets[0].lineStart, 1);
	assert.equal(smallSampleArtifact.snippets[0].lineEnd, 3);
	assert.equal(smallSampleArtifact.summary.sample.dedupedSections, 2, "check-artifact sample.small: summary must expose deduped sections");

	const emptyPath = path.join(tmp, ".pi", "browser-artifacts", "empty.txt");
	await writeFile(emptyPath, "", "utf8");
	const emptyArtifact = await readBrowserArtifact({ path: ".pi/browser-artifacts/empty.txt", mode: "text" }, { cwd: tmp });
	assert.equal(emptyArtifact.summary.chars, 0);
	assert.deepEqual(emptyArtifact.snippets, [], "check-artifact text.empty: empty files must not return invalid line ranges");
	const emptySample = await readBrowserArtifact({ path: ".pi/browser-artifacts/empty.txt", mode: "sample" }, { cwd: tmp });
	assert.deepEqual(emptySample.snippets, [], "check-artifact sample.empty: empty files must not return invalid line ranges");

	const multibytePath = path.join(tmp, ".pi", "browser-artifacts", "multibyte.txt");
	await writeFile(multibytePath, "你好世界\n第二行\n", "utf8");
	const multibyteArtifact = await readBrowserArtifact({ path: multibytePath, mode: "text" }, { cwd: tmp });
	assert.equal(multibyteArtifact.summary.bytes, 23, "check-artifact text.multibyte: fixture byte size must expose UTF-8 byte length");
	assert.equal(multibyteArtifact.summary.chars, 9, "check-artifact text.multibyte: chars must count decoded characters, not bytes");
	const multibyteSearch = await readBrowserArtifact({ path: multibytePath, mode: "search", query: "第" }, { cwd: tmp });
	assert.equal(multibyteSearch.nextOffset, null, "check-artifact search.eof: nextOffset must be null when the last match reaches EOF");

	const longLineContractPath = path.join(tmp, ".pi", "browser-artifacts", "long-line-contract.txt");
	await writeFile(longLineContractPath, `${"A".repeat(200)} NEEDLE\nsecond\n`, "utf8");
	const longLineText = await readBrowserArtifact({ path: longLineContractPath, mode: "text", offset: 1, limit: 1, maxChars: 50 }, { cwd: tmp });
	assert.notEqual(longLineText.snippets[0].text, "", "check-artifact text.long-line: truncated long lines must still return a visible prefix");
	const longLineMatch = await readBrowserArtifact({ path: longLineContractPath, mode: "search", query: "NEEDLE", contextLines: 0, contextChars: 40, maxChars: 80 }, { cwd: tmp });
	assert.notEqual(longLineMatch.snippets[0].text, "", "check-artifact search.long-line: truncated matches must still return a visible prefix");
	assert.ok(longLineMatch.snippets[0].text.includes("NEEDLE"), "check-artifact search.long-line.window: search snippets must keep the match visible inside long-line windows");
	assert.equal(typeof longLineMatch.snippets[0].matchColumnStart, "number", "check-artifact search.long-line.columns: search snippets must expose match columns");
	assert.equal(longLineMatch.snippets[0].truncatedBefore, true, "check-artifact search.long-line.truncatedBefore: long-line match windows must expose left truncation");
	const longLineColumn = await readBrowserArtifact({ path: longLineContractPath, mode: "text", offset: 1, limit: 1, columnOffset: 200, columnLimit: 20, maxChars: 80 }, { cwd: tmp });
	assert.ok(longLineColumn.snippets[0].text.includes("NEEDLE"), "check-artifact text.column-window: text mode must support character windows inside long lines");
	assert.equal(longLineColumn.snippets[0].columnStart, 200, "check-artifact text.column-window.columns: text mode must expose columnStart");

	await assert.rejects(readBrowserArtifact({ path: artifactPath, mode: "search", query: "[", regex: true }, { cwd: tmp }), (error) => {
		assert.equal(error instanceof ArtifactReaderError, true);
		assert.equal(error.code, "ARTIFACT_SEARCH_REGEX_INVALID");
		return true;
	});
	await assert.rejects(readBrowserArtifact({ path: artifactPath, mode: "search", query: "(a+)+$", regex: true }, { cwd: tmp }), (error) => {
		assert.equal(error instanceof ArtifactReaderError, true);
		assert.equal(error.code, "ARTIFACT_SEARCH_REGEX_UNSAFE");
		assert.equal(error.details.reason, "nested_quantifier");
		return true;
	});
	await assert.rejects(readBrowserArtifact({ path: artifactPath, mode: "search", query: "a".repeat(MAX_ARTIFACT_SEARCH_REGEX_CHARS + 1), regex: true }, { cwd: tmp }), (error) => {
		assert.equal(error instanceof ArtifactReaderError, true);
		assert.equal(error.code, "ARTIFACT_SEARCH_REGEX_UNSAFE");
		assert.equal(error.details.reason, "pattern_too_long");
		return true;
	});

	const singleLineSamplePath = path.join(tmp, ".pi", "browser-artifacts", "single-line-sample.js");
	await writeFile(singleLineSamplePath, `${"h".repeat(120)}MIDDLE${"t".repeat(120)}`, "utf8");
	const singleLineSample = await readBrowserArtifact({ path: singleLineSamplePath, mode: "sample", contextChars: 40, maxChars: 200 }, { cwd: tmp });
	assert.equal(singleLineSample.summary.sample.singleLineWindows, true, "check-artifact sample.single-line: single-line samples must use character windows");
	assert.equal(singleLineSample.snippets.length >= 2, true, "check-artifact sample.single-line.windows: single-line samples must include multiple windows when budget allows");
	assert.ok(singleLineSample.snippets.some((snippet) => snippet.text.includes("MIDDLE")), "check-artifact sample.single-line.middle: middle window must preserve mid-file evidence");

	const longLinePath = path.join(tmp, ".pi", "browser-artifacts", "long-line.txt");
	await writeFile(longLinePath, `${"a".repeat(MAX_ARTIFACT_SEARCH_REGEX_LINE_CHARS + 10)}\nneedle\n`, "utf8");
	const longLineSearch = await readBrowserArtifact({ path: longLinePath, mode: "search", query: "needle", regex: true }, { cwd: tmp });
	assert.equal(longLineSearch.summary.search.regexTruncatedLines, 1, "check-artifact search.regex.line-budget: regex search must record long-line truncation");
	assert.equal(longLineSearch.matches, 1, "check-artifact search.regex.line-budget: regex search must continue after long truncated lines");
	await assert.rejects(readBrowserArtifact({ path: "network.json", mode: "text" }, { cwd: tmp }), (error) => {
		assert.equal(error instanceof ArtifactReaderError, true);
		assert.equal(error.code, "ARTIFACT_PATH_OUTSIDE_ALLOWED_ROOT");
		return true;
	});

	const hugePath = path.join(tmp, ".pi", "browser-artifacts", "huge.txt");
	await writeFile(hugePath, "", "utf8");
	await truncate(hugePath, MAX_ARTIFACT_READ_BYTES + 1);
	await assert.rejects(readBrowserArtifact({ path: hugePath, mode: "json" }, { cwd: tmp }), (error) => {
		assert.equal(error instanceof ArtifactReaderError, true);
		assert.equal(error.code, "ARTIFACT_TOO_LARGE");
		assert.equal(error.details.maxBytes, MAX_ARTIFACT_READ_BYTES);
		return true;
	});
} finally {
	await rm(tmp, { recursive: true, force: true });
}

console.log("artifact reader contract ok");
