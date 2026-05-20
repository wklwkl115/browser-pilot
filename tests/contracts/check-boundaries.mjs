import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const list = (rel) => readdirSync(path.join(root, rel));

const scripts = list("scripts").sort();
assert.deepEqual(scripts, ["build-bridge.mjs", "register-ts-extension-loader.mjs", "sync-bridge-config.mjs", "sync-native-protocol.mjs", "ts-extension-loader.mjs"], "scripts/ must contain only generators/loaders; move tests to tests/");
assert(!existsSync(path.join(root, "scripts", "smoke-browser.mjs")), "smoke tests must live under tests/smoke/");
assert(!scripts.some((file) => /^check-.*\.mjs$/.test(file)), "contract tests must live under tests/contracts/");

const contractFiles = list("tests/contracts").filter((file) => file.endsWith(".mjs"));
assert(contractFiles.length >= 15, "tests/contracts must contain contract checks");
assert(contractFiles.every((file) => /^check-.*\.mjs$/.test(file)), "tests/contracts files must be named check-*.mjs");
assert(existsSync(path.join(root, "tests", "smoke", "smoke-browser.mjs")), "browser smoke must live under tests/smoke/");

const pkg = JSON.parse(read("package.json"));
const scriptText = Object.values(pkg.scripts || {}).map(String).join("\n").replace(/\\/g, "/");
for (const file of contractFiles) {
	assert(scriptText.includes(`tests/contracts/${file}`), `${file} must be reachable from package.json scripts`);
}
for (const [name, command] of Object.entries(pkg.scripts || {})) {
	if (name.startsWith("check") && name !== "check") assert(!String(command).includes("scripts/check-"), `${name} must not point to scripts/check-*`);
	if (name.startsWith("smoke:browser")) assert(String(command).includes("tests/smoke/smoke-browser.mjs"), `${name} must point to tests/smoke/smoke-browser.mjs`);
}
assert(pkg.scripts?.["check:boundaries"] === "node tests/contracts/check-boundaries.mjs", "package must expose boundary check");
assert(String(pkg.scripts?.check || "").includes("check:boundaries"), "npm run check must include boundary check");

function walk(rel, predicate = () => true) {
	const dir = path.join(root, rel);
	const out = [];
	for (const name of readdirSync(dir, { withFileTypes: true })) {
		const child = path.join(rel, name.name);
		if (name.isDirectory()) out.push(...walk(child, predicate));
		else if (predicate(child)) out.push(child);
	}
	return out;
}

for (const file of ["index.ts", ...walk("src", (file) => file.endsWith(".ts")), ...walk("bridge/pi_browser_bridge", (file) => file.endsWith(".js") || file.endsWith(".json"))]) {
	const text = read(file);
	assert(!text.includes("tests/contracts") && !text.includes("tests/smoke"), `${file} must not depend on test directories`);
	assert(!text.includes("scripts/check-") && !text.includes("check-boundaries"), `${file} must not depend on contract test scripts`);
	assert(!text.includes("tmwd_cdp_bridge"), `${file} must not reference legacy tmwd bridge`);
}

assert(existsSync(path.join(root, "bridge", "tmwd_cdp_bridge", "README.md")), "legacy bridge must carry an explicit README marker");
assert(read("bridge/tmwd_cdp_bridge/README.md").includes("Legacy reference"), "legacy bridge README must mark the directory as reference-only");
console.log("boundary contract ok");
