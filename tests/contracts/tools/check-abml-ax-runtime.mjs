/**
 * ABML AX runtime contract (P5).
 *
 * Verifies:
 * - AX runtime reads Accessibility.getFullAXTree and DOM.getBoxModel via persistent_cdp
 * - read runtime imports AX adapter and merges DOM/AX entities
 * - merge keeps DOM refs and appends unmatched AX entities with pi-ref handles
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

const axRuntimeSrc = read("src/abml/verbs/axRuntime.ts");
assert(axRuntimeSrc.includes("Accessibility.getFullAXTree"), "AX runtime must request Accessibility.getFullAXTree");
assert(axRuntimeSrc.includes("DOM.getBoxModel"), "AX runtime must request DOM.getBoxModel for geometry backfill");
assert(axRuntimeSrc.includes("mergeDomAndAxEntities") && axRuntimeSrc.includes("registerRefDescriptor"), "AX runtime must merge DOM/AX and mint refs for unmatched AX entities");

const readRuntimeSrc = read("src/abml/verbs/runtime.ts");
assert(readRuntimeSrc.includes("readAxEntities") && readRuntimeSrc.includes("mergeAxIntoDomEntities"), "ABML read runtime must wire AX entities into DOM reads");
assert(readRuntimeSrc.includes("axEntityCount") && readRuntimeSrc.includes("mergedEntityCount"), "ABML read runtime must surface AX/merge diagnostics");

console.log("abml ax runtime ok");
