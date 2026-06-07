import test from "node:test";
import assert from "node:assert/strict";
import {
	BROWSER_TOOL_REGISTRARS,
	WEB_SECURITY_TOOL_NAMES,
	resolveBrowserToolRegistrars,
} from "../../../src/tools/toolRegistry.ts";

test("toolRegistry exposes the full always-on browser tool set", () => {
	const registrars = resolveBrowserToolRegistrars();
	assert.equal(registrars.length, 22);
	assert.deepEqual(registrars, BROWSER_TOOL_REGISTRARS);
	assert.equal(WEB_SECURITY_TOOL_NAMES.size, 7);
	assert(WEB_SECURITY_TOOL_NAMES.has("browser_http_replay"));
});

test("toolRegistry keeps registrars unique across groups", () => {
	const names = new Set(resolveBrowserToolRegistrars().map((fn) => fn.name));
	assert.equal(names.size, resolveBrowserToolRegistrars().length);
});
