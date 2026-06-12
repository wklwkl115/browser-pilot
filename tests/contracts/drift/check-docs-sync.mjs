import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

assert(existsSync(path.join(root, "tests/contracts/drift/check-docs-sync.mjs")), "check:docs-sync scaffold must point at its committed contract file");
assert(readFileSync(path.join(root, "scripts/lib/managed-blocks.mjs"), "utf8").includes("preserveMarkdownTableCells"), "managed block library must preserve hand judgment cells");
const syncDocs = readFileSync(path.join(root, "scripts/sync-docs.mjs"), "utf8");
assert(syncDocs.includes("scripts/sync-concept-ownership.mjs"), "docs:sync must include the concept-ownership field-map generator");
assert(readFileSync(path.join(root, "scripts/sync-concept-ownership.mjs"), "utf8").includes("getDefinedDistillerToolNames"), "concept ownership generator must enumerate registered distiller definitions");
assert(readFileSync(path.join(root, "scripts/sync-concept-ownership.mjs"), "utf8").includes("ScanSummarySchema"), "concept ownership generator must include scan summary as a first-class field map");
execFileSync(process.execPath, ["scripts/sync-docs.mjs", "--check"], { cwd: root, stdio: "inherit" });

console.log("docs sync contract ok");
