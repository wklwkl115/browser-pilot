// ABML mechanism arm — M2b P1/P2 semantic ref-anchor contract.
//
// Verifies pure candidate derivation and shadow-ref stability only. Ref minting must remain
// untouched: resourceStore/stableRefIdForDescriptor must not consume these anchors in this phase.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveSemanticRefAnchors, semanticRefAnchorHashInput } from "../../../src/abml-core/semanticRefAnchor.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readRepo = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");
const st = () => ({ visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true });
const item = (ref, name, index, o = {}) => ({
	ref,
	kind: o.kind || "control",
	role: o.role || "link",
	...(name !== undefined ? { name } : {}),
	state: st(),
	source: "ax",
	structure: { posInSet: index, setSize: o.setSize || 8 },
	hints: { containerRole: o.container || "list", containerName: o.containerName || "Products" },
});
const list = (names, prefix) => names.map((name, i) => item(`pi-ref://control/${prefix}${i}`, name, i + 1));
const descriptor = { kind: "control", owner: { tabId: 7, topLevelOrigin: "https://example.test" }, documentEpoch: { url: "https://example.test/catalog", capturedAt: 1000 } };
const hash = (input) => createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 24);

const unique = deriveSemanticRefAnchors(list(["Alpha", "Bravo", "Charlie", "Delta"], "u"));
assert.equal(unique.highConfidenceCount, 4, "unique names should produce high-confidence candidates");
assert.equal(unique.mintingEligibleCount, 4, "unique high-confidence anchors are the only minting candidates");
assert.equal(unique.anchors.find((candidate) => candidate.anchor.name === "Bravo")?.anchor.containerRole, "list");

const duplicate = deriveSemanticRefAnchors(list(["Item", "Item", "Item", "Item"], "d"));
assert.equal(duplicate.highConfidenceCount, 0, "duplicate names must not be high-confidence");
assert.equal(duplicate.lowConfidenceCount, 4, "duplicate names remain low-confidence candidates for diagnostics/diff only");
assert.equal(duplicate.mintingEligibleCount, 0, "duplicate names are never minting-eligible in M2b");
assert.equal(duplicate.anchors[0].anchor.reason, "duplicate-name");

const unnamed = deriveSemanticRefAnchors(list([undefined, undefined, undefined, undefined], "n"));
assert.equal(unnamed.highConfidenceCount, 0, "unnamed instances must not be high-confidence");
assert.equal(unnamed.lowConfidenceCount, 4, "unnamed positional instances stay low-confidence");
assert.equal(semanticRefAnchorHashInput(descriptor, unnamed.anchors[0].anchor), undefined, "low-confidence anchor must not create a shadow hash input");

const tooSmall = deriveSemanticRefAnchors(list(["Alpha", "Bravo", "Charlie"], "s"));
assert.equal(tooSmall.anchors.length, 0, "non-template groups below MIN_TEMPLATE_INSTANCES get no anchors");

const beforeBravo = deriveSemanticRefAnchors(list(["Alpha", "Bravo", "Charlie", "Delta"], "b")).anchors.find((candidate) => candidate.anchor.name === "Bravo")?.anchor;
const afterBravo = deriveSemanticRefAnchors(list(["Charlie", "Alpha", "Bravo", "Delta", "Echo"], "a")).anchors.find((candidate) => candidate.anchor.name === "Bravo")?.anchor;
assert.ok(beforeBravo && afterBravo, "Bravo anchor must exist before and after reorder/insert");
const beforeInput = semanticRefAnchorHashInput(descriptor, beforeBravo);
const afterInput = semanticRefAnchorHashInput(descriptor, afterBravo);
assert.deepEqual(beforeInput, afterInput, "shadow input must be stable across reorder/insert");
assert.equal(hash(beforeInput), hash(afterInput), "shadow hash must be stable across reorder/insert");

const resourceStoreSrc = readRepo("src/resources/resourceStore.ts");
assert.ok(resourceStoreSrc.includes("function stableRefIdForDescriptor"), "resourceStore still owns ref minting");
assert.equal(resourceStoreSrc.includes("semanticRefAnchor"), false, "M2b P1/P2 must not wire semantic anchors into resourceStore/ref minting");
assert.equal(resourceStoreSrc.includes("abml-template"), false, "M2b P1/P2 must not feed template anchors into stableRefIdForDescriptor");
const boundarySrc = readRepo("tests/contracts/drift/check-abml-core-boundary.mjs");
assert.ok(boundarySrc.includes('"semanticRefAnchor.ts"'), "semanticRefAnchor is classified as pure core");
const pkg = JSON.parse(readRepo("package.json"));
assert.ok(pkg.scripts?.["check:abml-semantic-ref-anchor"]?.includes("check-abml-semantic-ref-anchor.mjs"), "check:abml-semantic-ref-anchor script present");

console.log("abml semantic-ref-anchor ok — M2b P1/P2 pure candidates + stable shadow inputs verified; ref minting untouched");
