import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXPECTED_PACKAGE_FACTS } from "./expected-package-facts.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));

const pkg = readJson("package.json");
const scripts = pkg.scripts || {};

assert.equal(pkg.license, "Apache-2.0", "package license must match the public repository license");
assert.equal(pkg.main, "./dist/index.js", "package main must point to dist/index.js");
assert.equal(pkg.types, "./dist/index.d.ts", "package types must point to dist/index.d.ts");
assert.equal(pkg.bin?.["browser-pilot"], "./dist/cli/bin.js", "package CLI bin must point to dist/cli/bin.js");
assert.equal(pkg.exports?.["."]?.import, "./dist/index.js", "package exports import must point to dist/index.js");
assert.equal(pkg.exports?.["."]?.types, "./dist/index.d.ts", "package exports types must point to dist/index.d.ts");
assert.equal(scripts.prepack, "npm run build && node scripts/build-bridge.mjs --quiet", "prepack must build runtime outputs");
assert.equal(scripts.prepare, "node scripts/install-git-hooks.mjs", "prepare must route through the portable hook installer");
assert.equal(scripts.build, "tsc -p tsconfig.build.json", "package must expose the TypeScript build");
assert.equal(scripts["build:bridge"], "node scripts/build-bridge.mjs", "package must expose bridge build");
assert.equal(scripts["release:portable"], "node tests/release/release-portable-acceptance.mjs", "repo must keep portable release acceptance");
assert.equal(scripts["check:package"], "node tests/contracts/drift/check-package-files.mjs", "repo must keep this package-surface contract");
assert(!Object.keys(scripts).some((name) => name.startsWith("eval:") || name === "check:eval-workflows" || name === "check:browser-workflow-results"), "public scripts must not expose development eval entrypoints");
assert(!("scope:begin" in scripts), "public scripts must not expose local workstream-scope helpers");
assert(!("check:internal" in scripts), "public scripts must not expose local maintainer-only aggregate checks");
assert(!("check:audit-inbox" in scripts), "public scripts must not expose local audit inbox checks");
assert(!("check:doc-structure" in scripts), "public scripts must not expose local governance-doc checks");
assert(!("check:registry-drift" in scripts), "public scripts must not expose private CURRENT.md registry checks");
assert(!("check:jshookmcp-closure" in scripts), "public scripts must not expose completed internal migration guards");
assert(!("smoke:abml:internal-routing" in scripts), "public scripts must not expose internal-routing smoke entrypoints");

const files = pkg.files || [];
for (const required of [
	"CHANGELOG.md",
	"CONTRIBUTING.md",
	"CODE_OF_CONDUCT.md",
	"README.md",
	"README.zh-CN.md",
	"LICENSE",
	"SECURITY.md",
	"bridge/",
	"bridge_src/",
	"capture-src/",
	"cli/",
	"src/",
	"dist/",
	"skills/browser-pilot/",
	"skills/browser-pilot-cli/",
	"scripts/build-bridge.mjs",
	"scripts/install-git-hooks.mjs",
]) {
	assert(files.includes(required), `package files must include user/runtime entry ${required}`);
}
for (const publicDoc of [
	"docs/browser-memory.md",
	"docs/browser-usage.md",
	"docs/cli.md",
	"docs/guide-cli.md",
	"docs/guide-pi-native.md",
	"docs/generated/browser-tool-contract.generated.md",
	"docs/generated/native-protocol.generated.md",
	"docs/playbooks/",
	"docs/reference/",
	"docs/tool-boundaries.md",
]) {
	assert(files.includes(publicDoc), `package files must include public doc entry ${publicDoc}`);
}
for (const forbidden of [
	"AI_INSTALL.md",
	"AGENTS.md",
	"TODO.md",
	"CURRENT.md",
	"ARCHIVE.md",
	"ROADMAP.md",
	"WORKSTREAMS_A_E_SUMMARY.md",
	"docs/",
	"docs/compaction-ledger.json",
	"skills/",
	"scripts/",
	"tests/",
	"evals/",
	"lefthook.yml",
]) {
	assert(!files.includes(forbidden), `package files must not include broad/internal entry ${forbidden}`);
}

assert(read("LICENSE").includes("Apache License") && read("LICENSE").includes("Version 2.0"), "repository must include Apache-2.0 license text");
assert.equal(scripts["sync:protocol"], EXPECTED_PACKAGE_FACTS.syncProtocolScript.value, `package must expose canonical protocol sync script (${EXPECTED_PACKAGE_FACTS.syncProtocolScript.rationale})`);
assert(read("scripts/build-bridge.mjs").includes('process.argv.includes("--quiet")'), "build script must support quiet mode for prepack");
const workflow = read(".github/workflows/check.yml");
assert(workflow.includes("npm run release:portable"), "CI package acceptance must run the portable clean-tree/consumer install gate");
assert(workflow.includes("permissions:\n  contents: read"), "CI workflow must use minimum read-only repository permissions by default");
assert(read("tests/release/release-portable-acceptance.mjs").includes("forbiddenPublicPathRe") && read("tests/release/release-portable-acceptance.mjs").includes("evals"), "portable release acceptance must reject internal-only public tree paths");

