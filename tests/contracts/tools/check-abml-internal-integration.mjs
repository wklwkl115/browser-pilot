import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

const observe = read("src/tools/observeRunners.ts");
const execute = read("src/tools/registerExecuteTool.ts");
const integration = read("src/abml/verbs/integration.ts");

assert(integration.includes("createBrowserAbmlIntegration") && integration.includes("createBrowserAbmlRuntime"), "ABML integration helper must wrap the browser runtime");
assert(observe.includes("createBrowserAbmlIntegration") && observe.includes("abml.readStructure") && observe.includes("abml: observation.abmlRead") && observe.includes("visualRegionCount") && observe.includes("frameEntityCount"), "browser_observe scan/text runner must integrate ABML read internally and expose richer frame/vision diagnostics");
assert((execute.includes("createBrowserAbmlIntegration") && execute.includes("const abml = await runtime.readStructure") && execute.includes("beforeSource") && execute.includes("afterSource")) || execute.includes("runtime.readStructure"), "browser_execute monitor path must integrate ABML read internally and preserve observable source markers");

console.log("abml internal integration ok");
