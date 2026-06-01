import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const pkg = JSON.parse(read("package.json"));
const smoke = read("tests/smoke/smoke-browser-ax-merge.mjs");

assert(pkg.scripts?.["smoke:browser:ax-merge"]?.includes("smoke-browser-ax-merge.mjs"), "package must expose AX merge runtime smoke");
assert(smoke.includes("abml-ax-canvas-aria.html") && smoke.includes("readAxEntities") && smoke.includes("mergeAxIntoDomEntities") && smoke.includes("smoke-browser-ax-merge-results.json"), "AX smoke must use the local canvas+ARIA fixture, read AX entities through the AX runtime adapter, merge DOM/AX entities, and write a dedicated artifact");
const axRuntime = read("src/abml/verbs/axRuntime.ts");
assert(axRuntime.includes("Accessibility.getFullAXTree") && axRuntime.includes("DOM.getBoxModel"), "AX runtime adapter must issue Accessibility.getFullAXTree and DOM.getBoxModel");
assert(read("evals/browser-workflows/fixtures/abml-ax-canvas-aria.html").includes("<canvas") && read("evals/browser-workflows/fixtures/abml-ax-canvas-aria.html").includes("aria-label"), "AX fixture must exercise canvas + ARIA coverage");

console.log("abml ax smoke contract ok");
