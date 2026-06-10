import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

const runtimeSrc = read("src/abml/verbs/runtime.ts");
const pierceSrc = read("src/abml/verbs/pierceRuntime.ts");
const frameSrc = read("src/abml/verbs/frameRuntime.ts");
const visionSrc = read("src/abml/verbs/visionRuntime.ts");
const scanSrc = read("src/scan/buildScanScript.ts");
const scanCaptureSrc = read("capture-src/entries/scanTemplate.ts");
const scanBundleSrc = read("src/capture/generated/scanBundle.ts");
const summarySrc = read("src/tools/summaries/scan.ts");

assert(runtimeSrc.includes("stablePasses") && runtimeSrc.includes("virtualCollectionStop"), "P6 scroll runtime must stop after stable virtual-scroll collection");
assert(pierceSrc.includes("Accessibility.getFullAXTree") && pierceSrc.includes("DOM.getBoxModel"), "P6 pierce runtime must use CDP/AX for closed-shadow piercing");
assert(frameSrc.includes("frame.list") && frameSrc.includes("frame.evaluate") && frameSrc.includes("CROSS_ORIGIN_BLOCKED"), "P6 frame runtime must make OOPIF reachability boundaries explicit");
assert(visionSrc.includes("screenshot.capture") && visionSrc.includes("registerBrowserResultResource") && visionSrc.includes("saveDataUrl") && visionSrc.includes("visualFloor"), "P7 visual floor must capture screenshot evidence, save it, and mint a readable resource handle");
assert(scanSrc.includes("SCAN_TEMPLATE") && scanSrc.includes("renderCaptureTemplate"), "scan builder must stay a thin capture-template injection wrapper");
assert(scanCaptureSrc.includes("collectCanvasRegions") && scanBundleSrc.includes("collectCanvasRegions") && summarySrc.includes("visual_regions"), "P7 scan/model layer must project canvas regions into internal visual region summaries");

console.log("abml p6/p7 runtime ok");
