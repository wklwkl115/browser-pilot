import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

assert(existsSync(path.join(root, "tests/contracts/drift/check-docs-sync.mjs")), "check:docs-sync scaffold must point at its committed contract file");
assert(readFileSync(path.join(root, "scripts/lib/managed-blocks.mjs"), "utf8").includes("preserveMarkdownTableCells"), "managed block library must preserve hand judgment cells");
const managedBlocksScript = readFileSync(path.join(root, "scripts/sync-managed-blocks.mjs"), "utf8");
assert(managedBlocksScript.includes("governance docs absent") && managedBlocksScript.includes("internal doc absent"), "managed block sync must be inert for internal docs omitted from sanitized public trees");
const syncDocs = readFileSync(path.join(root, "scripts/sync-docs.mjs"), "utf8");
assert(syncDocs.includes("scripts/sync-concept-ownership.mjs"), "docs:sync must include the concept-ownership field-map generator");
const conceptOwnershipScript = readFileSync(path.join(root, "scripts/sync-concept-ownership.mjs"), "utf8");
assert(conceptOwnershipScript.includes("getDefinedDistillerToolNames"), "concept ownership generator must enumerate registered distiller definitions");
assert(conceptOwnershipScript.includes("ScanSummarySchema"), "concept ownership generator must include scan summary as a first-class field map");
assert(conceptOwnershipScript.includes("reference doc absent"), "concept ownership generator must be inert in sanitized public trees that omit internal reference docs");
execFileSync(process.execPath, ["scripts/sync-docs.mjs", "--check"], { cwd: root, stdio: "inherit" });

console.log("docs sync contract ok");
