import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { buildElementActionScript } from "../../src/actions/buildElementActionScript.ts";
import { buildContentScript } from "../../src/content/buildContentScript.ts";
import { buildPickScript } from "../../src/pick/buildPickScript.ts";
import { buildScanScript } from "../../src/scan/buildScanScript.ts";

const root = new URL("../..", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), "utf8");

const scan = buildScanScript({ maxChars: 4_000, includeIframes: true });
new Function(scan);
assert(scan.includes("outputChars"), "page-scripts scan: must track output budget incrementally");
assert(!scan.includes("lines.reduce"), "page-scripts scan: must not recompute line size per push");
assert(scan.includes("pi-browser-bridge-ind") && scan.includes("aix-drop-panel"), "page-scripts scan: must filter known extension noise");

const content = buildContentScript({ selector: "main", maxChars: 4_000, includeLinks: true });
new Function(content);
assert(content.includes("DROP_SELECTOR"), "page-scripts content: must drop noisy nodes");
assert(content.includes("[content truncated]"), "page-scripts content: must bound markdown output");
assert(!content.includes("Readability"), "page-scripts content: must stay dependency-free");

const pick = buildPickScript({ message: "Pick", timeoutMs: 5_000 });
new Function(pick);
assert(pick.includes("data-pi-browser-pick"), "page-scripts pick: overlay must be identifiable");
assert(pick.includes("buildSelector"), "page-scripts pick: must return CSS selectors");
assert(pick.includes("textWithoutNoise") && pick.includes("read-frog-translated"), "page-scripts pick: selected summaries must filter translation plugin noise");
assert(pick.includes("normalizePickedElement"), "page-scripts pick: translation wrapper hits must normalize to a real parent element");

const query = buildElementActionScript({ action: "query", selector: "button", visibleOnly: true, limit: 5 });
new Function(query);
assert(query.includes("structuredError"), "page-scripts actions: must emit structured errors");
assert(query.includes("INVALID_SELECTOR") && query.includes("ELEMENT_NOT_FOUND") && query.includes("ELEMENT_NOT_CLICKABLE") && query.includes("ELEMENT_NOT_TYPEABLE"), "page-scripts actions: must include stable error codes");
assert(query.includes("const summaries = visibleOnly ? nodes.map"), "page-scripts query: visibleOnly must summarize once before filtering");
assert(!query.includes("nodes.filter(function(el) { return summarize"), "page-scripts query: visibleOnly must not call summarize during filter and again during output");
assert(query.includes("redacted password field"), "page-scripts type: password fields must be redacted");

const wait = read("bridge/pi_browser_bridge/wait.js");
assert(wait.includes("textWithoutNoise") && wait.includes("sanitizedOuterHtml") && wait.includes("read-frog-translated"), "page-scripts wait.selector: element snapshots must filter translation plugin noise");
assert(!wait.includes("text:(el.innerText||el.textContent||'').slice"), "page-scripts wait.selector: must not return raw innerText snapshots");
assert(wait.includes("chrome.webNavigation.onCommitted") && wait.includes("chrome.tabs.onUpdated.addListener(onTabsUpdated)") && wait.includes("Page.frameNavigated") && wait.includes("Page.navigatedWithinDocument"), "wait.navigation must register webNavigation/tabs/CDP success listeners instead of timeout-only waiting");
assert(wait.includes("if (!value) return !targetUrl && !urlContains") && !wait.includes("target.startsWith(value)"), "wait.navigation must not match targetUrl against an empty or partial current URL before navigation starts");
assert(wait.includes("const checkCurrent = async (source)") && wait.includes("wait.navigation.currentUrl") && wait.includes("setInterval(() => { void checkCurrent('poll'); }"), "wait.navigation must poll current URL/readyState as a deterministic fallback for missed navigation events");
assert(wait.includes("chrome.webNavigation.onErrorOccurred") && wait.includes("waitForNavigation failed"), "wait.navigation must handle navigation failure events");
assert(wait.includes("target.addEventListener(eventType, handler, true)") && wait.includes("removeEventListener(rec.eventType, rec.handler"), "hook add/removeEventListener must store handlers and remove the real page listener");
assert(wait.includes("const entries = Array.isArray(result?.result?.value) ? result.result.value : []") && wait.includes("data: { entries, entryType, nameContains, count"), "hook.getPerformanceEntries must unwrap Runtime.evaluate result.value into entries");

const exec = read("bridge/pi_browser_bridge/exec.js");
assert(exec.includes("MAX_NODES") && exec.includes("MAX_CHARS") && exec.includes("nodesUsed") && exec.includes("charsUsed"), "page-scripts exec: serializer must have traversal budgets");
assert(exec.includes("LARGE_TEXT_KEYS") && exec.includes("['content', 'markdown', 'html']") && exec.includes("trim(child, MAX_CHARS)"), "page-scripts exec: serializer must not truncate scan/content/html payload fields at nested string defaults");
assert(exec.includes("value instanceof Map") && exec.includes("value instanceof Set") && exec.includes("[Circular]"), "page-scripts exec: serializer must handle rich JS values");
const execSandbox = {};
vm.runInNewContext(exec, execSandbox, { filename: "exec.js" });
const generatedExec = execSandbox.buildExecScript("return 'status smoke class test'", "return {ok:false}");
assert(generatedExec.includes("return charge(String(value || ''), limit);") && !generatedExec.includes("replace(/s+/g, ' ')") && !generatedExec.includes("replace(/\\s+/g, ' ')"), "page-scripts exec: generated serializer must preserve returned string whitespace and not strip lowercase s");

console.log("page script contract ok");
