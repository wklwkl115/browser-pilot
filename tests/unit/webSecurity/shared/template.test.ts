import test from "node:test";
import assert from "node:assert/strict";
import {
	applyTemplateVars,
	evaluateTemplateMatcher,
	jsonPathParts,
	normalizeDslExtractors,
	normalizeDslMatchers,
	templateTargetsForBase,
	templateVariablesFor,
} from "../../../../src/tools/webSecurity/shared/template.ts";

test("templateVariablesFor exposes base URL variables", () => {
	const vars = templateVariablesFor("https://example.test/path?q=1", { env: "prod" });
	assert.equal(vars.baseUrl, "https://example.test");
	assert.equal(vars.host, "example.test");
	assert.equal(vars.env, "prod");
});

test("applyTemplateVars replaces template placeholders", () => {
	assert.equal(applyTemplateVars("{{baseUrl}}/api/{{name}}", { baseUrl: "https://example.test", name: "items" }), "https://example.test/api/items");
});

test("normalizeDslMatchers and extractors normalize supported shapes", () => {
	assert.deepEqual(normalizeDslMatchers([{ type: "word", words: ["ok"] }])[0]?.words, ["ok"]);
	assert.equal(normalizeDslExtractors([{ type: "header", header: "set-cookie" }])[0]?.header, "set-cookie");
});

test("jsonPathParts parses dot and bracket notation", () => {
	assert.deepEqual(jsonPathParts("$.items[0].name"), ["$", "items", 0, "name"]);
});

test("templateTargetsForBase expands relative paths", () => {
	const targets = templateTargetsForBase("https://example.test/root/", { id: "t1", paths: ["/a", "b"] }, undefined);
	assert.deepEqual(targets, ["https://example.test/a", "https://example.test/root/b"]);
});

test("evaluateTemplateMatcher reports matching status and body includes", () => {
	const result = evaluateTemplateMatcher({ id: "t1", matchStatus: [200], bodyIncludes: ["Hello"] }, {
		url: "https://example.test/",
		status: 200,
		statusText: "OK",
		headers: { "content-type": "text/html" },
		setCookie: [],
		elapsedMs: 10,
		ok: true,
		bodyText: "Hello world",
		bodyBytes: 11,
		bodyTruncated: false,
	});
	assert.equal(result.matched, true);
	assert.equal(result.checks.every((item) => item.matched === true), true);
});
