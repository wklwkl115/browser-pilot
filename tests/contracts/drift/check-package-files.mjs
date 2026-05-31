import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));

const pkg = readJson("package.json");
const usesTsx = (script) => /(^|\s)tsx(\s|$)/.test(String(script || ""));
assert.equal(pkg.scripts?.prepack, "npm run build && node scripts/build-bridge.mjs --quiet", "package prepack must build outer dist and regenerate bridge dist without noisy stdout");
assert.equal(pkg.scripts?.build, "tsc -p tsconfig.build.json", "package must expose outer dist build");
assert.equal(pkg.main, "./dist/index.js", "package main must point to dist/index.js");
assert.equal(pkg.types, "./dist/index.d.ts", "package types must point to dist/index.d.ts");
assert.equal(pkg.bin?.["pi-browser-mcp"], "./dist/mcp/bin.js", "package mcp bin must point to dist/mcp/bin.js");
assert.equal(pkg.exports?.["."]?.import, "./dist/index.js", "package exports import must point to dist/index.js");
assert.equal(pkg.exports?.["."]?.types, "./dist/index.d.ts", "package exports types must point to dist/index.d.ts");
assert.equal(pkg.exports?.["./mcp"]?.import, "./dist/mcp/adapter.js", "package exports must expose ./mcp library entry (adapter)");
assert.equal(pkg.exports?.["./mcp"]?.types, "./dist/mcp/adapter.d.ts", "package exports ./mcp types must point to dist/mcp/adapter.d.ts");
assert.equal(pkg.scripts?.["check:package"], "node tests/contracts/drift/check-package-files.mjs", "package file contract must be exposed as check:package");
assert.equal(pkg.scripts?.["check:all"], "node scripts/run-check-groups.mjs", "check:all must route grouped validation through the shared runner");
assert.equal(pkg.scripts?.["check:all:bridge"], "node scripts/run-check-groups.mjs bridge unit", "check:all:bridge must expose bridge+unit grouped validation");
assert.equal(pkg.scripts?.["check:all:package"], "node scripts/run-check-groups.mjs package docs", "check:all:package must expose package+docs grouped validation");
assert.equal(pkg.scripts?.["check:all:contracts"], "node scripts/run-check-groups.mjs contracts", "check:all:contracts must expose contract grouped validation");
assert.equal(pkg.scripts?.check, "npm run check:all", "npm run check must route through grouped validation runner");
const qualityLocal = String(pkg.scripts?.["quality:local"] || "");
assert(qualityLocal.includes("npm run build:bridge") && qualityLocal.includes("npm run check") && qualityLocal.includes("npm pack --dry-run --json"), "quality:local must run build, check, and package dry-run gates");
assert(qualityLocal.includes("smoke:browser:isolated") && qualityLocal.includes("Optional runtime smoke"), "quality:local must print the optional isolated smoke next step");
assert(!qualityLocal.split("node -e")[0].includes("smoke:browser"), "quality:local must not launch browser smoke by default");
assert.equal(pkg.scripts?.["release:local"], "node tests/release/release-local-acceptance.mjs", "release:local must expose local pack acceptance without browser smoke by default");
assert.equal(pkg.scripts?.["release:local:smoke"], "node tests/release/release-local-acceptance.mjs --smoke --rollback-smoke", "release:local:smoke must exercise current and rollback isolated smoke");
for (const requiredFilesEntry of ["bridge/", "bridge_src/", "scripts/", "tests/", "src/", "dist/", "docs/", "evals/"]) {
	assert(pkg.files?.includes(requiredFilesEntry), `package files must include ${requiredFilesEntry}`);
}

