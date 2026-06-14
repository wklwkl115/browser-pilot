// ABML collection completeness + continuation contract.
//
// Verifies the pure collection kernel, budget-immune envelope lift, observe/artifact wiring, and
// the hard boundary that this workstream does not add a public scroll/action surface.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCollectionModels } from "../../../src/abml-core/collections.ts";
import { distilledTextResult } from "../../../src/tools/resultMiddleware.ts";
import { PURE_CORE } from "../drift/abml-core-manifest.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readRepo = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");
const st = () => ({ visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true });
const item = (index, setSize = 40) => ({
	ref: `pi-ref://element/result-${index}`,
	kind: "element",
	role: "listitem",
	name: `Result ${index}`,
	state: st(),
	source: "ax",
	structure: { posInSet: index, setSize },
	hints: { containerRole: "list", containerName: "Results" },
});

const collections = buildCollectionModels({
	entities: [1, 2, 3, 4, 5].map((index) => item(index, 40)),
	scanEvidence: {
		rows: Array.from({ length: 30 }, (_, index) => ({ text: `sidebar ${index}` })),
		actionables: [{ role: "button", action: "Next page", disabled: false }],
	},
});

assert.equal(collections.length, 1, "one ARIA-grounded collection model expected");
assert.equal(collections[0].completeness, "virtualized", "declared total larger than observed window must be virtualized");
assert.equal(collections[0].observedCount, 5, "observedCount must come from item entities, not data.rows");
assert.equal(collections[0].declaredTotal, 40);
assert.equal(collections[0].continuation?.kind, "virtual-window");
assert.match(collections[0].continuation?.handle || "", /^pi-cont:\/\/collection\/c1$/, "continuation handle is evidence metadata");

const rowsOnly = buildCollectionModels({
	entities: [],
	scanEvidence: { rows: Array.from({ length: 50 }, (_, index) => ({ text: `nav ${index}` })) },
});
assert.deepEqual(rowsOnly, [], "data.rows alone must not create a semantic collection model");

const growthProbeCollections = buildCollectionModels({
	entities: [1, 2, 3, 4, 5].map((index) => item(index, 5)),
	scanEvidence: {
		growthProbe: { beforeCount: 5, afterCount: 5, beforeFirstText: "Result 1", afterFirstText: "Result 18", windowShifted: true, restoredScrollTop: true },
	},
});
assert.equal(growthProbeCollections[0]?.completeness, "virtualized", "growthProbe window shift must prove a virtualized collection");
assert(growthProbeCollections[0]?.evidence.some((entry) => entry.source === "growthProbe"), "growthProbe must be preserved as collection evidence");

const lifted = await distilledTextResult("body", {
	toolName: "browser_observe",
	command: "scan",
	detailLevel: "summary",
	maxChars: 2_500,
	fallbackName: "observe-scan",
	summary: {
		abmlIntegrated: true,
		collections,
		focus: { primary_entities: Array.from({ length: 20 }, (_, i) => `pi-ref://control/${i}`) },
		textPreview: "x ".repeat(800),
		nextActions: ["read_saved_artifact mode=json jsonPath=data.actionables"],
	},
});
const envelope = JSON.parse(lifted.content[0].text);
assert.equal(envelope.collections?.[0]?.completeness, "virtualized", "collections lift to envelope under tight budget");
assert.equal(envelope.collections?.[0]?.continuation?.handle, "pi-cont://collection/c1");
assert(!JSON.stringify(envelope.nextActions || []).toLowerCase().includes("scroll"), "collection follow-up hints must not tell the agent to scroll");

const pkg = JSON.parse(readRepo("package.json"));
assert.ok(pkg.scripts?.["check:abml-collections"]?.includes("check-abml-collections.mjs"), "check:abml-collections script present");
assert.ok(pkg.scripts?.["check:abml-contracts"]?.includes("check:abml-collections"), "check:abml-contracts includes collections");
assert.ok(PURE_CORE.includes("collections.ts"), "collections classified as pure core");

const registrySrc = readRepo("src/tools/toolRegistry.ts");
assert.ok(!registrySrc.includes("browser_scroll"), "no public browser_scroll tool registered");
assert.ok(!registrySrc.includes("continueCollection"), "no public continuation runtime registered");
const executeSrc = readRepo("src/tools/registerExecuteTool.ts");
assert.ok(!executeSrc.includes("continueCollection"), "browser_execute must not grow a continuation action arm");
const observeSrc = readRepo("src/tools/observe/scanRunner.ts");
assert.ok(observeSrc.includes("buildCollectionModels") && observeSrc.includes("collections"), "scan observe builds and mirrors collections");
assert.ok(observeSrc.includes("growthProbe: record.growthProbe"), "scan observe must pass product growthProbe evidence into collections");
assert.ok(!observeSrc.includes("continueCollection("), "observe must not execute semantic continuation");
const scanSrc = readRepo("src/scan/buildScanScript.ts");
assert.ok(scanSrc.includes("collectGrowthProbe") && scanSrc.includes("restoredScrollTop"), "scan script must produce bounded growthProbe evidence");
const middlewareSrc = readRepo("src/tools/resultMiddleware.ts");
assert.ok(middlewareSrc.includes("envelopeCollections") && middlewareSrc.includes("collections?"), "resultMiddleware lifts collections");

console.log("abml collections ok — pure completeness model + budget-immune perception output + no public scroll/action surface verified");
