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
assert.deepEqual(Object.keys(html).sort(), ["chars", "counts", "mode", "original_bytes", "original_length", "selector", "textChars", "textPreview", "titles", "truncated"].sort(), "check-summaries html.keys: summary fields must stay stable");
assert.equal(html.counts.buttons, 1);
assert.equal(html.counts.inputs, 1);
assert.equal(html.counts.links, 1);
assert.deepEqual(html.titles, ["T"]);
const truncatedHtml = summarizeHtmlSnapshot("<div><a href='/only-visible-after-truncation'>cut", { selector: "#links", mode: "outer", truncated: true, original_length: 1694, original_bytes: 1800, text_length: 500, counts: { links: 3, buttons: 2, inputs: 1, forms: 1, images: 4 }, titles: ["Meta Title"] });
assert.equal(truncatedHtml.counts.links, 3, "check-summaries html.meta.counts: summary must prefer pre-truncation bridge link counts");
assert.equal(truncatedHtml.counts.buttons, 2, "check-summaries html.meta.counts: summary must prefer pre-truncation bridge button counts");
assert.equal(truncatedHtml.counts.images, 4, "check-summaries html.meta.counts: summary must prefer pre-truncation bridge image counts");
assert.equal(truncatedHtml.textChars, 500, "check-summaries html.meta.text_length: summary must prefer pre-truncation text length");
assert.equal(truncatedHtml.original_bytes, 1800, "check-summaries html.meta.original_bytes: summary must retain original byte count");
assert.deepEqual(truncatedHtml.titles, ["Meta Title"], "check-summaries html.meta.titles: summary must prefer bridge titles metadata");
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
assert.deepEqual(Object.keys(network).sort(), ["active", "bodyAvailability", "bodyBytes", "bodyRef", "bodyTruncated", "bodyUnavailableReason", "condition", "entryCount", "event", "failed", "hostCounts", "methodCounts", "recorder", "samples", "sessionId", "statusCounts", "tabId", "total", "typeCounts", "waitId"].sort(), "check-summaries network.keys: summary fields must stay stable");
assert.equal(network.entryCount, 2);
assert.equal(network.failed.count, 1);
assert.deepEqual(network.failed.columns.slice(0, 4), ["requestId", "method", "status", "type"]);
assert.equal(network.hostCounts[0].key, "api.example.test");
const networkWait = summarizeNetworkData({ condition: "response", event: "response", waitId: "w1", request: { requestId: "3", url: "https://api.example.test/wait", method: "GET", status: 201, type: "Fetch", bodyRef: "b1" }, recorder: { tabId: 7, sessionId: "s", recorderId: "r1", active: true, entries: 1, bodyCount: 1, activeWaitCount: 0 } });
assert.equal(networkWait.entryCount, 1, "check-summaries network.wait.entryCount: request object must be counted");
assert.equal(networkWait.waitId, "w1", "check-summaries network.wait.waitId: wait id must be surfaced");
assert.equal(networkWait.recorder.recorderId, "r1", "check-summaries network.wait.recorder: recorder summary must be compact");
assert.equal(networkWait.recorder.tabId, 7, "check-summaries network.wait.recorder.tabId: recorder origin tab must be retained");
assert.equal(networkWait.recorder.sessionId, "s", "check-summaries network.wait.recorder.sessionId: recorder origin session must be retained");
const networkCountWait = summarizeNetworkData({ condition: "count", waitId: "w2", count: 1, required: 1, requests: [{ requestId: "4", url: "https://api.example.test/count", method: "GET", status: 204, type: "Fetch" }] });
assert.equal(networkCountWait.entryCount, 1, "check-summaries network.wait.requests: count wait requests array must be summarized");
assert.equal(networkCountWait.samples.rows[0][0], "4", "check-summaries network.wait.requests.sample: request rows must include matched request id");
const networkStatus = summarizeNetworkData({ tabId: 8, sessionId: "status", active: true, entries: 3, requestCount: 3, bodyCount: 2 });
assert.equal(networkStatus.total, 3, "check-summaries network.status.total: numeric recorder entries must be counted");
assert.equal(networkStatus.entryCount, 3, "check-summaries network.status.entryCount: numeric recorder entries must be surfaced");
const networkBody = summarizeNetworkData({ bodyRef: "b1", bytes: 12, bodyTruncated: false, url: "https://api.example.test/body", status: 200, mimeType: "text/plain" });
assert.equal(networkBody.url, "https://api.example.test/body", "check-summaries network.body.url: body summary must retain source URL");
assert.equal(networkBody.status, 200, "check-summaries network.body.status: body summary must retain response status");
assert.equal(networkBody.mimeType, "text/plain", "check-summaries network.body.mimeType: body summary must retain mime type");
const networkMissingBody = summarizeNetworkData({ requestId: "missing-body", url: "https://api.example.test/body", method: "POST", status: 200, bodyAvailability: "expired", bodyUnavailableReason: "cdp_body_expired" });
assert.equal(networkMissingBody.bodyAvailability, "expired", "check-summaries network.bodyAvailability: missing body diagnostics must be surfaced");
assert.equal(networkMissingBody.bodyUnavailableReason, "cdp_body_expired", "check-summaries network.bodyUnavailableReason: missing body reason must be surfaced");
const networkHar = summarizeNetworkData({ log: { entries: [{ _requestId: "5", request: { url: "https://api.example.test/har", method: "GET" }, response: { status: 200 }, _type: "Fetch" }] }, diagnostics: { tabId: 9, sessionId: "har", recorderId: "r2", active: true, entries: 1, bodyCount: 1, activeWaitCount: 0 } });
assert.equal(networkHar.tabId, 9, "check-summaries network.har.tabId: HAR diagnostics tabId must be retained");
assert.equal(networkHar.sessionId, "har", "check-summaries network.har.sessionId: HAR diagnostics sessionId must be retained");
assert.equal(networkHar.recorder.recorderId, "r2", "check-summaries network.har.recorder: diagnostics recorder must be retained");

