import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	summarizeBrowserCrawlData,
	summarizeCallbackOastData,
	summarizeCookieAnalyzeData,
	summarizeEvidenceData,
	summarizeFuzzParamsData,
	summarizeFuzzPathsData,
	summarizeFuzzVhostsData,
	summarizeGenericValue,
	summarizeHtmlSnapshot,
	summarizeHttpReplayData,
	summarizeNetworkData,
	summarizeNucleiBridgeData,
	summarizeOrchestrationData,
	summarizeScanData,
	summarizeSqlmapBridgeData,
	summarizeSqliProbeData,
	summarizeTemplateCheckData,
	summarizeWebReconProbeData,
} from "../../src/tools/summaries/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const tableCell = (table, key, row = 0) => table.rows[row][table.columns.indexOf(key)];

function assertWebSecuritySummarySplit() {
	const files = readdirSync(path.join(root, "src/tools/summaries/webSecurity")).filter((file) => file.endsWith(".ts")).sort();
	assert.deepEqual(files, ["bridges.ts", "cookie.ts", "crawl.ts", "fuzz.ts", "index.ts", "oast.ts", "recon.ts", "replay.ts", "shared.ts", "sqli.ts", "template.ts"], "check-summaries webSecurity.split.files: summary layer must be split by capability family");
	const facade = read("src/tools/summaries/webSecurity.ts");
	assert.ok(facade.includes('from "./webSecurity/index"'), "check-summaries webSecurity.facade: legacy webSecurity.ts must re-export the split index");
	assert.ok(facade.split(/\r?\n/).length <= 5, "check-summaries webSecurity.facade.size: legacy webSecurity.ts must stay thin");
	const shared = read("src/tools/summaries/webSecurity/shared.ts");
	assert.ok(shared.includes("redactSensitiveText") && shared.includes("bridgeArtifacts") && shared.includes("bodyPreview"), "check-summaries webSecurity.shared: redact/artifact/body helpers must remain shared");
	const moduleText = files.filter((file) => !["shared.ts", "index.ts"].includes(file)).map((file) => read(`src/tools/summaries/webSecurity/${file}`)).join("\n");
	assert.equal(moduleText.includes("function redactSensitiveText"), false, "check-summaries webSecurity.shared.noDuplicateRedact: capability modules must not duplicate sensitive redact helper");
}

assertWebSecuritySummarySplit();

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
assert.deepEqual(scan.actionables.columns, ["index", "tag", "role", "action", "label", "selector", "point", "hitOk"], "check-summaries scan.actionables: actionables table must be exposed");
assert.deepEqual(scan.list_hints.columns, ["selector", "itemCount", "hiddenCount", "firstItemPreview"], "check-summaries scan.list_hints: repeated list hints must be exposed");

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

const orchestrationSummary = summarizeOrchestrationData({
	action: "apply",
	ok: false,
	orchestrationId: "orch-summary",
	converged: false,
	plan: { operationCount: 0, operationsByPhase: {}, converged: true },
	actual: { observedAt: 1, sessions: [{ tag: "s", tabs: [], cookies: [], sessionAssertions: { mode: "all", passed: false, total: 2, passedCount: 1, failedCount: 1, probeFailedCount: 0, checks: [] } }] },
	failures: [{ code: "ORCHESTRATION_ASSERTION_FAILED", message: "selector assertion is not satisfied", retryable: false }],
	bindings: [],
});
assert.equal(orchestrationSummary.assertionCount, 2, "check-summaries orchestration.assertionCount: assertion totals must stay visible");
assert.equal(orchestrationSummary.assertionPassedCount, 1, "check-summaries orchestration.assertionPassed: passed assertions must stay visible");
assert.equal(orchestrationSummary.assertionFailedCount, 1, "check-summaries orchestration.assertionFailed: failed assertions must stay visible");
assert.equal(orchestrationSummary.assertionProbeFailedCount, undefined, "check-summaries orchestration.assertionProbeFailed: zero probe failures should stay compact");

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


