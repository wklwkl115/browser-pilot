import test from "node:test";
import assert from "node:assert/strict";
import {
	CORE_BROWSER_TOOL_REGISTRARS,
	WEB_SECURITY_TOOL_REGISTRARS,
	resolveBrowserToolRegistrars,
} from "../../../src/tools/toolRegistry.ts";

test("toolRegistry exposes stable core and web-security registrar counts", () => {
	assert.equal(CORE_BROWSER_TOOL_REGISTRARS.length, 14);
	assert.equal(WEB_SECURITY_TOOL_REGISTRARS.length, 7);
});

test("toolRegistry omits security registrars when securityToolsEnabled is false", () => {
	const registrars = resolveBrowserToolRegistrars({ securityToolsEnabled: false });
	assert.deepEqual(registrars, CORE_BROWSER_TOOL_REGISTRARS);
});

test("toolRegistry appends security registrars by default", () => {
	const registrars = resolveBrowserToolRegistrars();
	assert.equal(registrars.length, CORE_BROWSER_TOOL_REGISTRARS.length + WEB_SECURITY_TOOL_REGISTRARS.length);
	assert.deepEqual(registrars.slice(0, CORE_BROWSER_TOOL_REGISTRARS.length), CORE_BROWSER_TOOL_REGISTRARS);
	assert.deepEqual(registrars.slice(CORE_BROWSER_TOOL_REGISTRARS.length), WEB_SECURITY_TOOL_REGISTRARS);
});

test("toolRegistry keeps registrars unique across groups", () => {
	const names = new Set(resolveBrowserToolRegistrars().map((fn) => fn.name));
	assert.equal(names.size, resolveBrowserToolRegistrars().length);
});
