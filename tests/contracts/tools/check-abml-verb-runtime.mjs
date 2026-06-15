/**
 * ABML verb runtime contract (internal gate).
 *
 * ABML is perception-only. The runtime keeps read (P3 scan/entity model), pierce/frame (P6
 * shadow/OOPIF reachability), and the P7 visual floor. The click/type/scroll ACTUATOR verbs were
 * removed: orphaned after the B2 public action arm revert (no production caller ever dispatched
 * them — integration.ts only exposes read), and real-agent checks confirmed agents actuate via
 * browser_execute, never needing an internal actuator. This contract now LOCKS that removal so a
 * Phase-4-style "continuation runtime" cannot silently re-add a page actuator behind the
 * perception layer.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

const runtimeSrc = read("src/abml/verbs/runtime.ts");

// Perception verbs that stay.
assert(runtimeSrc.includes("summarizeScanData("), "ABML read runtime must reuse P3 scan/entity model");
assert(runtimeSrc.includes("executeBrowserAbmlPierce") && runtimeSrc.includes("executeBrowserAbmlFrame"), "ABML runtime must expose internal pierce/frame executors for P6");
assert(runtimeSrc.includes("inspectVisionRegion") || read("src/abml/verbs/visionRuntime.ts").includes("screenshot.capture"), "ABML runtime must keep visual-floor helpers behind screenshot-backed internals for P7");
assert(runtimeSrc.includes("normalizeAbmlError"), "ABML runtime failures must normalize into AbmlError envelopes");
assert(!runtimeSrc.includes("catch {}"), "ABML runtime must not silently swallow core verb failures with empty catch blocks");

// Actuator lock: click/type/scroll were removed and must not return.
assert(
	!runtimeSrc.includes("executeBrowserAbmlClick") && !runtimeSrc.includes("executeBrowserAbmlType") && !runtimeSrc.includes("executeBrowserAbmlScroll"),
	"ABML must stay perception-only: no click/type/scroll executor may live in the runtime (actuator-removal workstream; agents actuate via browser_execute / browser_command)",
);
assert(
	!runtimeSrc.includes('cmd: "input.pointer"') && !runtimeSrc.includes('cmd: "input.keys"'),
	"ABML runtime must not inject synthetic CDP pointer/keyboard input — page actuation is browser_execute / browser_command's job, not ABML's",
);

const routerSrc = read("src/abml-core/verbs/router.ts"); // pure-core kernel (re-export shim at src/abml/verbs/router.ts)
assert(routerSrc.includes("actionabilityFailure") && routerSrc.includes("verificationFailure"), "ABML router must keep unified actionability/verification failure helpers");
assert(!routerSrc.includes("dispatchAbmlVerb"), "ABML router must not keep an unused strategy-shaped dispatcher");
assert(
	!routerSrc.includes("AbmlClickInput") && !routerSrc.includes("AbmlTypeInput") && !routerSrc.includes("AbmlScrollInput"),
	"ABML router must not declare click/type/scroll verb input types (actuator verbs removed)",
);

console.log("abml verb runtime ok");
