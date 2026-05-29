import test from "node:test";
import assert from "node:assert/strict";
import { resolveBrowserToolCapabilityProfile } from "../../../src/tools/capabilityProfile.ts";

test("capabilityProfile defaults to core when env var is absent", () => {
	const profile = resolveBrowserToolCapabilityProfile({});
	assert.equal(profile.name, "core");
	assert.equal(profile.source, "default");
	assert.equal(profile.securityToolsEnabled, false);
});

test("capabilityProfile enables core-only tool surface when env var is core", () => {
	const profile = resolveBrowserToolCapabilityProfile({ PI_BROWSER_TOOL_PROFILE: "core" });
	assert.equal(profile.name, "core");
	assert.equal(profile.source, "env");
	assert.equal(profile.securityToolsEnabled, false);
});

test("capabilityProfile enables security only for recognized security aliases", () => {
	for (const value of ["security", "default", "full", "ctf"]) {
		const profile = resolveBrowserToolCapabilityProfile({ PI_BROWSER_TOOL_PROFILE: value });
		assert.equal(profile.name, "security");
		assert.equal(profile.securityToolsEnabled, true);
	}
});

test("capabilityProfile falls back unknown values to core with warning", () => {
	const profile = resolveBrowserToolCapabilityProfile({ PI_BROWSER_TOOL_PROFILE: "unknown-value" });
	assert.equal(profile.name, "core");
	assert.equal(profile.securityToolsEnabled, false);
	assert.equal(Array.isArray(profile.warnings), true);
});
