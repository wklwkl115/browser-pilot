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
for (const requiredFilesEntry of ["bridge/", "bridge_src/", "scripts/", "tests/", "src/", "docs/"]) {
	assert(pkg.files?.includes(requiredFilesEntry), `package files must include ${requiredFilesEntry}`);
}

const buildScript = read("scripts/build-bridge.mjs");
assert(buildScript.includes('process.argv.includes("--quiet")'), "build script must support quiet mode for prepack");
assert(buildScript.includes('path.join(distDir, ".npmignore")') && buildScript.includes("include the generated dist runtime"), "build script must generate dist/.npmignore so npm pack does not inherit dist/.gitignore");

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
assert(packed.has("tests/contracts/check-package-files.mjs"), "npm package must include package contract");
assert(![...packed].some((file) => file.startsWith(".pi/") || file.includes("/node_modules/")), "npm package must not include runtime artifacts or node_modules");
const packedDist = [...packed].filter((file) => file.startsWith("bridge/pi_browser_bridge/dist/"));
assert(packedDist.length > 5, "npm package must include generated dist runtime, not only dist/.gitignore");

for (const file of ["README.md", "AI_INSTALL.md", "CHANGELOG.md", "TODO.md"]) {
	const text = read(file);
	assert(text.includes("npm pack --dry-run"), `${file} must document or record package dry-run verification`);
}

console.log("package files contract ok");
