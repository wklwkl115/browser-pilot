import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

const gitignore = read(".gitignore");
assert(gitignore.includes("/.pi/public-export/"), "nested public-export repos must be ignored so the outer repo stays the only source of truth");

const readme = read("README.md");
assert(readme.includes("`.pi/public-export/` 仅允许作为本地导出/归档产物"), "README must declare .pi/public-export as export-only, not a second source tree");

const current = read("CURRENT.md");
assert(current.includes("唯一正式源码仓库"), "CURRENT.md must lock the outer repo as the only formal source repository");

const pkg = JSON.parse(read("package.json"));
assert.equal(pkg.scripts?.["check:src:types"], "tsc -p tsconfig.json", "package must typecheck outer src/** through tsconfig.json");
assert.equal(pkg.scripts?.["check:registry-drift"], "node tests/contracts/drift/check-registry-drift.mjs", "package must expose registry drift check");
assert(String(pkg.scripts?.["check:all"] || "").includes("check-dag") && String(pkg.scripts?.check || "") === "npm run check:all", `npm run check must route through the DAG closing gate: expected check="npm run check:all" and check:all="node scripts/check-dag.mjs"`);

console.log("registry drift contract ok");
