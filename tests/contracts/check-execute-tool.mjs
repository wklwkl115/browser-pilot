import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../src/tools/registerExecuteTool.ts", import.meta.url), "utf8");
const helperStart = source.indexOf("async function executeJavaScriptWithMonitor");
assert(helperStart >= 0, "browser_execute monitor helper must exist");
const helperEnd = source.indexOf("\nexport function registerExecuteTool", helperStart);
const helper = source.slice(helperStart, helperEnd);

assert(helper.includes("Promise<BrowserBridgeExecutionResult & { monitor: MonitorMetadata }>")
	&& source.includes('import type { BrowserBridgeExecutionResult } from "../driver/types"'),
	"monitor helper must preserve the BrowserBridgeExecutionResult envelope type");
assert(helper.includes("const executed = await server.executeJavaScript"), "monitor helper must execute through the normal JS bridge path");
assert(helper.includes("return {\n\t\t...executed,\n\t\tmonitor:"), "monitor helper must append monitor beside the original execution envelope");
assert(!helper.includes("execution: executed.data"), "monitor helper must not wrap the execution result under execution");
assert(!helper.includes("newTabs: executed.newTabs"), "monitor helper must not move newTabs into monitor metadata");

console.log("execute tool contract ok");
