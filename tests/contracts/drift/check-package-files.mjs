import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHECK_DAG_RUN_DIR, CHECK_DAG_SUMMARY_PATH, CHECK_GROUPS, CHECK_GROUPS_SUMMARY_PATH, CHECK_IMPACT_SUMMARY_PATH, CHECK_MISS_DIR, GRAPH_SCRIPT_EXCLUSIONS, graphCoveredPackageScripts, resolveScriptSteps } from "../../../scripts/check-graph.mjs";
import { EXPECTED_PACKAGE_FACTS } from "./expected-package-facts.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const readJson = (rel) => JSON.parse(read(rel));

const pkg = readJson("package.json");
const eslintConfig = read("eslint.config.js");
const gitAttributes = read(".gitattributes");
const usesTsx = (script) => /(^|\s)tsx(\s|$)/.test(String(script || ""));
assert.equal(pkg.scripts?.prepack, "npm run build && node scripts/build-bridge.mjs --quiet", "package prepack must build outer dist and regenerate bridge dist without noisy stdout");
assert.equal(pkg.scripts?.prepare, "node scripts/install-git-hooks.mjs", "package prepare must route through a CI/pack-aware hook installer");
assert.equal(pkg.license, "Apache-2.0", "package license must match the public repository license");
assert.equal(pkg.scripts?.build, "tsc -p tsconfig.build.json", "package must expose outer dist build");
assert.equal(pkg.main, "./dist/index.js", "package main must point to dist/index.js");
assert.equal(pkg.types, "./dist/index.d.ts", "package types must point to dist/index.d.ts");
assert.equal(pkg.bin?.["browser-pilot"], "./dist/cli/bin.js", "package CLI bin must point to dist/cli/bin.js");
assert.equal(pkg.exports?.["."]?.import, "./dist/index.js", "package exports import must point to dist/index.js");
assert.equal(pkg.exports?.["."]?.types, "./dist/index.d.ts", "package exports types must point to dist/index.d.ts");
assert.equal(pkg.scripts?.["check:package"], "node tests/contracts/drift/check-package-files.mjs", "package file contract must be exposed as check:package");
assert.equal(pkg.scripts?.["check:all"], "node scripts/check-dag.mjs", "check:all must route closing validation through the DAG runner");
assert.equal(pkg.scripts?.["check:serial"], "node scripts/run-check-groups.mjs", "check:serial must retain the grouped serial runner");
assert.equal(pkg.scripts?.["check:trace"], "node scripts/run-check-groups.mjs --json", "check:trace must expose grouped trace JSON mode");
assert.equal(pkg.scripts?.["check:dag"], "node scripts/check-dag.mjs", "check:dag must expose graph-backed DAG execution");
assert.equal(pkg.scripts?.["check:smart"], "node scripts/check-dag.mjs --smart", "check:smart must expose graph-backed impact execution");
assert.equal(pkg.scripts?.["sync:impact-map"], "node scripts/sync-impact-map.mjs", "package must expose impact map synchronization");
assert.equal(pkg.scripts?.["check:impact-map"], "node scripts/sync-impact-map.mjs --check", "package must expose impact map drift validation");
assert.equal(pkg.scripts?.["sync:code-map"], "tsx scripts/sync-code-map.mjs", "package must expose code map synchronization");
assert.equal(pkg.scripts?.["check:code-map"], "tsx scripts/sync-code-map.mjs --check", "package must expose code map drift validation");
assert(read("scripts/sync-code-map.mjs").includes("generated code map absent"), "code map check must be inert in sanitized public trees that omit the internal generated code map");
assert.equal(pkg.scripts?.["query:markers"], "node scripts/query-markers.mjs", "package must expose marker query helper");
assert.equal(pkg.scripts?.["new:check"], "node scripts/new-check.mjs", "package must expose new-check scaffolding");
assert.equal(pkg.scripts?.["scope:begin"], "node scripts/workstream-scope.mjs --begin", "package must expose workstream scope baseline capture");
assert.equal(pkg.scripts?.["docs:sync"], "node scripts/sync-docs.mjs", "package must expose doc sync umbrella");
assert.equal(pkg.scripts?.["check:docs-sync"], "node tests/contracts/drift/check-docs-sync.mjs", "package must expose doc sync drift validation");
assert.equal(pkg.scripts?.["check:audit-inbox"], "node tests/contracts/drift/check-audit-inbox.mjs", "package must expose audit inbox lifecycle validation");
assert.equal(pkg.scripts?.["check:doc-paths"], "node tests/contracts/drift/check-doc-paths.mjs", "package must expose doc path liveness validation");
assert.equal(pkg.scripts?.["check:all:src"], "node scripts/check-dag.mjs src", "check:all:src must expose src grouped validation through DAG");
assert.equal(pkg.scripts?.["check:all:bridge"], "node scripts/check-dag.mjs bridge unit", "check:all:bridge must expose bridge+unit grouped validation through DAG");
assert.equal(pkg.scripts?.["check:all:package"], "node scripts/check-dag.mjs package docs", "check:all:package must expose package+docs grouped validation through DAG");
assert.equal(pkg.scripts?.["check:all:contracts"], "node scripts/check-dag.mjs contracts", "check:all:contracts must expose contract grouped validation through DAG");
assert(!pkg.scripts?.["check:lint"], "legacy check:lint aggregate must not remain");
assert.equal(pkg.scripts?.check, "npm run check:all", "npm run check must route through grouped validation runner");
const qualityLocal = String(pkg.scripts?.["quality:local"] || "");
assert(qualityLocal.includes("npm run build:bridge") && qualityLocal.includes("npm run lint") && qualityLocal.includes("npm run check") && qualityLocal.includes("npm pack --dry-run --json"), "quality:local must run build, lint, check, and package dry-run gates");
assert(qualityLocal.includes("smoke:browser:isolated") && qualityLocal.includes("Optional runtime smoke"), "quality:local must print the optional isolated smoke next step");
assert(!qualityLocal.split("node -e")[0].includes("smoke:browser"), "quality:local must not launch browser smoke by default");
assert.equal(pkg.scripts?.["release:local"], "node tests/release/release-local-acceptance.mjs", "release:local must expose local pack acceptance without browser smoke by default");
assert.equal(pkg.scripts?.["release:portable"], "node tests/release/release-portable-acceptance.mjs", "release:portable must expose clean public-tree and consumer-install acceptance");
assert.equal(pkg.scripts?.["release:local:smoke"], "node tests/release/release-local-acceptance.mjs --smoke --rollback-smoke", "release:local:smoke must exercise current and rollback isolated smoke");
assert.equal((eslintConfig.match(/files:\s*\["cli\/\*\*\/\*\.ts"\]/g) || []).length, 1, "eslint config must have one authoritative CLI TypeScript block");
assert(eslintConfig.includes('files: ["cli/**/*.ts"]') && eslintConfig.includes('project: "./tsconfig.json"'), "CLI TypeScript linting must use the Node tsconfig as its authoritative project");
assert(!eslintConfig.includes('project: "./tsconfig.build.json"'), "eslint config must not bind any source lint block to the build-only tsconfig");
for (const rule of ["*.ts text eol=lf", "*.mjs text eol=lf", "*.json text eol=lf", "*.map text eol=lf", ".gitattributes text eol=lf", ".gitignore text eol=lf", ".npmignore text eol=lf"]) {
	assert(gitAttributes.includes(rule), `.gitattributes must pin LF for generated and source text rule: ${rule}`);
}
for (const requiredFilesEntry of ["LICENSE", "SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "bridge/", "bridge_src/", "scripts/", "tests/", "src/", "dist/", "capture-src/", "skills/browser-pilot/", "skills/browser-pilot-cli/"]) {
	assert(pkg.files?.includes(requiredFilesEntry), `package files must include ${requiredFilesEntry}`);
}
for (const publicDocEntry of ["docs/browser-memory.md", "docs/browser-usage.md", "docs/cli.md", "docs/guide-cli.md", "docs/guide-pi-native.md", "docs/generated/browser-tool-contract.generated.md", "docs/generated/native-protocol.generated.md", "docs/playbooks/", "docs/reference/", "docs/tool-boundaries.md"]) {
	assert(pkg.files?.includes(publicDocEntry), `package files must include public doc entry ${publicDocEntry}`);
}
for (const internalEntry of ["AGENTS.md", "TODO.md", "CURRENT.md", "ARCHIVE.md", "ROADMAP.md", "WORKSTREAMS_A_E_SUMMARY.md", "docs/", "skills/", "evals/"]) {
	assert(!pkg.files?.includes(internalEntry), `package files must not include broad/internal entry ${internalEntry}`);
}
assert(!Object.keys(pkg.scripts || {}).some((name) => name.startsWith("eval:") || name === "check:eval-workflows" || name === "check:browser-workflow-results"), "public package scripts must not expose development eval entrypoints");
assert(read("LICENSE").includes("Apache License") && read("LICENSE").includes("Version 2.0"), "repository must include Apache-2.0 license text");
assert.equal(pkg.scripts?.["sync:capture"], "node scripts/sync-capture.mjs", "package must expose capture bundle synchronization");
assert.equal(pkg.scripts?.["sync:protocol"], EXPECTED_PACKAGE_FACTS.syncProtocolScript.value, `package must expose canonical protocol sync script (${EXPECTED_PACKAGE_FACTS.syncProtocolScript.rationale})`);
assert.equal(pkg.scripts?.["check:capture"], "node scripts/sync-capture.mjs --check && node tests/contracts/runtime/check-capture-core-boundary.mjs", "package must expose capture drift and boundary check");

const buildScript = read("scripts/build-bridge.mjs");
const bridgeDistNpmIgnore = read("bridge/pi_browser_bridge/dist/.npmignore");
const graphCovered = graphCoveredPackageScripts();
assert(CHECK_GROUPS.bridge.includes("check:bridge") && CHECK_GROUPS.contracts.includes("check:capture") && CHECK_GROUPS.contracts.includes("check:check-graph") && CHECK_GROUPS.contracts.includes("check:impact-map"), "check graph must expose stable named groups and include capture, graph-drift, and impact-map contracts");
assert(graphCovered.has("check:docs-sync") && graphCovered.has("check:impact-map"), "graph coverage must include docs sync and impact-map proof nodes");
assert(GRAPH_SCRIPT_EXCLUSIONS["check:package"], "check:package is an internal governance contract excluded from the public default check graph; it must be registered in GRAPH_SCRIPT_EXCLUSIONS and run via check:internal");
assert(resolveScriptSteps("check:bridge").some((step) => step.script === "check:protocol"), "check graph resolver must expand nested npm-run steps");
assert(path.basename(CHECK_GROUPS_SUMMARY_PATH) === "check-groups-summary.json" && path.basename(CHECK_DAG_SUMMARY_PATH) === "check-dag-summary.json" && path.basename(CHECK_IMPACT_SUMMARY_PATH) === "check-impact-summary.json" && path.basename(CHECK_DAG_RUN_DIR) === "check-dag" && path.basename(CHECK_MISS_DIR) === "check-misses", "grouped/DAG runners must publish stable summary, per-run, impact, and miss artifact locations");
assert(buildScript.includes('process.argv.includes("--quiet")'), "build script must support quiet mode for prepack");
assert(bridgeDistNpmIgnore.includes("include the generated dist runtime"), "bridge dist .npmignore must preserve npm package inclusion despite dist/.gitignore");
const workflow = read(".github/workflows/check.yml");
const setupAction = read(".github/actions/setup-node-build/action.yml");
assert(workflow.includes("uses: ./.github/actions/setup-node-build"), "CI workflow must reuse the local setup/build composite action");
assert(workflow.includes("npm run check:all:src") && workflow.includes("npm run check:all:bridge") && workflow.includes("npm run check:all:package") && workflow.includes("npm run check:all:contracts"), "CI workflow must reuse DAG grouped local check entrypoints including src");
assert(!workflow.includes("npm run check:lint"), "CI workflow must not call retired check:lint aggregate");
assert(workflow.includes(".pi/browser-artifacts/check-dag-summary.json") && workflow.includes(".pi/browser-artifacts/check-dag/**"), "CI workflow must upload DAG check artifacts for review");
assert(workflow.includes("permissions:\n  contents: read"), "CI workflow must use minimum read-only repository permissions by default");
assert(!workflow.includes("PI_BROWSER_SMOKE_CHROME: C:\\Program Files"), "manual smoke workflows must let browserSmokeEnv discover the hosted-runner browser path");
assert(setupAction.includes("actions/setup-node@v4") && setupAction.includes("npm ci") && setupAction.includes("npm run build") && setupAction.includes("npm run build:bridge"), "setup-node-build composite action must encapsulate setup/install/build steps");
const releaseScript = read("tests/release/release-local-acceptance.mjs");
assert(releaseScript.includes('runNpm(["pack", root, "--dry-run", "--json"], { cwd: packRunDir })') && releaseScript.includes('runNpm(["pack", root, "--pack-destination", currentDir, "--json"], { cwd: packRunDir })'), "release acceptance must run dry-run and actual npm pack from a clean temporary cwd through the portable npm runner");
assert(releaseScript.includes("release-acceptance-summary.json") && releaseScript.includes("last-successful") && releaseScript.includes("previous") && releaseScript.includes("packRunDir"), "release acceptance must persist summary, current tarball, rollback candidate, and clean pack cwd");
assert(releaseScript.includes("verifyUnpackedPackage") && releaseScript.includes("manifest.background.service_worker") && releaseScript.includes('serviceWorkerBuildMode !== "esm-import-graph"'), "release acceptance must verify unpacked manifest dist path and build manifest");
assert(releaseScript.includes("PI_BROWSER_SMOKE_EXTENSION_DIR") && releaseScript.includes("PI_BROWSER_SMOKE_MINIMAL") && releaseScript.includes("--rollback-smoke"), "release acceptance must support current and rollback isolated smoke");
assert(releaseScript.includes("PI_BROWSER_CI_RELEASE_SMOKE") && releaseScript.includes("PI_BROWSER_CI_ROLLBACK_SMOKE"), "release acceptance must expose CI opt-in env gates for current and rollback isolated smoke");
assert(releaseScript.includes("failureDiagnostics") && releaseScript.includes("packFiles") && releaseScript.includes("buildManifest") && releaseScript.includes("chromeProfile") && releaseScript.includes("bridgePort") && releaseScript.includes("smokeArtifact"), "release acceptance failures must expose pack/build/profile/port/smoke diagnostics");
const portableReleaseScript = read("tests/release/release-portable-acceptance.mjs");
assert(portableReleaseScript.includes("git") && portableReleaseScript.includes("ls-files") && portableReleaseScript.includes("--exclude-standard"), "portable release acceptance must build from the public Git file set, not ignored local files");
assert(portableReleaseScript.includes('runNpm(["run", "docs:sync"]') && portableReleaseScript.includes("check:all:package") && portableReleaseScript.includes("check:all:contracts") && portableReleaseScript.includes('runConsumerBin(["--help"])') && portableReleaseScript.includes('runConsumerBin(["commands", "--json"])') && portableReleaseScript.includes('runConsumerBin(["schema", "observe", "--json"])') && portableReleaseScript.includes('runConsumerBin(["status", "--json"])'), "portable release acceptance must sync generated public-tree docs, run package/contracts gates, and no-browser consumer CLI smoke");
assert(portableReleaseScript.includes("forbiddenPublicPathRe") && portableReleaseScript.includes("docs\\/archive") && portableReleaseScript.includes("agent-audits") && portableReleaseScript.includes("evals"), "portable release acceptance must reject internal-only public tree paths");
assert(workflow.includes("npm run release:portable"), "CI package acceptance must run the portable clean-tree/consumer install gate");
const docIndexScript = read("scripts/sync-doc-indexes.mjs");
assert(docIndexScript.includes("governance docs absent") && docIndexScript.includes("presentIndexInputs.length === 0"), "doc index sync must be inert in sanitized public trees that omit internal governance docs");
assert(read("tests/contracts/protocol/check-bridge-build.mjs").includes("internal archive doc absent") && read("tests/contracts/protocol/check-bridge-files.mjs").includes("internal archive doc absent"), "bridge contracts must keep internal archive-doc checks optional in sanitized public trees");
assert(read("tests/contracts/drift/check-spec-truth.mjs").includes("skipped") && read("tests/contracts/drift/check-spec-truth.mjs").includes("internal doc(s)"), "spec truth contract must make omitted internal spec docs inert and visible in sanitized public trees");
const tsxScripts = [
	"check:tools", "test:unit", "test:unit:abml", "test:unit:cli", "test:unit:distill", "test:unit:driver", "test:unit:memory", "test:unit:tools", "test:unit:web-security", "test:unit:misc", "check:scan", "check:content-pick", "check:transfer", "check:web-security", "check:page-scripts", "check:fake-ws", "check:lifecycle", "check:paths", "check:token", "check:summaries", "check:artifact", "check:errors", "smoke:browser", "smoke:browser:transfer", "smoke:browser:isolated", "smoke:browser:scan-summary", "smoke:browser:debugger-evidence", "smoke:browser:correlation-chain", "smoke:browser:intercept-response", "smoke:browser:intercept-replace-script", "smoke:browser:intercept-uninstall-fail-closed", "smoke:browser:intercept-request-mutate", "smoke:browser:intercept-tab-close-cleanup", "smoke:browser:intercept-lease-conflict", "smoke:browser:websocket-session", "check:runtime-fixtures", "smoke:cli", "smoke:cli:full", "check:cli-parity", "check:cli-json-envelopes",
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

const output = execSync("npm pack --dry-run --ignore-scripts --json", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const jsonStart = output.indexOf("[");
assert(jsonStart >= 0, "npm pack --dry-run --ignore-scripts --json must emit a JSON array");
const pack = JSON.parse(output.slice(jsonStart))[0];
assert(pack && Array.isArray(pack.files), "npm pack dry-run must return package file metadata");
const packed = new Set(pack.files.map((file) => file.path));
const SECRET_LIKE_SOURCE_RE = /sk_live_[A-Za-z0-9_-]{20,}|sk-(?:live|proj)-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9_]{36,}|-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{20,}/i;
const SCANNED_TEXT_RE = /\.(?:cjs|css|html|js|json|md|mjs|ts|txt|yaml|yml)$/;
const assertNoSecretLikeMaterial = (rel, text, scope) => {
	assert(!SECRET_LIKE_SOURCE_RE.test(text), `${scope} contains secret-like material: ${rel}`);
};
const trackedFiles = execSync("git ls-files", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).split(/\r?\n/).filter(Boolean);
for (const rel of trackedFiles) {
	if (!SCANNED_TEXT_RE.test(rel)) continue;
	if (!existsSync(path.join(root, rel))) continue;
	assertNoSecretLikeMaterial(rel, read(rel), "tracked source file");
}
for (const file of pack.files) {
	const rel = String(file.path || "");
	if (!SCANNED_TEXT_RE.test(rel)) continue;
	assertNoSecretLikeMaterial(rel, read(rel), "npm package file");
}

const manifest = readJson("bridge/pi_browser_bridge/manifest.json");
assert.equal(manifest.version, pkg.version, "extension manifest version must match package.json version");
assert.equal(manifest.background.service_worker, EXPECTED_PACKAGE_FACTS.manifestServiceWorker.value, `manifest service worker expectation: ${EXPECTED_PACKAGE_FACTS.manifestServiceWorker.rationale}`);
const distFiles = new Set(["dist/index.js", "dist/index.d.ts", "dist/cli/bin.js", "dist/cli/index.js"]);
distFiles.add("dist/cli/connection.js");
distFiles.add(`bridge/pi_browser_bridge/${manifest.background.service_worker}`);
for (const script of manifest.content_scripts || []) {
	for (const item of script.js || []) distFiles.add(`bridge/pi_browser_bridge/${item}`);
}
distFiles.add("bridge/pi_browser_bridge/dist/hook_dispatcher.js");
distFiles.add("bridge/pi_browser_bridge/dist/offscreen.js");
distFiles.add("bridge/pi_browser_bridge/dist/build-manifest.json");
for (const file of [...distFiles]) {
	if (file.endsWith(".js")) distFiles.add(`${file}.map`);
}

for (const file of distFiles) {
	assert(packed.has(file), `npm package must include generated runtime file: ${file}`);
}
assert(packed.has("bridge/pi_browser_bridge/manifest.json"), "npm package must include extension manifest");
assert(packed.has(`bridge/pi_browser_bridge/${EXPECTED_PACKAGE_FACTS.offscreenDocument.value}`), `npm package must include the offscreen transport document (${EXPECTED_PACKAGE_FACTS.offscreenDocument.rationale})`);
assert(packed.has("dist/index.js") && packed.has("dist/index.d.ts"), "npm package must include outer dist entry and declarations");
assert(packed.has("dist/cli/bin.js") && packed.has("dist/cli/index.js"), "npm package must include compiled cli dist entrypoints");
// tsc does not emit .mjs to dist/. The callback-OAST worker is spawned from src/ even when
// the daemon runs from dist (oastWorkerManager rewrites dist/src→src), so the .mjs must ship.
assert(packed.has("src/tools/webSecurity/browserNative/callbackOastWorker.mjs"), "npm package must ship the callback-OAST worker .mjs (resolved from src/ by the dist build)");
assert(packed.has("bridge/pi_browser_bridge/native_command_schema.json"), "npm package must include native command schema");
assert(packed.has("LICENSE"), "npm package must include repository license");
assert(packed.has("SECURITY.md") && packed.has("CONTRIBUTING.md") && packed.has("CODE_OF_CONDUCT.md"), "npm package must include public security, contribution, and conduct guidance");
assert(packed.has("bridge_src/service-worker.ts"), "npm package must include bridge source for portable rebuilds");
assert(packed.has("bridge_src/offscreen/transport.ts"), "npm package must include offscreen transport source for portable rebuilds");
assert(packed.has("scripts/build-bridge.mjs"), "npm package must include bridge build script");
assert(packed.has("scripts/install-git-hooks.mjs"), "npm package must include the portable prepare hook installer");
assert(packed.has("scripts/check-graph.mjs") && packed.has("scripts/check-dag.mjs") && packed.has("scripts/run-check-groups.mjs") && packed.has("scripts/sync-impact-map.mjs") && packed.has("scripts/sync-code-map.mjs") && packed.has("scripts/sync-concept-ownership.mjs") && packed.has("scripts/query-markers.mjs") && packed.has("scripts/new-check.mjs") && packed.has("scripts/workstream-scope.mjs") && packed.has("scripts/sync-docs.mjs") && packed.has("scripts/sync-managed-blocks.mjs") && packed.has("scripts/lib/repo-introspection.mjs") && packed.has("scripts/lib/managed-blocks.mjs"), "npm package must include graph-backed check runners and shared dev-harness helpers");
assert(packed.has("scripts/sync-capture.mjs"), "npm package must include capture sync script");
assert(packed.has("capture-src/entries/scanTemplate.ts") && packed.has("src/capture/generated/scanBundle.ts"), "npm package must include capture source and generated bundles");
assert(packed.has("tests/release/release-local-acceptance.mjs"), "npm package must include local release acceptance script");
assert(packed.has("tests/release/release-portable-acceptance.mjs"), "npm package must include portable release acceptance script");
assert(packed.has("tests/contracts/drift/check-package-files.mjs"), "npm package must include package contract");
assert(packed.has("tests/contracts/drift/abml-core-manifest.js") && packed.has("tests/contracts/drift/expected-package-facts.js") && packed.has("tests/contracts/drift/check-doc-paths.mjs"), "npm package must include shared contract manifests and doc-path gate");
assert(packed.has("skills/browser-pilot/SKILL.md") && packed.has("skills/browser-pilot-cli/SKILL.md"), "npm package must include public browser-pilot skills");
assert(![...packed].some((file) => file.startsWith(".pi/") || file.includes("/node_modules/")), "npm package must not include runtime artifacts or node_modules");
assert(![...packed].some((file) => /^(AGENTS|TODO|CURRENT|ARCHIVE|ROADMAP|WORKSTREAMS_A_E_SUMMARY)\.md$/.test(file)), "npm package must not include local governance planning documents");
assert(![...packed].some((file) => file.startsWith("docs/archive/") || file.startsWith("agent-audits/") || file.startsWith(".plan/") || file.startsWith(".claude/")), "npm package must not include local archive, audit, plan, or assistant-state directories");
assert(![...packed].some((file) => file.startsWith("skills/browser-pilot-audit-fix/") || file.startsWith("skills/browser-pilot-blind-eval/") || file.startsWith("skills/pi-kernel-audit/")), "npm package must not include internal maintainer/audit skills");
assert(![...packed].some((file) => file.startsWith("evals/")), "npm package must not include development evals");
assert(![...packed].some((file) => file.startsWith("bridge/tmwd_cdp_bridge/")), "npm package must not include legacy tmwd bridge sources");
const packedDist = [...packed].filter((file) => file.startsWith("bridge/pi_browser_bridge/dist/"));
assert(packedDist.length > 5, "npm package must include generated dist runtime, not only dist/.gitignore");

for (const file of ["README.md", "AI_INSTALL.md", "CHANGELOG.md"]) {
	const text = read(file);
	assert(text.includes("npm pack --dry-run"), `${file} must document or record package dry-run verification`);
}
assert(read("README.md").includes("npm pack --dry-run --ignore-scripts --json") && read("AI_INSTALL.md").includes("npm pack --dry-run --ignore-scripts --json"), "README and AI_INSTALL must document that check:package uses ignore-scripts to avoid rebuilding dist during npm run check");

console.log("package files contract ok");