const generic = summarizeGenericValue({ ok: true, tabId: 7, target: { source: "explicit", implicit: false }, data: { tabId: 7, frameId: "main", count: 2, html: "x".repeat(2000), rows: Array.from({ length: 20 }, (_, id) => ({ id, value: "v".repeat(500) })) } });
assert.equal(generic.type, "bridgeResult", "check-summaries generic.bridge: bridge envelopes must be recognized");
assert.equal(generic.tabId, 7, "check-summaries generic.metadata.tabId: bridge summaries must lift stable routing metadata");
assert.equal(generic.frameId, "main", "check-summaries generic.metadata.frameId: frame summaries must lift frameId");
assert.equal(generic.count, 2, "check-summaries generic.metadata.count: count must be visible without opening nested data");
assert.equal(generic.targetSource, "explicit", "check-summaries generic.metadata.target: target source must be visible");
assert.equal(generic.data.type, "object", "check-summaries generic.data: data object must be summarized");
assert.equal(generic.data.rows.count, 20, "check-summaries generic.array: arrays must expose count");
assert.equal(generic.data.html.truncated, true, "check-summaries generic.string: large strings must be compacted");
assert.equal(JSON.stringify(generic).includes("v".repeat(500)), false, "check-summaries generic.raw: summary must not retain large raw samples");

const evidence = summarizeEvidenceData({ tabId: 9, collected_at: "now", event_types: ["console"], sources: {
	hook_status: { ok: true, data: { state: "INSTALLED", session_id: "summary-session", installed_at: "2026-05-20T00:00:00.000Z", dispatcher_version: "hook-v1", pi_browser_version: "hook-v1", install_epoch: 12345, buffer_used: 2, stats: { buffer_count: 2 } } },
	hook_events: { ok: true, data: { events: [{ type: "console.log" }, { type: "console.error" }, { type: "console.log" }], total_available: 3 } },
	network_entries: { ok: true, data: { items: [{ id: 1 }, { id: 2 }], total: 2 } },
} });
assert.deepEqual(Object.keys(evidence).sort(), ["collected_at", "event_types", "source_count", "sources", "tabId"].sort(), "check-summaries evidence.keys: summary fields must stay stable");
assert.equal(evidence.source_count, 3);
assert.equal(evidence.sources.hook_status.state, "INSTALLED", "check-summaries evidence.hook_status.state: hook state must stay visible in summary");
assert.equal(evidence.sources.hook_status.session_id, "summary-session", "check-summaries evidence.hook_status.session: hook session id must stay visible in summary");
assert.equal(evidence.sources.hook_status.installed_at, "2026-05-20T00:00:00.000Z", "check-summaries evidence.hook_status.installed: hook install time must stay visible in summary");
assert.equal(evidence.sources.hook_status.dispatcher_version, "hook-v1", "check-summaries evidence.hook_status.dispatcher: dispatcher version must stay visible in summary");
assert.equal(evidence.sources.hook_status.pi_browser_version, "hook-v1", "check-summaries evidence.hook_status.version: pi_browser_version must stay visible in summary");
assert.equal(evidence.sources.hook_status.install_epoch, 12345, "check-summaries evidence.hook_status.epoch: install epoch must stay visible in summary");
assert.equal(evidence.sources.hook_status.buffer_used, 2, "check-summaries evidence.hook_status.buffer_used: buffer usage must stay visible in summary");
assert.equal(evidence.sources.hook_status.buffer_count, 2, "check-summaries evidence.hook_status.buffer_count: buffer count must stay visible in summary");
assert.equal(evidence.sources.hook_events.events, 3);
assert.equal(evidence.sources.hook_events.eventTypes[0].key, "console.log");
assert.equal(evidence.sources.network_entries.items, 2);
assert.equal(evidence.sources.network_entries.total, 2);

console.log("summary contract ok");