const buildScript = read("scripts/build-bridge.mjs");
const groupedCheckScript = read("scripts/run-check-groups.mjs");
assert(groupedCheckScript.includes("const groups =") && groupedCheckScript.includes("bridge") && groupedCheckScript.includes("contracts"), "grouped check runner must define stable named validation groups");
assert(groupedCheckScript.includes('spawnSync("npm", ["run", script]') || groupedCheckScript.includes("spawnSync(\"npm\", [\"run\", script]"), "grouped check runner must dispatch npm run <script> sequentially");
assert(groupedCheckScript.includes("--json") && groupedCheckScript.includes("check-groups-summary.json") && groupedCheckScript.includes("summary.results.push"), "grouped check runner must support JSON summary mode and persist a structured artifact");
assert(buildScript.includes('process.argv.includes("--quiet")'), "build script must support quiet mode for prepack");
assert(buildScript.includes('path.join(distDir, ".npmignore")') && buildScript.includes("include the generated dist runtime"), "build script must generate dist/.npmignore so npm pack does not inherit dist/.gitignore");
const workflow = read(".github/workflows/check.yml");
const setupAction = read(".github/actions/setup-node-build/action.yml");
assert(workflow.includes("uses: ./.github/actions/setup-node-build"), "CI workflow must reuse the local setup/build composite action");
assert(workflow.includes("npm run check:all:bridge") && workflow.includes("npm run check:all:package") && workflow.includes("npm run check:all:contracts"), "CI workflow must reuse grouped local check entrypoints");
assert(setupAction.includes("actions/setup-node@v4") && setupAction.includes("npm ci") && setupAction.includes("npm run build") && setupAction.includes("npm run build:bridge"), "setup-node-build composite action must encapsulate setup/install/build steps");
const releaseScript = read("tests/release/release-local-acceptance.mjs");
assert(releaseScript.includes('runNpm(["pack", root, "--dry-run", "--json"], { cwd: packRunDir })') && releaseScript.includes('runNpm(["pack", root, "--pack-destination", currentDir, "--json"], { cwd: packRunDir })'), "release acceptance must run dry-run and actual npm pack from a clean temporary cwd through the portable npm runner");
assert(releaseScript.includes("release-acceptance-summary.json") && releaseScript.includes("last-successful") && releaseScript.includes("previous") && releaseScript.includes("packRunDir"), "release acceptance must persist summary, current tarball, rollback candidate, and clean pack cwd");
assert(releaseScript.includes("verifyUnpackedPackage") && releaseScript.includes("manifest.background.service_worker") && releaseScript.includes('serviceWorkerBuildMode !== "esm-import-graph"'), "release acceptance must verify unpacked manifest dist path and build manifest");
assert(releaseScript.includes("PI_BROWSER_SMOKE_EXTENSION_DIR") && releaseScript.includes("PI_BROWSER_SMOKE_MINIMAL") && releaseScript.includes("--rollback-smoke"), "release acceptance must support current and rollback isolated smoke");
assert(releaseScript.includes("PI_BROWSER_CI_RELEASE_SMOKE") && releaseScript.includes("PI_BROWSER_CI_ROLLBACK_SMOKE"), "release acceptance must expose CI opt-in env gates for current and rollback isolated smoke");
assert(releaseScript.includes("failureDiagnostics") && releaseScript.includes("packFiles") && releaseScript.includes("buildManifest") && releaseScript.includes("chromeProfile") && releaseScript.includes("bridgePort") && releaseScript.includes("smokeArtifact"), "release acceptance failures must expose pack/build/profile/port/smoke diagnostics");
const tsxScripts = [
	"check:lint", "check:tools", "test:unit", "check:scan", "check:content-pick", "check:transfer", "check:web-security", "check:page-scripts", "check:fake-ws", "check:lifecycle", "check:paths", "check:token", "check:summaries", "check:artifact", "check:errors", "smoke:browser", "smoke:browser:transfer", "smoke:browser:isolated", "smoke:browser:scan-summary", "smoke:browser:debugger-evidence", "smoke:browser:correlation-chain", "smoke:browser:intercept-response", "smoke:browser:intercept-replace-script", "smoke:browser:intercept-uninstall-fail-closed", "smoke:browser:intercept-request-mutate", "smoke:browser:intercept-tab-close-cleanup", "smoke:browser:intercept-lease-conflict", "smoke:browser:websocket-session", "check:runtime-fixtures", "mcp",
];
for (const name of tsxScripts) assert(usesTsx(pkg.scripts?.[name]), `${name} must run through tsx instead of experimental strip-types`);
assert(usesTsx(pkg.scripts?.["test:unit"]), "test:unit must use tsx runner");
assert(pkg.devDependencies?.tsx, "package must include tsx for runtime TypeScript execution");
const isolatedSmoke = read("tests/smoke/smoke-browser-isolated.mjs");
assert(isolatedSmoke.includes("PI_BROWSER_SMOKE_EXTENSION_DIR") && isolatedSmoke.includes("PI_BROWSER_SMOKE_RESULT_PATH") && isolatedSmoke.includes("PI_BROWSER_SMOKE_KEEP_TEMP_ON_FAILURE"), "isolated smoke must support packed-extension source, custom result path, and failure temp preservation");
assert(isolatedSmoke.includes("PI_BROWSER_CI_BROWSER_SMOKE"), "isolated smoke must support CI opt-in execution hinting");
assert(isolatedSmoke.includes("extensionSource") && isolatedSmoke.includes("tempPreserved"), "isolated smoke result must report extension source and preserved temp paths");
const browserSmoke = read("tests/smoke/smoke-browser.mjs");
assert(browserSmoke.includes("PI_BROWSER_SMOKE_MINIMAL") && browserSmoke.includes("execute.minimal") && browserSmoke.includes("wait.loadState"), "browser smoke must expose a minimal rollback path covering tabs/wait/execute");
assert(!Object.values(pkg.scripts || {}).some((script) => String(script).includes("--experimental-strip-types")), "package scripts must not rely on experimental strip-types after tsx migration");

