/**
 * ABML verb runtime contract (P4.2–P4.7 internal gate).
 *
 * Verifies source-level/runtime boundaries for the internal ABML verb runtime:
 * - read uses P3 scan/entity model
 * - click/type use actionability + verification + CDP true input fallback path
 * - scroll does read-after-scroll collection with virtual/stable-stop support
 * - P6 pierce/frame runtime boundaries stay internal and explicit
 * - P7 visual-floor point/region support stays behind runtime helpers
 * - failures are normalized through AbmlError envelopes instead of silent fallbacks
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

const runtimeSrc = read("src/abml/verbs/runtime.ts");
assert(runtimeSrc.includes("summarizeScanData("), "ABML read runtime must reuse P3 scan/entity model");
assert(runtimeSrc.includes("ensureActionability("), "ABML write verbs must run actionability checks");
assert(runtimeSrc.includes("Input.dispatchMouseEvent"), "ABML click runtime must support CDP true mouse input fallback");
assert(runtimeSrc.includes("Input.insertText"), "ABML type runtime must use CDP Input.insertText");
assert(runtimeSrc.includes("verifyClick(") && runtimeSrc.includes("verifyType("), "ABML runtime must perform post-action verification");
assert(runtimeSrc.includes("scrollStepScript(") && runtimeSrc.includes("executeBrowserAbmlRead(") && runtimeSrc.includes("stablePasses"), "ABML scroll runtime must do read-after-scroll collection with virtual-scroll stable-stop");
assert(runtimeSrc.includes("normalizeAbmlError"), "ABML runtime failures must normalize into AbmlError envelopes");
assert(runtimeSrc.includes("executeBrowserAbmlPierce") && runtimeSrc.includes("executeBrowserAbmlFrame"), "ABML runtime must expose internal pierce/frame executors for P6");
assert(runtimeSrc.includes("inspectVisionRegion") || read("src/abml/verbs/visionRuntime.ts").includes("screenshot.capture"), "ABML runtime must keep visual-floor helpers behind screenshot-backed internals for P7");
assert(!runtimeSrc.includes("catch {}"), "ABML runtime must not silently swallow core verb failures with empty catch blocks");
assert(runtimeSrc.includes("transport: \"dom\" | \"cdp\"") && runtimeSrc.includes("domResult = undefined"), "ABML click runtime may explicitly downgrade DOM click failures into documented CDP fallback, not silent success");

const routerSrc = read("src/abml/verbs/router.ts");
assert(routerSrc.includes("actionabilityFailure") && routerSrc.includes("verificationFailure"), "ABML router must expose unified actionability/verification failure helpers");
assert(routerSrc.includes("BACKEND_UNAVAILABLE"), "ABML router must fail closed when a verb handler is missing");

console.log("abml verb runtime ok");
