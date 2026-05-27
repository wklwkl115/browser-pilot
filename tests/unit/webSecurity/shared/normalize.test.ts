import test from "node:test";
import assert from "node:assert/strict";
import { parseCommandArgs } from "../../../../src/tools/webSecurity/shared/normalize.ts";

test("parseCommandArgs preserves quoted segments and escapes", () => {
	assert.deepEqual(parseCommandArgs(`-m sqlmap --tamper "space value" --flag 'two words' path\\ with\\ spaces`), [
		"-m",
		"sqlmap",
		"--tamper",
		"space value",
		"--flag",
		"two words",
		"path with spaces",
	]);
});

test("parseCommandArgs rejects trailing escape and unclosed quotes", () => {
	assert.throws(() => parseCommandArgs("foo\\"), /unfinished escape sequence/i);
	assert.throws(() => parseCommandArgs(`foo "bar`), /unclosed/i);
});