const reconSummary = summarizeWebReconProbeData({ ok: true, results: [{ inputUrl: "https://api.example.test/start", finalUrl: "https://api.example.test/final", status: 200, title: "API", tech: ["nginx", "rails"], fingerprints: [{ label: "rails-session" }], redirects: [{ status: 302 }], body: { bytes: 42, sha256: "body-hash", text: "Cookie: sid=secret\n{\"ok\":true}" }, favicon: { mmh3: "123", simHash64: "sim" }, tlsCertificate: { fingerprint256: "tls-fp" } }] });
assert.equal(reconSummary.hostCounts[0].key, "api.example.test", "check-summaries webSecurity.recon.host: recon summary must keep host evidence");
assert.equal(tableCell(reconSummary.results, "bodySha256"), "body-hash", "check-summaries webSecurity.recon.bodyHash: recon summary must keep body hash");
assert.equal(tableCell(reconSummary.results, "faviconSimHash"), "sim", "check-summaries webSecurity.recon.faviconSimHash: recon summary must keep favicon simHash evidence");
assert.equal(JSON.stringify(reconSummary).includes("sid=secret"), false, "check-summaries webSecurity.recon.redact: recon previews must redact cookies");
assert.ok(JSON.stringify(reconSummary).includes("[redacted]"), "check-summaries webSecurity.recon.redact.marker: redaction marker must stay visible");

const crawlSummary = summarizeBrowserCrawlData({ ok: true, maxDepth: 2, activeGraphqlIntrospection: true, artifactRoot: ".pi/crawl", sourceArchiveCount: 1, pages: [{ url: "https://app.example.test/", status: 200, title: "Home", depth: 0, links: ["/a"], forms: [{}], endpoints: [{}], manifests: ["/manifest.json"], serviceWorkers: ["/sw.js"], sourceMaps: ["/app.js.map"], sourceMapDetails: { sourceCount: 2, archivedSourceCount: 1 }, apiSpec: { kind: "openapi", endpointCount: 3, parameterSummary: { totalParameters: 4, requestBodyFieldCount: 1 } }, graphqlSchema: { typeCount: 5, source: "active" }, serviceWorkerDetails: { cacheRouteCount: 2, versionSummary: { versionTokens: ["v1"] } } }], endpoints: [{ url: "https://app.example.test/api", kind: "openapi", method: "POST", source: "openapi", parameterCount: 4, parameterSummary: { requestBodyFieldCount: 1 }, sourceUrl: "/openapi.json" }] });
assert.equal(crawlSummary.activeGraphqlIntrospection, true, "check-summaries webSecurity.crawl.graphqlActive: active GraphQL behavior flag must stay visible");
assert.equal(crawlSummary.sourceArchiveCount, 1, "check-summaries webSecurity.crawl.sourceArchive: source map archive count must stay visible");
assert.equal(tableCell(crawlSummary.pages, "graphqlSource"), "active", "check-summaries webSecurity.crawl.graphqlSource: GraphQL source must stay visible");
assert.deepEqual(tableCell(crawlSummary.pages, "swVersions"), ["v1"], "check-summaries webSecurity.crawl.swVersions: service worker version tokens must stay visible");
assert.equal(tableCell(crawlSummary.endpoints, "requestBodyFields"), 1, "check-summaries webSecurity.crawl.apiBodyFields: API body field count must stay visible");

const fuzzPathsSummary = summarizeFuzzPathsData({ ok: true, requestCount: 1, results: [{ url: "https://app.example.test/admin", status: 200 }], matched: [{ url: "https://app.example.test/admin", depth: 1, status: 200, title: "Admin", bodyBytes: 10, bodySha256: "hp", differentFromBaseline: true, baselineClusterMatched: false, delta: "status" }], clusters: [{ status: 200, title: "Admin", bodyBytes: 10, count: 1, matchedCount: 1, sampleUrls: ["/admin"] }] });
assert.equal(fuzzPathsSummary.matchedCount, 1, "check-summaries webSecurity.fuzzPaths.matched: matched count must stay visible");
assert.equal(tableCell(fuzzPathsSummary.matched, "delta"), "status", "check-summaries webSecurity.fuzzPaths.delta: delta evidence must stay visible");
const fuzzVhostsSummary = summarizeFuzzVhostsData({ ok: true, results: [{ host: "admin.example.test", status: 200 }], matched: [{ host: "admin.example.test", status: 200, title: "Admin", tlsFingerprint256: "tls", bodySha256: "hv", sniName: "admin.example.test", nearestBaseline: "wildcard", delta: "tls" }] });
assert.equal(tableCell(fuzzVhostsSummary.matched, "tls"), "tls", "check-summaries webSecurity.fuzzVhosts.tls: TLS fingerprint must stay visible");
assert.equal(tableCell(fuzzVhostsSummary.matched, "nearestBaseline"), "wildcard", "check-summaries webSecurity.fuzzVhosts.baseline: nearest baseline must stay visible");
const fuzzParamsSummary = summarizeFuzzParamsData({ ok: true, results: [{ location: "multipart", operation: "set", status: 200, contentTypeVariant: "missing-boundary" }], matched: [{ location: "multipart", paramName: "file", operation: "set", contentTypeVariant: "missing-boundary", value: "x", status: 500, bodySha256: "hf", multipart: { partCount: 2, fileCount: 1, nestedMultipartPartCount: 1 }, delta: "parser", url: "https://app.example.test/upload" }], parserClusters: [{ status: 500, title: "err", bodyBytes: 9, count: 1, matchedCount: 1, contentTypeVariants: ["missing-boundary"], params: ["file"], multipartShapes: ["2/1/1"], repeatedNames: ["file"], nestedMultipartPartCount: 1 }] });
assert.equal(fuzzParamsSummary.parserClusterCount, 1, "check-summaries webSecurity.fuzzParams.parserCluster: parser clusters must stay visible");
assert.equal(tableCell(fuzzParamsSummary.matched, "multipart"), "2/1/1", "check-summaries webSecurity.fuzzParams.multipart: multipart shape must stay visible");

