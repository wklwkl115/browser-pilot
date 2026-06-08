import test from "node:test";
import assert from "node:assert/strict";
import { getJsonPath, parseJsonPath } from "../../../src/utils/jsonPath.ts";

test("parseJsonPath supports dot, array, and quoted bracket object keys", () => {
	assert.deepEqual(parseJsonPath("$.items[0].name"), ["items", 0, "name"]);
	assert.deepEqual(parseJsonPath("response.headers['Set-Cookie']"), ["response", "headers", "Set-Cookie"]);
	assert.deepEqual(parseJsonPath('response.headers["x.api.key"]'), ["response", "headers", "x.api.key"]);
});

test("getJsonPath resolves complex keys consistently for readers and freshness checks", () => {
	const value = { response: { headers: { "Set-Cookie": "sid=abc", "x.api.key": "key-1" } } };
	assert.deepEqual(getJsonPath(value, "$.response.headers['Set-Cookie']"), { exists: true, value: "sid=abc" });
	assert.deepEqual(getJsonPath(value, 'response.headers["x.api.key"]'), { exists: true, value: "key-1" });
	assert.equal(getJsonPath(value, "response.headers.Cookie").exists, false);
});

test("getJsonPath rejects malformed bracket paths instead of returning a broader prefix", () => {
	const value = { response: { headers: { Cookie: "sid=secret", Authorization: "Bearer secret" } } };
	assert.deepEqual(getJsonPath(value, "response.headers['Cookie'"), { exists: false, value: undefined });
	assert.deepEqual(getJsonPath(value, 'response.headers["Authorization]'), { exists: false, value: undefined });
});
