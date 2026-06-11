import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../../src/tools/registerExecuteTool.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const helperStart = source.indexOf("async function executeJavaScriptWithMonitor");
assert(helperStart >= 0, "browser_execute monitor helper must exist");
const helperEnd = source.indexOf("\nexport function registerExecuteTool", helperStart);
const helper = source.slice(helperStart, helperEnd);

assert(helper.includes("Promise<ExecuteResultWithFeedback>")
	&& (source.includes('import type { BrowserBridgeExecutionResult } from "../driver/types"') || source.includes('import type { BrowserBridgeExecutionResult } from "../driver/types.js"')),
	"monitor helper must preserve the BrowserBridgeExecutionResult envelope type");
assert(helper.includes("withExecutionEffect") && helper.includes("server.executeJavaScript(script"), "monitor helper must execute through the normal JS bridge path with default effect collection");
assert(helper.includes("...executed.result") && helper.includes("effect: executed.effect") && helper.includes("monitor:"), "monitor helper must append effect and monitor beside the original execution envelope");
assert(helper.includes("{ url: after.url ?? before.url }"), "monitor helper must retain the page url already read by the monitor scan");
assert(!helper.includes("execution: executed.data"), "monitor helper must not wrap the execution result under execution");
assert(!helper.includes("newTabs: executed.newTabs"), "monitor helper must not move newTabs into monitor metadata");
// Navigation honesty: a script that navigates makes the same-document line diff meaningless (misleading
// changed:0). monitor must flag navigation via the page url change, not present a bare changed:0.
assert(helper.includes("const navigated = !!(before.url && after.url && before.url !== after.url)"), "monitor must detect navigation via before/after page url change");
assert(helper.includes("navigated: true") && helper.includes("urlBefore") && helper.includes("urlAfter"), "monitor must surface navigated + the before/after urls instead of a misleading changed:0");
assert(source.includes("export function executeSummaryPageUrl(value: unknown): string | undefined"), "execute distiller must use a helper for summary page url extraction");
assert(source.includes("effect?.url") && source.includes('["url", "urlAfter", "urlBefore"]'), "execute summary url helper must cover effect url plus monitor fallbacks");
assert(source.includes("const url = executeSummaryPageUrl(value);") && source.includes("...(url ? { url } : {})"), "execute distiller must lift page url into the base summary record");

console.log("execute tool contract ok");