const sqliSummary = summarizeSqliProbeData({ ok: true, requestCount: 2, oracleTypes: ["boolean", "union"], dbmsFingerprints: ["mysql"], results: [{ type: "boolean", paramName: "id", status: 200 }], matched: [{ type: "union", location: "query", paramName: "id", payload: "UNION SELECT", response: { status: 200, bodyBytes: 123 }, dbms: "mysql", columnCount: 3, echoPosition: 2, baselineDistance: 0.9 }], columnHints: [{ location: "query", paramName: "id", orderByMaxValid: 3, unionSelectColumns: 3, confidence: "high" }], echoPositions: [{ location: "query", paramName: "id", columnCount: 3, position: 2 }], extractions: [{ location: "query", paramName: "id", expression: "database()", value: "app", length: 3, attempts: 12, complete: true }] });
assert.deepEqual(sqliSummary.dbmsFingerprints, ["mysql"], "check-summaries webSecurity.sqli.dbms: DBMS fingerprints must stay visible");
assert.equal(tableCell(sqliSummary.columnHints, "unionSelectColumns"), 3, "check-summaries webSecurity.sqli.columnHints: UNION column hints must stay visible");
assert.equal(tableCell(sqliSummary.echoPositions, "position"), 2, "check-summaries webSecurity.sqli.echo: UNION echo position must stay visible");

const sqlmapSummary = summarizeSqlmapBridgeData({ ok: true, launcher: "sqlmap", artifactRoot: ".pi/sqlmap", artifacts: [{ kind: "stdout", label: "stdout", path: ".pi/sqlmap/stdout.log", bytes: 10, lineCount: 1, sha256: "sha" }], runs: [{ index: 0, source: "raw", targetUrl: "https://app.example.test/item?id=1", exitCode: 0, durationMs: 5, vulnerable: true, findingCount: 1, dbmsFingerprints: ["MySQL"], stdoutArtifact: { path: ".pi/sqlmap/stdout.log" }, stderrArtifact: { path: ".pi/sqlmap/stderr.log" } }], findings: [{ runIndex: 0, targetUrl: "https://app.example.test/item?id=1", parameter: "id", place: "GET", type: "boolean", title: "Boolean", payload: "id=1 AND 1=1", dbmsFingerprints: ["MySQL"] }] });
assert.equal(sqlmapSummary.artifactCount, 1, "check-summaries webSecurity.sqlmap.artifacts: bridge artifact count must stay visible");
assert.equal(tableCell(sqlmapSummary.runs, "stdoutArtifact"), ".pi/sqlmap/stdout.log", "check-summaries webSecurity.sqlmap.stdoutArtifact: stdout artifact path must stay visible");
const nucleiSummary = summarizeNucleiBridgeData({ ok: true, launcher: "nuclei", artifacts: [{ kind: "jsonl", label: "matches", path: ".pi/nuclei/matches.jsonl", bytes: 5, lineCount: 1, sha256: "hn" }], runs: [{ index: 0, source: "url", targetUrl: "https://app.example.test", exitCode: 0, matched: true, matchCount: 1, matchSeverities: ["high"], matchTemplateIds: ["exposure/test"], stdoutArtifact: { path: ".pi/nuclei/stdout.log" } }], matches: [{ runIndex: 0, targetUrl: "https://app.example.test", templateId: "exposure/test", templateName: "Exposure", severity: "high", matchedAt: "https://app.example.test/.env", matcherName: "word", extractorName: "token", extractedResults: ["APP_KEY"], requestPreview: "GET /.env" }] });
assert.equal(nucleiSummary.artifactCount, 1, "check-summaries webSecurity.nuclei.artifacts: bridge artifact count must stay visible");
assert.equal(tableCell(nucleiSummary.matches, "extracts")[0], "APP_KEY", "check-summaries webSecurity.nuclei.extracts: extracted evidence must stay visible");

