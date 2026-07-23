import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("extension manifest preserves page security and native dialog semantics", () => {
	const manifest = JSON.parse(readFileSync(path.join(root, "src", "bridge", "extension", "static", "manifest.json"), "utf8")) as {
		permissions?: string[];
		content_scripts?: Array<{ js?: string[]; world?: string; all_frames?: boolean }>;
	};
	assert.equal(manifest.permissions?.includes("declarativeNetRequest"), false);
	for (const permission of ["cookies", "management", "contentSettings"]) assert.equal(manifest.permissions?.includes(permission), false);
	assert.equal(manifest.content_scripts?.some((script) => script.world === "MAIN"), false);
	assert.equal(manifest.content_scripts?.some((script) => script.all_frames === true), false);
	assert.equal(manifest.content_scripts?.flatMap((script) => script.js ?? []).some((file) => /dialog/i.test(file)), false);
});
