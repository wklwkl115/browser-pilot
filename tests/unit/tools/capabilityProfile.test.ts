import test from "node:test";
import assert from "node:assert/strict";
import { resolveBrowserToolCapabilityProfile } from "../../../src/tools/capabilityProfile.ts";

test("capabilityProfile defaults to security when env var is absent", () => {
	const profile = resolveBrowserToolCapabilityProfile({});
	assert.equal(profile.name, "security");
	assert.equal(profile.source, "default");
	assert.equal(profile.securityToolsEnabled, true);
});

test("capabilityProfile enables core-only tool surface when env var is core", () => {
	const profile = resolveBrowserToolCapabilityProfile({ PI_BROWSER_TOOL_PROFILE: "core" });
	assert.equal(profile.name, "core");
	assert.equal(profile.source, "env");
	assert.equal(profile.securityToolsEnabled, false);
});

test("capabilityProfile normalizes legacy aliases back to security", () => {
	for (const value of ["security", "default", "full", "ctf", "unknown-value"]) {
		const profile = resolveBrowserToolCapabilityProfile({ PI_BROWSER_TOOL_PROFILE: value });
		assert.equal(profile.name, "security");
		assert.equal(profile.securityToolsEnabled, true);
	}
});