const oastSummary = summarizeCallbackOastData({ ok: true, action: "collect", sessionId: "o1", callbackUrl: "http://127.0.0.1/cb", events: [{ seq: 1, protocol: "http", method: "POST", url: "/cb", matchedCorrelation: true, body: { bytes: 12 }, remoteAddress: "127.0.0.1" }, { seq: 2, protocol: "dns", queryName: "x.oast.test", matchedCorrelation: true, queryBytes: 20 }] });
assert.equal(oastSummary.eventCount, 2, "check-summaries webSecurity.oast.eventCount: callback event count must stay visible");
assert.equal(tableCell(oastSummary.events, "bodyBytes"), 12, "check-summaries webSecurity.oast.bodyBytes: callback body bytes must stay visible");
const templateSummary = summarizeTemplateCheckData({ ok: true, results: [{ templateId: "exposure-env", status: 200 }], matched: [{ templateId: "exposure-env", name: "Env", url: "https://app.example.test/.env", status: 200, title: "", bodyBytes: 20, bodySha256: "ht", checks: [{ matched: true }], extracts: [{ name: "key", value: "APP_KEY" }] }] });
assert.equal(templateSummary.templateCounts[0].key, "exposure-env", "check-summaries webSecurity.template.templateCounts: template counts must stay visible");
assert.equal(tableCell(templateSummary.matched, "extractValues")[0], "APP_KEY", "check-summaries webSecurity.template.extractValues: extractor values must stay visible");

const cookieSummary = summarizeCookieAnalyzeData({ ok: true, inputCount: 1, tokenCount: 1, verifiedTokenCount: 1, claimReplayCount: 1, results: [{ source: "cookie", name: "session", kind: "jwt", valueLength: 120, token: { format: "jwt", alg: "HS256", kid: "kid1", signature: { verified: true }, payload: { role: "user" }, mutation: { token: "mutated" } }, claimReplay: { mutated: { status: 200 } } }], claimReplays: [{ name: "session", format: "jwt", cookieName: "session", mutated: { status: 200 }, baseline: { status: 403 }, delta: "status" }] });
assert.equal(tableCell(cookieSummary.results, "verified"), true, "check-summaries webSecurity.cookie.verified: token verification must stay visible");
assert.deepEqual(tableCell(cookieSummary.results, "claimKeys"), ["role"], "check-summaries webSecurity.cookie.claimKeys: claim keys must stay visible without raw values");
const replaySummary = summarizeHttpReplayData({ ok: true, mode: "sequence", stepCount: 1, variableScope: "sequence", variableNames: ["csrf"], request: { method: "POST", url: "https://app.example.test/api", headerNames: ["Cookie"], bodyBytes: 9, cookiesBound: true, multipart: { partCount: 2, fileCount: 1, fieldCount: 1, nestedMultipartPartCount: 1 } }, response: { status: 200, url: "https://app.example.test/api", headerNames: ["Content-Type"], body: { bytes: 31, sha256: "hr", truncated: false, text: "{\"cookie\":\"sid=secret\"}" }, elapsedMs: 10 }, dependencyGraph: { nodeCount: 1, edgeCount: 1, edgeTypes: [{ key: "cookie", count: 1 }] }, multipartMatrix: { caseCount: 2, truncatedCases: false, fieldNames: ["file"], fileValueCount: 1 }, clusters: [{ status: 200, title: "OK", bodyBytes: 31, count: 1, okCount: 1, sampleSteps: [0] }], steps: [{ index: 0, source: "raw", request: { method: "POST", url: "https://app.example.test/api", multipart: { fileCount: 1 } }, response: { status: 200, body: { bytes: 31 } }, variableScope: "sequence", capturedVariableNames: ["csrf"], persistedVariableNames: ["csrf"], delta: "baseline" }] });
assert.equal(replaySummary.request.cookiesBound, true, "check-summaries webSecurity.replay.cookiesBound: browser cookie binding flag must stay visible");
assert.equal(replaySummary.dependencyGraph.edgeTypes[0].key, "cookie", "check-summaries webSecurity.replay.dependencyGraph: dependency graph edge types must stay visible");
assert.equal(JSON.stringify(replaySummary).includes("sid=secret"), false, "check-summaries webSecurity.replay.redact: replay response previews must redact cookies");

console.log("summary contract ok");
