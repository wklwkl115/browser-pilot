import test from "node:test";
import assert from "node:assert/strict";
import { inferFuzzParamLocations, normalizeReplayOptions, parseFuzzParamValue } from "../../../../src/tools/webSecurity/shared/replay.ts";

test("webSecurity/shared/replay normalizes replay options with cookie binding defaults", () => {
	const normalized = normalizeReplayOptions({ bindBrowserSession: true, cookieMode: "replace", compareBaseline: true, variableScope: "step" });
	assert.equal(normalized.bindBrowserSession, true);
	assert.equal(normalized.cookieMode, "replace");
	assert.equal(normalized.compareBaseline, true);
	assert.equal(normalized.variableScope, "step");
});

test("webSecurity/shared/replay infers query and json fuzz locations", () => {
	const locations = inferFuzzParamLocations({
		url: "https://example.test/path?id=1",
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ role: "user" }),
	}, undefined);
	assert.ok(locations.includes("query"));
	assert.ok(locations.includes("json"));
});

test("webSecurity/shared/replay parses structured fuzz values", () => {
	assert.equal(parseFuzzParamValue("true"), true);
	assert.equal(parseFuzzParamValue("123"), 123);
	assert.deepEqual(parseFuzzParamValue('{"a":1}'), { a: 1 });
	assert.equal(parseFuzzParamValue("plain-text"), "plain-text");
});