const output = execSync("npm pack --dry-run --ignore-scripts --json", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const jsonStart = output.indexOf("[");
assert(jsonStart >= 0, "npm pack --dry-run --ignore-scripts --json must emit a JSON array");
const pack = JSON.parse(output.slice(jsonStart))[0];
assert(pack && Array.isArray(pack.files), "npm pack dry-run must return package file metadata");
const packed = new Set(pack.files.map((file) => file.path));

const SECRET_LIKE_SOURCE_RE = /sk_live_[A-Za-z0-9_-]{20,}|sk-(?:live|proj)-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9_]{36,}|-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{20,}/i;
const SCANNED_TEXT_RE = /\.(?:cjs|css|html|js|json|md|mjs|ts|txt|yaml|yml)$/;
const trackedFiles = execSync("git ls-files", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split(/\r?\n/).filter(Boolean);
for (const rel of trackedFiles) {
	if (!SCANNED_TEXT_RE.test(rel) || !existsSync(path.join(root, rel))) continue;
	assert(!SECRET_LIKE_SOURCE_RE.test(read(rel)), `tracked source file contains secret-like material: ${rel}`);
}
for (const file of pack.files) {
	const rel = String(file.path || "");
	if (!SCANNED_TEXT_RE.test(rel) || !existsSync(path.join(root, rel))) continue;
	assert(!SECRET_LIKE_SOURCE_RE.test(read(rel)), `npm package file contains secret-like material: ${rel}`);
}

const manifest = readJson("bridge/pi_browser_bridge/manifest.json");
assert.equal(manifest.version, pkg.version, "extension manifest version must match package.json version");
assert.equal(manifest.background.service_worker, EXPECTED_PACKAGE_FACTS.manifestServiceWorker.value, `manifest service worker expectation: ${EXPECTED_PACKAGE_FACTS.manifestServiceWorker.rationale}`);
for (const file of [
	"dist/index.js",
	"dist/index.d.ts",
	"dist/cli/bin.js",
	"dist/cli/index.js",
	`bridge/pi_browser_bridge/${manifest.background.service_worker}`,
	"bridge/pi_browser_bridge/dist/content.js",
	"bridge/pi_browser_bridge/dist/hook_dispatcher.js",
	"bridge/pi_browser_bridge/dist/offscreen.js",
	"bridge/pi_browser_bridge/dist/build-manifest.json",
	"bridge/pi_browser_bridge/manifest.json",
	"bridge/pi_browser_bridge/native_command_schema.json",
	"bridge/pi_browser_bridge/offscreen.html",
	"src/tools/webSecurity/browserNative/callbackOastWorker.mjs",
	"capture-src/entries/scanTemplate.ts",
	"src/capture/generated/scanBundle.ts",
	"skills/browser-pilot/SKILL.md",
	"skills/browser-pilot-cli/SKILL.md",
]) {
	assert(packed.has(file), `npm package must include runtime/user file: ${file}`);
}
assert(![...packed].some((file) => file.startsWith("tests/")), "npm package must not include repository tests");
assert(![...packed].some((file) => file.startsWith("evals/")), "npm package must not include development evals");
assert(![...packed].some((file) => file.startsWith("agent-audits/") || file.startsWith("docs/archive/") || file.startsWith(".plan/") || file.startsWith(".claude/")), "npm package must not include local archive, audit, plan, or assistant-state directories");
assert(![...packed].some((file) => /^(AI_INSTALL|AGENTS|TODO|CURRENT|ARCHIVE|ROADMAP|WORKSTREAMS_A_E_SUMMARY)\.md$/.test(file)), "npm package must not include local governance or AI-install documents");
assert(![...packed].some((file) => file.startsWith("scripts/") && ![
	"scripts/build-bridge.mjs",
	"scripts/install-git-hooks.mjs",
	"scripts/sync-bridge-config.mjs",
	"scripts/sync-capture.mjs",
	"scripts/sync-native-protocol.mjs",
	"scripts/lib/managed-blocks.mjs",
].includes(file)), "npm package must not include development harness scripts");
assert(![...packed].some((file) => file === "lefthook.yml" || file.startsWith(".vscode/") || file === ".aceignore"), "npm package must not include local IDE/hook/search configuration");

console.log("package files contract ok");
