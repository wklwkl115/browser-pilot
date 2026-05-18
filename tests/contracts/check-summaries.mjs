import assert from "node:assert/strict";
import { summarizeEvidenceData, summarizeGenericValue, summarizeHtmlSnapshot, summarizeNetworkData, summarizeScanData } from "../../src/tools/summaries/index.ts";

const scan = summarizeScanData({
	url: "https://example.test",
	title: "Example",
	readyState: "complete",
	content: "<h1>Main</h1>\n<button>Save</button>\n<a href=\"/x\">X</a>\nPlain text",
	node_count: 4,
	iframe_notes: [{ src: "about:blank", accessible: true }],
}, [{ id: 1 }, { id: 2 }]);
assert.deepEqual(Object.keys(scan).sort(), ["actionables", "contentChars", "headings", "iframe_notes", "interactive", "lineCount", "list_hints", "node_count", "readyState", "tabs_count", "textPreview", "text_only", "title", "top_layer", "truncated", "url"].sort(), "check-summaries scan.keys: summary fields must stay stable");
assert.equal(scan.tabs_count, 2);
assert.equal(scan.interactive.length, 2);
assert.equal(scan.headings.length, 1);
assert.deepEqual(scan.actionables.columns, ["index", "tag", "role", "action", "label", "selector", "point", "hitOk"], "check-summaries scan.actionables: GA-style actionables table must be exposed");
assert.deepEqual(scan.list_hints.columns, ["selector", "itemCount", "hiddenCount", "firstItemPreview"], "check-summaries scan.list_hints: GA-style repeated list hints must be exposed");

const html = summarizeHtmlSnapshot("<html><head><title>T</title></head><body><form><input><button>Go</button></form><a href='/'>Home</a></body></html>", { selector: "body", mode: "outer" });
assert.deepEqual(Object.keys(html).sort(), ["chars", "counts", "mode", "original_length", "selector", "textChars", "textPreview", "titles", "truncated"].sort(), "check-summaries html.keys: summary fields must stay stable");
assert.equal(html.counts.buttons, 1);
assert.equal(html.counts.inputs, 1);
assert.equal(html.counts.links, 1);
assert.deepEqual(html.titles, ["T"]);
const noisyHtml = summarizeHtmlSnapshot("<body><h1 data-read-frog-walked='x'>Keep<span class='notranslate read-frog-translated-content-wrapper'><span class='read-frog-translated-block-content'>保留</span></span></h1><p>Real text<span class='immersive-translate-target-translation'>真实文本</span><span class='skiptranslate'>Skip me</span></p><div id='aix-drop-panel'>拖拽到此处完成下载</div><read-frog>Read Frog</read-frog><div id='pi-browser-bridge-ind'>pi_browser_bridge: 已连接</div></body>");
assert.ok(noisyHtml.textPreview.includes("Keep"), "check-summaries html.noise: real content must remain");
assert.equal(noisyHtml.textPreview.includes("拖拽到此处完成下载"), false, "check-summaries html.noise: AIX overlay text must be filtered");
assert.equal(noisyHtml.textPreview.includes("Read Frog"), false, "check-summaries html.noise: Read Frog overlay text must be filtered");
assert.equal(noisyHtml.textPreview.includes("pi_browser_bridge"), false, "check-summaries html.noise: bridge indicator text must be filtered");
assert.equal(noisyHtml.textPreview.includes("保留"), false, "check-summaries html.noise: Read Frog translated text must be filtered");
assert.equal(noisyHtml.textPreview.includes("真实文本"), false, "check-summaries html.noise: translation plugin text must be filtered");
assert.equal(noisyHtml.textPreview.includes("Skip me"), false, "check-summaries html.noise: Google Translate text must be filtered");

const network = summarizeNetworkData({ tabId: 7, sessionId: "s", items: [
	{ requestId: "1", url: "https://api.example.test/users", method: "GET", status: 200, type: "Fetch" },
	{ requestId: "2", url: "https://api.example.test/fail", method: "POST", status: 500, type: "Fetch", errorText: "boom" },
] });
assert.deepEqual(Object.keys(network).sort(), ["active", "bodyBytes", "bodyRef", "bodyTruncated", "condition", "entryCount", "event", "failed", "hostCounts", "methodCounts", "recorder", "samples", "sessionId", "statusCounts", "tabId", "total", "typeCounts", "waitId"].sort(), "check-summaries network.keys: summary fields must stay stable");
assert.equal(network.entryCount, 2);
assert.equal(network.failed.count, 1);
assert.deepEqual(network.failed.columns.slice(0, 4), ["requestId", "method", "status", "type"]);
assert.equal(network.hostCounts[0].key, "api.example.test");
const networkWait = summarizeNetworkData({ condition: "response", event: "response", waitId: "w1", request: { requestId: "3", url: "https://api.example.test/wait", method: "GET", status: 201, type: "Fetch", bodyRef: "b1" }, recorder: { recorderId: "r1", active: true, entries: 1, bodyCount: 1, activeWaitCount: 0 } });
assert.equal(networkWait.entryCount, 1, "check-summaries network.wait.entryCount: request object must be counted");
assert.equal(networkWait.waitId, "w1", "check-summaries network.wait.waitId: wait id must be surfaced");
assert.equal(networkWait.recorder.recorderId, "r1", "check-summaries network.wait.recorder: recorder summary must be compact");

const generic = summarizeGenericValue({ ok: true, data: { html: "x".repeat(2000), rows: Array.from({ length: 20 }, (_, id) => ({ id, value: "v".repeat(500) })) } });
assert.equal(generic.type, "bridgeResult", "check-summaries generic.bridge: bridge envelopes must be recognized");
assert.equal(generic.data.type, "object", "check-summaries generic.data: data object must be summarized");
assert.equal(generic.data.rows.count, 20, "check-summaries generic.array: arrays must expose count");
assert.equal(generic.data.html.truncated, true, "check-summaries generic.string: large strings must be compacted");
assert.equal(JSON.stringify(generic).includes("v".repeat(500)), false, "check-summaries generic.raw: summary must not retain large raw samples");

const evidence = summarizeEvidenceData({ tabId: 9, collected_at: "now", event_types: ["console"], sources: {
	hook_events: { ok: true, data: { events: [{ type: "console.log" }, { type: "console.error" }, { type: "console.log" }], total_available: 3 } },
	network_entries: { ok: true, data: { items: [{ id: 1 }, { id: 2 }], total: 2 } },
} });
assert.deepEqual(Object.keys(evidence).sort(), ["collected_at", "event_types", "source_count", "sources", "tabId"].sort(), "check-summaries evidence.keys: summary fields must stay stable");
assert.equal(evidence.source_count, 2);
assert.equal(evidence.sources.hook_events.events, 3);
assert.equal(evidence.sources.hook_events.eventTypes[0].key, "console.log");
assert.equal(evidence.sources.network_entries.items, 2);

console.log("summary contract ok");
