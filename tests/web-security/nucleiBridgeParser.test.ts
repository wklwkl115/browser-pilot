import assert from "node:assert/strict";
import test from "node:test";
import { parseNucleiOutput } from "../../src/commands/webSecurity/bridges/nucleiBridge.ts";

test("nuclei JSONL parser normalizes aliases, scalar metadata, arrays, and sensitive previews", () => {
	const parsed = parseNucleiOutput([
		"",
		"null",
		"[]",
		JSON.stringify({
			"template-id": "   ", templateId: " fallback-id ",
			"template-path": null, templatePath: " /tmp/template.yaml ",
			"template-name": " Fallback name ",
			info: { name: " ", tags: ["one,two", " three "], authors: [], author: "alice,bob" },
			severity: " HIGH ", type: " http ", host: 7,
			"matched-at": null, matchedAt: " https://example.test/debug ", ip: " 127.0.0.1 ",
			"matcher-name": " status ", "extractor-name": " regex ",
			"extracted-results": [], extractedResults: ["a,b", " c "], timestamp: false,
			"curl-command": "curl -H 'Authorization: Bearer secret' https://example.test/debug",
			request: "GET /debug HTTP/1.1\nCookie: sid=secret",
			response: "HTTP/1.1 200 OK\nSet-Cookie: sid=secret",
		}),
	].join("\n"));

	assert.equal(parsed.parseErrorCount, 0);
	assert.equal(parsed.matches.length, 1);
	const { curlPreview, requestPreview, responsePreview, ...match } = parsed.matches[0];
	assert.deepEqual(match, {
		templateId: "fallback-id", templatePath: "/tmp/template.yaml", templateName: "Fallback name", severity: "high",
		tags: ["one,two", "three"], authors: ["alice", "bob"], type: "http", host: "7",
		matchedAt: "https://example.test/debug", ip: "127.0.0.1", matcherName: "status", extractorName: "regex",
		extractedResults: ["a,b", "c"], timestamp: "false",
	});
	for (const preview of [curlPreview, requestPreview, responsePreview]) assert.match(String(preview), /\[redacted\]/);
});

test("nuclei JSONL parser counts only malformed object-like lines", () => {
	const parsed = parseNucleiOutput(["{bad", "[bad", "plain-not-json", '"scalar"', "42", "[]", "{}"].join("\n"));
	assert.equal(parsed.parseErrorCount, 2);
	assert.equal(parsed.matches.length, 1);
	assert.deepEqual(parsed.matches[0].tags, []);
	assert.deepEqual(parsed.matches[0].authors, []);
	assert.deepEqual(parsed.matches[0].extractedResults, []);
});