const output = execSync("npm pack --dry-run --json", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const jsonStart = output.indexOf("[");
assert(jsonStart >= 0, "npm pack --dry-run --json must emit a JSON array");
const pack = JSON.parse(output.slice(jsonStart))[0];
assert(pack && Array.isArray(pack.files), "npm pack dry-run must return package file metadata");
const packed = new Set(pack.files.map((file) => file.path));

const manifest = readJson("bridge/pi_browser_bridge/manifest.json");
const distFiles = new Set(["dist/index.js", "dist/index.d.ts", "dist/mcp/bin.js", "dist/mcp/index.js"]);
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
assert(packed.has("dist/index.js") && packed.has("dist/index.d.ts"), "npm package must include outer dist entry and declarations");
assert(packed.has("dist/mcp/bin.js") && packed.has("dist/mcp/index.js"), "npm package must include compiled mcp dist entrypoints");
assert(packed.has("bridge/pi_browser_bridge/native_command_schema.json"), "npm package must include native command schema");
assert(packed.has("bridge_src/service-worker.ts"), "npm package must include bridge source for portable rebuilds");
assert(packed.has("scripts/build-bridge.mjs"), "npm package must include bridge build script");
assert(packed.has("tests/release/release-local-acceptance.mjs"), "npm package must include local release acceptance script");
assert(packed.has("tests/contracts/drift/check-package-files.mjs"), "npm package must include package contract");
assert(packed.has("evals/browser-workflows/README.md") && packed.has("evals/browser-workflows/01-readable-content-artifact.md") && packed.has("evals/browser-workflows/fixtures/article.html"), "npm package must include browser workflow eval specs and fixtures");
assert(packed.has("evals/browser-workflows/21-cross-tool-correlation-chain.md") && packed.has("evals/browser-workflows/results/21-cross-tool-correlation-chain.result.json"), "npm package must include cross-tool correlation workflow eval spec and sample result");
assert(![...packed].some((file) => file.startsWith(".pi/") || file.includes("/node_modules/")), "npm package must not include runtime artifacts or node_modules");
assert(![...packed].some((file) => file.startsWith("bridge/tmwd_cdp_bridge/")), "npm package must not include legacy tmwd bridge sources");
const packedDist = [...packed].filter((file) => file.startsWith("bridge/pi_browser_bridge/dist/"));
assert(packedDist.length > 5, "npm package must include generated dist runtime, not only dist/.gitignore");

for (const file of ["README.md", "AI_INSTALL.md", "CHANGELOG.md", "ARCHIVE.md"]) {
	const text = read(file);
	assert(text.includes("npm pack --dry-run"), `${file} must document or record package dry-run verification`);
}
for (const file of ["TODO.md", "CURRENT.md", "ARCHIVE.md", "ROADMAP.md", "WORKSTREAMS_A_E_SUMMARY.md"]) {
	assert(packed.has(file), `npm package must include planning document: ${file}`);
}

console.log("package files contract ok");
