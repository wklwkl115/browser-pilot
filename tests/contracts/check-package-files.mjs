import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));

const pkg = readJson("package.json");
assert.equal(pkg.scripts?.prepack, "node scripts/build-bridge.mjs --quiet", "package prepack must regenerate bridge dist without noisy stdout");
assert.equal(pkg.scripts?.["check:package"], "node tests/contracts/check-package-files.mjs", "package file contract must be exposed as check:package");
assert(String(pkg.scripts?.check || "").includes("check:package"), "npm run check must validate package runtime files");
const qualityLocal = String(pkg.scripts?.["quality:local"] || "");
assert(qualityLocal.includes("npm run build:bridge") && qualityLocal.includes("npm run check") && qualityLocal.includes("npm pack --dry-run --json"), "quality:local must run build, check, and package dry-run gates");
assert(qualityLocal.includes("smoke:browser:isolated") && qualityLocal.includes("Optional runtime smoke"), "quality:local must print the optional isolated smoke next step");
assert(!qualityLocal.split("node -e")[0].includes("smoke:browser"), "quality:local must not launch browser smoke by default");
assert.equal(pkg.scripts?.["release:local"], "node tests/release/release-local-acceptance.mjs", "release:local must expose local pack acceptance without browser smoke by default");
assert.equal(pkg.scripts?.["release:local:smoke"], "node tests/release/release-local-acceptance.mjs --smoke --rollback-smoke", "release:local:smoke must exercise current and rollback isolated smoke");
for (const requiredFilesEntry of ["bridge/", "bridge_src/", "scripts/", "tests/", "src/", "docs/"]) {
	assert(pkg.files?.includes(requiredFilesEntry), `package files must include ${requiredFilesEntry}`);
}

const buildScript = read("scripts/build-bridge.mjs");
assert(buildScript.includes('process.argv.includes("--quiet")'), "build script must support quiet mode for prepack");
assert(buildScript.includes('path.join(distDir, ".npmignore")') && buildScript.includes("include the generated dist runtime"), "build script must generate dist/.npmignore so npm pack does not inherit dist/.gitignore");
const releaseScript = read("tests/release/release-local-acceptance.mjs");
assert(releaseScript.includes('runNpm(["pack", root, "--dry-run", "--json"], { cwd: packRunDir })') && releaseScript.includes('runNpm(["pack", root, "--pack-destination", currentDir, "--json"], { cwd: packRunDir })'), "release acceptance must run dry-run and actual npm pack from a clean temporary cwd through the portable npm runner");
assert(releaseScript.includes("release-acceptance-summary.json") && releaseScript.includes("last-successful") && releaseScript.includes("previous") && releaseScript.includes("packRunDir"), "release acceptance must persist summary, current tarball, rollback candidate, and clean pack cwd");
assert(releaseScript.includes("verifyUnpackedPackage") && releaseScript.includes("manifest.background.service_worker") && releaseScript.includes('serviceWorkerBuildMode !== "esm-import-graph"'), "release acceptance must verify unpacked manifest dist path and build manifest");
assert(releaseScript.includes("PI_BROWSER_SMOKE_EXTENSION_DIR") && releaseScript.includes("PI_BROWSER_SMOKE_MINIMAL") && releaseScript.includes("--rollback-smoke"), "release acceptance must support current and rollback isolated smoke");
assert(releaseScript.includes("failureDiagnostics") && releaseScript.includes("packFiles") && releaseScript.includes("buildManifest") && releaseScript.includes("chromeProfile") && releaseScript.includes("bridgePort") && releaseScript.includes("smokeArtifact"), "release acceptance failures must expose pack/build/profile/port/smoke diagnostics");
const isolatedSmoke = read("tests/smoke/smoke-browser-isolated.mjs");
assert(isolatedSmoke.includes("PI_BROWSER_SMOKE_EXTENSION_DIR") && isolatedSmoke.includes("PI_BROWSER_SMOKE_RESULT_PATH") && isolatedSmoke.includes("PI_BROWSER_SMOKE_KEEP_TEMP_ON_FAILURE"), "isolated smoke must support packed-extension source, custom result path, and failure temp preservation");
assert(isolatedSmoke.includes("extensionSource") && isolatedSmoke.includes("tempPreserved"), "isolated smoke result must report extension source and preserved temp paths");
const browserSmoke = read("tests/smoke/smoke-browser.mjs");
assert(browserSmoke.includes("PI_BROWSER_SMOKE_MINIMAL") && browserSmoke.includes("execute.minimal") && browserSmoke.includes("wait.loadState"), "browser smoke must expose a minimal rollback path covering tabs/wait/execute");

const output = execSync("npm pack --dry-run --json", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const jsonStart = output.indexOf("[");
assert(jsonStart >= 0, "npm pack --dry-run --json must emit a JSON array");
const pack = JSON.parse(output.slice(jsonStart))[0];
assert(pack && Array.isArray(pack.files), "npm pack dry-run must return package file metadata");
const packed = new Set(pack.files.map((file) => file.path));

const manifest = readJson("bridge/pi_browser_bridge/manifest.json");
const distFiles = new Set();
distFiles.add(`bridge/pi_browser_bridge/${manifest.background.service_worker}`);
for (const script of manifest.content_scripts || []) {
	for (const item of script.js || []) distFiles.add(`bridge/pi_browser_bridge/${item}`);
}
distFiles.add("bridge/pi_browser_bridge/dist/hook_dispatcher.js");
distFiles.add("bridge/pi_browser_bridge/dist/build-manifest.json");
for (const file of [...distFiles]) {
	if (file.endsWith(".js")) distFiles.add(`${file}.map`);
}

for (const file of distFiles) {
	assert(packed.has(file), `npm package must include generated runtime file: ${file}`);
}
assert(packed.has("bridge/pi_browser_bridge/manifest.json"), "npm package must include extension manifest");
assert(packed.has("bridge/pi_browser_bridge/native_command_schema.json"), "npm package must include native command schema");
assert(packed.has("bridge_src/service-worker.ts"), "npm package must include bridge source for portable rebuilds");
assert(packed.has("scripts/build-bridge.mjs"), "npm package must include bridge build script");
assert(packed.has("tests/release/release-local-acceptance.mjs"), "npm package must include local release acceptance script");
assert(packed.has("tests/contracts/check-package-files.mjs"), "npm package must include package contract");
assert(![...packed].some((file) => file.startsWith(".pi/") || file.includes("/node_modules/")), "npm package must not include runtime artifacts or node_modules");
const packedDist = [...packed].filter((file) => file.startsWith("bridge/pi_browser_bridge/dist/"));
assert(packedDist.length > 5, "npm package must include generated dist runtime, not only dist/.gitignore");

for (const file of ["README.md", "AI_INSTALL.md", "CHANGELOG.md", "TODO.md"]) {
	const text = read(file);
	assert(text.includes("npm pack --dry-run"), `${file} must document or record package dry-run verification`);
}

console.log("package files contract ok");
