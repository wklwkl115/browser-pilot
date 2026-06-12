import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

const relevance = read("src/distill-core/relevance.ts");
const tuning = read("src/distill-core/relevanceTuning.ts");
const coreTaps = read("src/distill-core/relevanceTaps.ts");
const toolTaps = read("src/tools/relevanceTaps.ts");
const observe = read("src/tools/observe/scanRunner.ts");
const observeRelevance = read("src/tools/observe/relevanceFusion.ts");
const registerTools = read("src/tools/registerTools.ts");
const relevanceTraceAdapter = read("src/tools/relevanceTraceAdapter.ts");
const ledger = read("src/abml/perceptionLedger.ts");
const scan = read("src/tools/summaries/scan.ts");
const resultMiddleware = read("src/tools/resultMiddleware.ts");
const fact = read("src/distill-core/fact.ts");

assert(relevance.includes("computeRelevanceMap") && relevance.includes("scoreFields"), "relevance kernel must own scoring and expose lookup surfaces");
assert(tuning.includes("RELEVANCE_TUNING") && tuning.includes("assertRelevanceTuningBounds"), "relevance tuning must stay centralized and contract-visible");
assert(coreTaps.includes("extractStringLiteralTerms") && coreTaps.includes("extractUrlTerms"), "pure tap primitives must live in distill-core");
assert(toolTaps.includes("TOOL_RELEVANCE_TAPS") && toolTaps.includes("extractToolRelevanceTerms"), "tool attention extraction must be declarative and table-driven");
assert(registerTools.includes("withRelevanceTraceTap"), "registerTools must install the relevance trace adapter at the registration chokepoint");
assert(relevanceTraceAdapter.includes("extractToolRelevanceTerms") && relevanceTraceAdapter.includes("recordPerceptionTraceTerms"), "toolAdapter registration chokepoint must record relevance trace terms through one adapter");
assert(!/recordPerceptionTraceTerms/.test(read("src/tools/registerExecuteTool.ts")), "browser_execute must not own imperative relevance trace collection");
assert(!/recordPerceptionTraceTerms/.test(read("src/tools/registerArtifactTool.ts")), "browser_artifact must not own imperative relevance trace collection");
assert(observe.includes("buildObserveRelevance") && observeRelevance.includes("computeRelevanceMap") && observe.includes("sortEntitiesBySalience(attributedEntities"), "observe must compute relevance once and feed ABML ordering");
assert(scan.includes("relevanceActionScore") && scan.includes("options.relevance?.scoreFields"), "scan summary action ranking must consume the lookup surface only");
assert(ledger.includes("MAX_FRAMES_PER_SESSION_TAB = 8") && ledger.includes("MAX_TRACE_TERMS_PER_SESSION = 32"), "ledger must cap session frames and trace ring");
assert(resultMiddleware.includes("rendererMarker") && !resultMiddleware.includes("PI_BROWSER_RELEVANCE_DEBUG"), "result envelope must not serialize trace debug terms directly");
assert(/\brelevance\??:/.test(fact) && fact.includes("salience.relevance"), "V6 fact-level relevance must be active once allocateFacts has a production caller");
assert(resultMiddleware.includes("allocateFacts") && resultMiddleware.includes("renderFacts") && resultMiddleware.includes("factRenderingDiagnostics"), "salience renderer must run the production fact allocator path");

// V6 SHADOW-MODE invariant + promotion gate. The production fact allocator currently feeds
// tool-result `details` ONLY (diagnostics), never the agent-facing envelope. Every use of the
// `factRendering` value (excluding its definition/type/assignment) must be on a line that routes
// it into `details`. Promoting the fact path to DRIVE the agent-facing render is the moment the
// three documented promotion preconditions become mandatory and must land in the SAME change:
//   (1) R3 one-rung P-frame arbitration + the two-systems fixture (still gated — cannot be
//       meaningfully tested until the fact path drives granularity);
//   (2) feedback-loop / no-narrowing fixture (PAID early: boost-not-gate set-preservation test in
//       tests/unit/tools/observe-abml-integration.test.ts);
//   (3) byte-level neutral test (PAID early: whole-envelope byte identity in the same file).
// Whoever flips shadow→live must edit this guard, at which point this checklist is in front of them.
const factRenderingUses = resultMiddleware.split("\n").filter((line) => /\bfactRendering\b/.test(line) && !/factRenderingDiagnostics/.test(line) && !/FactRenderingDiagnostics/.test(line));
assert(factRenderingUses.length >= 2, "fact allocator diagnostics must be wired into the tool-result details channel");
for (const line of factRenderingUses) assert(/\bdetails\b/.test(line), `V6 must stay shadow-mode: factRendering may only feed tool-result details, never the agent-facing envelope — promoting it requires landing R3 + the two paid fixtures (see this guard's comment) — offending line: ${line.trim()}`);
assert(!/process\./.test(relevance), "pure relevance kernel must not read runtime env");
assert(!/TOOL_RELEVANCE_TAPS/.test(relevance), "pure relevance kernel must not depend on tool names");

console.log("task-conditioned salience contract ok");
