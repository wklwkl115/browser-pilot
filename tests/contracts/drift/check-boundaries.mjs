import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const list = (rel) => readdirSync(path.join(root, rel));

const scripts = list("scripts").sort();
assert.deepEqual(scripts, ["build-bridge.mjs", "generate-tool-docs.mjs", "run-check-groups.mjs", "sync-bridge-config.mjs", "sync-capture.mjs", "sync-doc-indexes.mjs", "sync-native-protocol.mjs"], "scripts/ must contain only generators/build/check runners; move tests to tests/");
const usesTsx = (script) => /(^|\s)tsx(\s|$)/.test(String(script || ""));
assert(existsSync(path.join(root, ".github", "actions", "setup-node-build", "action.yml")), "CI reusable setup action must exist under .github/actions/setup-node-build/action.yml");
assert(!existsSync(path.join(root, "scripts", "smoke-browser.mjs")), "smoke tests must live under tests/smoke/");
assert(!scripts.some((file) => /^check-.*\.mjs$/.test(file)), "contract tests must live under tests/contracts/");

assert(existsSync(path.join(root, "tests", "smoke", "smoke-browser.mjs")), "browser smoke must live under tests/smoke/");
assert(existsSync(path.join(root, "tests", "release", "release-local-acceptance.mjs")), "local release acceptance must live under tests/release/");

const pkg = JSON.parse(read("package.json"));

const normalizeRel = (file) => file.replace(/\\/g, "/");
const contractFiles = walk("tests/contracts", (file) => file.endsWith(".mjs")).map(normalizeRel);
assert(contractFiles.length >= 15, "tests/contracts must contain contract checks");
assert(contractFiles.every((file) => /^check-.*\.mjs$/.test(path.basename(file))), "tests/contracts files must be named check-*.mjs");
const helperRoots = [
	"src/utils/records.ts",
	"src/tools/summaries/common.ts",
	"src/tools/webSecurity/shared/normalize.ts",
	"src/protocol/nativeProtocol.ts",
];
const generatedHelperRoots = new Set(["src/protocol/nativeProtocol.ts"]);
const helperRootSet = new Set(helperRoots);
const helperDefinitionMatches = walk("src", (file) => file.endsWith(".ts"))
	.map(normalizeRel)
	.filter((file) => /\bfunction isRecord\b|\bconst isRecord\b|\bfunction recordValue\b|\bconst recordValue\b/.test(read(file)));
for (const file of helperDefinitionMatches) {
	const text = read(file);
	if (/\bfunction isRecord\b|\bconst isRecord\b/.test(text)) assert(helperRootSet.has(file), `${file} must not define local isRecord outside authorized helper roots`);
	if (/\bfunction recordValue\b|\bconst recordValue\b/.test(text)) assert(file === "src/utils/records.ts", `${file} must not define local recordValue outside src/utils/records.ts`);
}
const restrictedInlineObjectGuardMatches = walk("src", (file) => file.endsWith(".ts") || file.endsWith(".mjs"))
	.map(normalizeRel)
	.filter((file) => !helperRootSet.has(file) && !generatedHelperRoots.has(file))
	.filter((file) => /typeof [A-Za-z0-9_$.]+ === "object" && !Array\.isArray\([A-Za-z0-9_$.]+\)/.test(read(file)));
assert.deepEqual(restrictedInlineObjectGuardMatches.sort(), [
	"src/tools/webSecurity/browserNative/callbackOastWorker.mjs",
	"src/tools/webSecurity/register/shared.ts",
], "inline object-guard pattern must stay constrained to explicit boundary helpers or reviewed exceptions");
const allowedJsonParseRoots = new Set([
	"src/utils/json.ts",
	"src/tools/webSecurity/bridges/nucleiBridge.ts",
	"src/tools/webSecurity/browserNative/callbackOastWorker.mjs",
	"src/tools/webSecurity/browserNative/oastWorkerManager.ts",
	"src/tools/webSecurity/browserNative/sqliProbe.ts",
	"src/tools/webSecurity/shared/replay.ts",
]);
const jsonParseMatches = walk("src", (file) => file.endsWith(".ts") || file.endsWith(".mjs"))
	.map(normalizeRel)
	.filter((file) => /\bJSON\.parse\s*\(/.test(read(file)));
assert.deepEqual(jsonParseMatches.sort(), Array.from(allowedJsonParseRoots).sort(), "JSON.parse usage in src/ must stay constrained to reviewed parse roots; prefer shared helpers elsewhere");
assert(!read("src/utils/params.ts").includes("function normalizeTabId") || read("src/utils/params.ts").includes("return toTabId(value);"), "normalizeTabId must remain a thin compatibility alias if retained");
const scriptText = Object.values(pkg.scripts || {}).map(String).join("\n").replace(/\\/g, "/");
for (const file of contractFiles) {
	assert(scriptText.includes(file), `${file} must be reachable from package.json scripts`);
}
for (const [name, command] of Object.entries(pkg.scripts || {})) {
	if (name.startsWith("check") && name !== "check") assert(!String(command).includes("scripts/check-"), `${name} must not point to scripts/check-*`);
	if (name === "smoke:browser" || name === "smoke:browser:transfer") assert(String(command).includes("tests/smoke/smoke-browser.mjs"), `${name} must point to tests/smoke/smoke-browser.mjs`);
	if (name === "smoke:browser:isolated") assert(String(command).includes("tests/smoke/smoke-browser-isolated.mjs"), `${name} must point to tests/smoke/smoke-browser-isolated.mjs`);
	if (name === "release:local" || name === "release:local:smoke") assert(String(command).includes("tests/release/release-local-acceptance.mjs"), `${name} must point to tests/release/release-local-acceptance.mjs`);
}
for (const name of ["test:unit", "check:web-security", "check:fake-ws", "check:lifecycle", "check:page-scripts", "smoke:browser", "smoke:browser:isolated", "smoke:cli"]) {
	assert(usesTsx(pkg.scripts?.[name]), `${name} must execute TypeScript entrypoints through tsx`);
}
assert(!Object.values(pkg.scripts || {}).some((script) => String(script).includes("--experimental-strip-types")), "package scripts must not rely on experimental strip-types");
assert(pkg.scripts?.["check:boundaries"] === "node tests/contracts/drift/check-boundaries.mjs", "package must expose boundary check");
assert(String(pkg.scripts?.check || "") === "npm run check:all", "npm run check must route through the grouped check runner");
assert(String(pkg.scripts?.["check:all:package"] || "").includes("package docs"), "grouped package/docs check entry must exist");

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

assert(!existsSync(path.join(root, "bridge", "tmwd_cdp_bridge")), "legacy bridge source directory must not remain under bridge/");
assert(existsSync(path.join(root, "docs", "archive", "tmwd-cdp-bridge-legacy.md")), "legacy bridge archive summary must exist under docs/archive/");
assert(existsSync(path.join(root, "docs", "archive", "tmwd-cdp-bridge-legacy.full.md")), "legacy bridge archive detail must exist under docs/archive/");
assert(read("docs/archive/tmwd-cdp-bridge-legacy.md").includes("唯一正式运行入口") && read("docs/archive/tmwd-cdp-bridge-legacy.full.md").includes("git 历史"), "legacy bridge archive docs must explain runtime boundary and historical retrieval path");
console.log("boundary contract ok");
