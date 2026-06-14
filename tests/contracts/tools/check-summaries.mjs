import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { distilledJsonResult, distilledTextResult } from "../../../src/tools/resultMiddleware.ts";
import {
	summarizeBrowserCrawlData,
	summarizeCallbackOastData,
	summarizeCookieAnalyzeData,
	summarizeEvidenceData,
	summarizeFuzzParamsData,
	summarizeFuzzPathsData,
	summarizeFuzzVhostsData,
	summarizeGenericValue,
	summarizeHookCollectData,
	summarizeHtmlSnapshot,
	summarizeDomFlowData,
	summarizeHttpReplayData,
	summarizeJsAstAnalysisData,
	summarizeNetworkData,
	summarizeNucleiBridgeData,
	summarizeHookPerformance,
	scanEntitiesForEnvelope,
	summarizeScanData,
	summarizeTransferData,
	summarizeSqlmapBridgeData,
	summarizeSqliProbeData,
	summarizeTemplateCheckData,
	summarizeWasmArtifactData,
	summarizeWebReconProbeData,
	summarizeWsSessionData,
} from "../../../src/tools/summaries/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const tableCell = (table, key, row = 0) => table.rows[row][table.columns.indexOf(key)];
const parseToolText = (result) => JSON.parse(result.content[0].text);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function highEntropyScanFixture() {
	const actionables = Array.from({ length: 30 }, (_, i) => ({
		index: i,
		tag: i % 5 === 0 ? "input" : i % 3 === 0 ? "a" : "button",
		role: i % 5 === 0 ? "textbox" : i % 3 === 0 ? "link" : "button",
		action: i % 5 === 0 ? `field ${i}` : i % 3 === 0 ? `Open item ${i}` : `Submit payment ${i}`,
		label: `Checkout action label ${i} with enough words for scoring`,
		text: `Checkout action text ${i}`,
		selector: `main > section.checkout > div.row-${i} > button.action-${i}`,
		point: { x: 20 + i, y: 80 + i * 20 },
		rect: { x: 20, y: 80 + i * 20, width: 140, height: 32 },
		hitOk: i % 7 !== 0,
		editable: i % 5 === 0,
		clickable: i % 5 !== 0,
		disabled: i % 11 === 0,
		priority: 1000 - i,
		href: i % 3 === 0 ? `https://example.test/item/${i}` : undefined,
		hitTarget: i % 7 === 0 ? { tag: "div", id: `cover-${i}`, text: "modal cover" } : undefined,
	}));
	const list_hints = Array.from({ length: 8 }, (_, i) => ({
		selector: `main > ul.group-${i} > li.entry`,
		itemCount: 12 + i,
		hiddenCount: 8 + i,
		firstItemPreview: `Visible row ${i} with price $${10 + i}`,
		sampleHidden: [`Hidden row ${i} A`, `Hidden row ${i} B`, `Hidden row ${i} C`],
	}));
	const content = [
		"<h1>Checkout</h1>",
		"Status: payment required",
		...actionables.map((actionable) => `<${actionable.tag}>${actionable.label}</${actionable.tag}>`),
		...list_hints.map((hint) => `List ${hint.selector} has ${hint.itemCount} items`),
		"Warning: 5 errors require attention",
		"Total $199.00 usd",
	].join("\n");
	return {
		url: "https://example.test/checkout",
		title: "Checkout",
		readyState: "complete",
		content,
		node_count: 900,
		truncated: true,
		actionables,
		list_hints,
	};
}

function assertWebSecuritySummarySplit() {
	const files = readdirSync(path.join(root, "src/tools/summaries/webSecurity")).filter((file) => file.endsWith(".ts")).sort();
	assert.deepEqual(files, ["bridges.ts", "cookie.ts", "crawl.ts", "domFlow.ts", "fuzz.ts", "index.ts", "jsAst.ts", "oast.ts", "recon.ts", "replay.ts", "shared.ts", "sqli.ts", "template.ts", "wasm.ts", "wasmBridge.ts", "ws.ts"], "check-summaries webSecurity.split.files: summary layer must be split by capability family");
	const facade = read("src/tools/summaries/webSecurity.ts");
	assert.ok(facade.includes('from "./webSecurity/index"') || facade.includes('from "./webSecurity/index.js"'), "check-summaries webSecurity.facade: legacy webSecurity.ts must re-export the split index");
	assert.ok(facade.split(/\r?\n/).length <= 5, "check-summaries webSecurity.facade.size: legacy webSecurity.ts must stay thin");
	const shared = read("src/tools/summaries/webSecurity/shared.ts");
	assert.ok(shared.includes("redactSensitiveText") && shared.includes("bridgeArtifacts") && shared.includes("bodyPreview"), "check-summaries webSecurity.shared: redact/artifact/body helpers must remain shared");
	const moduleText = files.filter((file) => !["shared.ts", "index.ts"].includes(file)).map((file) => read(`src/tools/summaries/webSecurity/${file}`)).join("\n");
	assert.equal(moduleText.includes("function redactSensitiveText"), false, "check-summaries webSecurity.shared.noDuplicateRedact: capability modules must not duplicate sensitive redact helper");
}

assertWebSecuritySummarySplit();

const jsAstSummary = summarizeJsAstAnalysisData({
	input: { mode: "path", path: "fixtures/js-ast-minified.js", fileName: "js-ast-minified.js", bytes: 123, privacy: { localOnly: true, artifactFirst: true } },
	analysis: {
		ok: true,
		parser: "typescript",
		sourceType: "module",
		bytes: 123,
		lines: 4,
		parseDiagnostics: [],
		summary: {
			topLevel: { statementCount: 4, imports: 1, exports: 2, functions: 2, variables: 1, classes: 0 },
			imports: { count: 1, truncated: false, entries: [{ kind: "default+named", from: "./dep.js", specifierCount: 3, localNames: ["x", "a", "beta"] }] },
			exports: { count: 2, truncated: false, entries: [{ kind: "named", names: ["outer"] }, { kind: "default", name: "main" }] },
			functions: { total: 2, truncated: false, entries: [{ name: "outer", kind: "function", params: 1, async: false, generator: false, topLevel: true, line: 1 }] },
			suspicious: {
				evalCalls: 1,
				functionConstructorCalls: 1,
				atobCalls: 1,
				unescapeCalls: 1,
				computedStringArrayAccessCount: 0,
				longStringArrayCount: 0,
				stringDecoderAliasCount: 1,
				objectDispatchAccessCount: 1,
				whileTrueCount: 0,
				switchInLoopCount: 0,
				stringArrayCandidates: { count: 1, truncated: false, entries: [{ name: "arr", length: 4, topLevel: true, sample: ["zero"], line: 1 }] },
				decoderCallCandidates: { count: 1, truncated: false, entries: [{ callee: "alias", count: 2, sampleArgs: ["0"] }] },
				objectDispatchCandidates: { count: 1, truncated: false, entries: [{ name: "dispatch", keyCount: 3, topLevel: true, line: 3 }] }
			},
			reduction: { applied: true, replacementCount: 2, preview: "const x='one'", truncated: false, examples: [{ from: "arr[1]", to: '"one"' }] }
		}
	}
});
assert.equal(jsAstSummary.sourceType, "module", "check-summaries jsAst.sourceType: JS AST summary must expose module/script kind");
assert.equal(jsAstSummary.parseDiagnosticsCount, 0, "check-summaries jsAst.diagnostics: JS AST summary must expose parse diagnostics count");
assert.equal(jsAstSummary.suspicious && typeof jsAstSummary.suspicious === "object", true, "check-summaries jsAst.suspicious: JS AST summary must expose suspicious facts");
assert.equal(Array.isArray(jsAstSummary.nextActions), true, "check-summaries jsAst.nextActions: JS AST summary must suggest bounded artifact-first follow-up");

const domFlowSummary = summarizeDomFlowData("hook.getNodeListeners", {
	data: {
		selector: "#pay",
		node: { tagName: "BUTTON", id: "pay" },
		listeners: [{ type: "click", useCapture: false, passive: true, once: false, handler: { url: "fixture.js", line: 12, column: 3, functionName: "onPay" } }],
		count: 1,
	}
});
assert.equal(domFlowSummary.selector, "#pay", "check-summaries domFlow.selector: DOM flow summary must preserve explicit selector");
assert.equal(domFlowSummary.count, 1, "check-summaries domFlow.count: DOM flow summary must expose listener count");
assert.equal(typeof domFlowSummary.listeners, "object", "check-summaries domFlow.listeners: DOM flow summary must expose compact listener table");
const domFlowHints = summarizeDomFlowData("hook.getSinkHints", {
	data: {
		selector: "#pay",
		node: { tagName: "BUTTON", id: "pay" },
		hints: [{ kind: "inline-handler", eventType: "click", suspicious: true, detail: "innerHTML = value" }],
		sinks: [{ selector: "#sink", innerHTML: "<span>paid</span>", text: "paid" }],
		count: 1,
	}
});
assert.equal(domFlowHints.selector, "#pay", "check-summaries domFlowHints.selector: sink-hint summary must preserve explicit selector");
assert.equal(typeof domFlowHints.hints, "object", "check-summaries domFlowHints.hints: sink-hint summary must expose compact hint table");
assert.equal(typeof domFlowHints.sinks, "object", "check-summaries domFlowHints.sinks: sink-hint summary must expose compact sink table");

const wsSummary = summarizeWsSessionData("ws.collect", {
	session: { sessionId: "ws-fixture", url: "ws://127.0.0.1:9999", state: "open", active: true, transcriptCount: 4, maxTranscript: 20 },
	steps: [{ index: 0, sent: { seq: 2, preview: "ping" }, matched: { entry: { seq: 3, preview: '{"ok":true,"type":"pong"}' } } }],
	events: [
		{ seq: 1, event: "open" },
		{ seq: 2, event: "send", direction: "outbound", bytes: 4, preview: "ping" },
		{ seq: 3, event: "message", direction: "inbound", bytes: 24, preview: '{"ok":true,"type":"pong"}' },
	],
});
assert.equal(wsSummary.sessionId, "ws-fixture", "check-summaries ws.sessionId: WS summary must expose session id");
assert.equal(wsSummary.state, "open", "check-summaries ws.state: WS summary must expose session state");
assert.equal(typeof wsSummary.events, "object", "check-summaries ws.events: WS summary must expose compact transcript table");
assert.equal(typeof wsSummary.replaySteps, "object", "check-summaries ws.replaySteps: WS summary must expose compact replay-step table");
assert.equal(Array.isArray(wsSummary.nextActions), true, "check-summaries ws.nextActions: WS summary must suggest bounded follow-up");

const wasmSummary = summarizeWasmArtifactData({
	input: { path: "fixtures/wasm-minimal.wasm", fileName: "wasm-minimal.wasm", bytes: 65, privacy: { localOnly: true, artifactFirst: true } },
	analysis: {
		ok: true,
		format: "wasm",
		version: 1,
		sha256: "abc",
		sectionCount: 3,
		sections: [{ id: 2, name: "import", bytes: 11, offset: 10 }],
		imports: [{ module: "env", name: "log", kind: "func" }],
		exports: [{ name: "run", kind: "func", index: 1 }],
		counts: { functions: 1, tables: 0, memories: 1, globals: 0, imports: 1, exports: 2 },
	}
});
assert.equal(wasmSummary.format, "wasm", "check-summaries wasm.format: Wasm summary must expose format");
assert.equal(wasmSummary.version, 1, "check-summaries wasm.version: Wasm summary must expose version");
assert.equal(typeof wasmSummary.sections, "object", "check-summaries wasm.sections: Wasm summary must expose compact sections table");
assert.equal(Array.isArray(wasmSummary.nextActions), true, "check-summaries wasm.nextActions: Wasm summary must suggest bounded artifact-first follow-up");

const scan = summarizeScanData({
	url: "https://example.test",
	title: "Example",
	readyState: "complete",
	content: "<h1>Main</h1>\n<button>Save</button>\n<a href=\"/x\">X</a>\nPlain text",
	node_count: 4,
	iframe_notes: [{ src: "about:blank", accessible: true }],
}, [{ id: 1 }, { id: 2 }]);
assert.deepEqual(Object.keys(scan).sort(), ["actionables", "artifact_hints", "contentChars", "focus", "headings", "iframe_notes", "interactive", "lineCount", "list_hints", "node_count", "page", "readyState", "summaryVersion", "tabs_count", "textPreview", "text_only", "title", "top_layer", "truncated", "url"].sort(), "check-summaries scan.keys: summary fields must stay stable");
assert.equal(scan.summaryVersion, 2, "check-summaries scan.version: high-entropy scan summary must expose version 2");
assert.equal(scan.tabs_count, 2);
assert.equal(scan.page.tabs_count, 2, "check-summaries scan.page: compact page manifest must retain tab count");
assert.equal(scan.interactive.length, 2);
assert.equal(scan.headings.length, 1);
assert.deepEqual(scan.actionables.columns, ["index", "tag", "role", "action", "label", "selector", "point", "hitOk", "href", "sameOrigin"], "check-summaries scan.actionables: GA-style actionables table must be exposed (incl. B6 href/sameOrigin)");
// B6: link actionables carry resolved href + same-origin classification so link inventory needs no custom JS.
const linkScan = summarizeScanData({ url: "https://example.test/page", title: "L", readyState: "complete", content: "x", node_count: 1, actionables: [
	{ index: 0, tag: "a", role: "link", selector: "a.in", point: [1, 1], hitOk: true, href: "https://example.test/inside" },
	{ index: 1, tag: "a", role: "link", selector: "a.out", point: [2, 2], hitOk: true, href: "https://other.test/x" },
] }, []);
const linkRows = linkScan.actionables.rows;
const hrefCol = linkScan.actionables.columns.indexOf("href");
const sameCol = linkScan.actionables.columns.indexOf("sameOrigin");
assert.equal(linkRows[0][hrefCol], "https://example.test/inside", "check-summaries scan.actionables.href (B6): resolved link href must be surfaced");
assert.equal(linkRows[0][sameCol], true, "check-summaries scan.actionables.sameOrigin (B6): same-origin link must be classified true");
assert.equal(linkRows[1][sameCol], false, "check-summaries scan.actionables.sameOrigin (B6): cross-origin link must be classified false");
assert.deepEqual(scan.list_hints.columns, ["selector", "itemCount", "hiddenCount", "firstItemPreview"], "check-summaries scan.list_hints: GA-style repeated list hints must be exposed");
assert.equal(scan.artifact_hints.jsonPaths.actionables, "data.actionables", "check-summaries scan.artifactHints: scan summary must provide precise actionables jsonPath");
assert.equal(scan.artifact_hints.jsonPaths.rows, "data.rows", "check-summaries scan.artifactHints.rows (D1): visible-row projection must expose a precise artifact jsonPath");
assert.equal(scan.artifact_hints.jsonPaths.media_candidates, "data.media_candidates", "check-summaries scan.artifactHints.mediaCandidates (B9a): media candidates must expose a precise artifact jsonPath");

const rowScan = summarizeScanData({
	url: "https://example.test/list",
	title: "Rows",
	readyState: "complete",
	content: "rows",
	node_count: 6,
	rows: [
		{ text: "Alpha row", href: "https://example.test/a", sameOrigin: true, rect: { x: 1, y: 10, w: 100, h: 20 }, containerHint: "#list", selector: "#row-a" },
		{ text: "Beta row", href: "https://other.test/b", sameOrigin: false, rect: { x: 1, y: 40, w: 100, h: 20 }, containerHint: "#list", selector: "#row-b" },
	],
}, []);
assert.deepEqual(rowScan.rows.columns, ["text", "href", "sameOrigin", "selector"], "check-summaries scan.rows.columns (D1): visible-row summary must stay compact and mechanical");
assert.equal(rowScan.rows.rows[0][0], "Alpha row", "check-summaries scan.rows.order (D1): visible-row summary must preserve DOM order");
assert.equal(rowScan.rows.rows[1][2], false, "check-summaries scan.rows.sameOrigin (D1): visible-row summary must surface mechanical same-origin classification");
assert.equal(rowScan.rows.rows[1][3], "#row-b", "check-summaries scan.rows.selector (D1): visible-row summary must surface selectors for follow-up reads");

const mediaScan = summarizeScanData({
	url: "https://example.test/gallery",
	title: "Gallery",
	readyState: "complete",
	content: "media",
	node_count: 3,
	media_candidates: [
		{ index: 0, tag: "img", src: "https://example.test/a.jpg", sameOrigin: true, alt: "Alpha image", naturalWidth: 640, naturalHeight: 360, rect: { x: 10, y: 20, w: 320, h: 180 }, selector: "#hero" },
		{ index: 1, tag: "video", src: "https://cdn.example.test/v.mp4", poster: "https://example.test/poster.jpg", sameOrigin: false, videoWidth: 1280, videoHeight: 720, rect: { x: 10, y: 220, w: 320, h: 180 }, selector: "video.feature" },
	],
}, []);
assert.deepEqual(mediaScan.media_candidates.columns, ["tag", "src", "poster", "alt", "sameOrigin", "naturalWidth", "naturalHeight", "selector"], "check-summaries scan.mediaCandidates.columns (B9a): media candidate summary must stay compact and mechanical");
assert.equal(tableCell(mediaScan.media_candidates, "src"), "https://example.test/a.jpg", "check-summaries scan.mediaCandidates.src (B9a): media candidate src must be surfaced");
assert.equal(tableCell(mediaScan.media_candidates, "sameOrigin", 1), false, "check-summaries scan.mediaCandidates.sameOrigin (B9a): media candidate origin must be a mechanical compare");
assert.equal(JSON.stringify(mediaScan.media_candidates).includes("headline"), false, "check-summaries scan.mediaCandidates.boundary (B9a): media candidate list must not grow semantic ranking/headline fields");

const richScanData = {
	url: "https://example.test/checkout",
	title: "Checkout",
	readyState: "complete",
	content: "<h1>Checkout</h1>\nStatus: payment required\n<button>Pay now</button>\n<input name=card value=4111111111111111>\n20 items in cart",
	node_count: 40,
	truncated: true,
	actionables: [
		{ index: 0, tag: "input", role: "textbox", action: "card", label: "4111111111111111", text: "4111111111111111", selector: "#card", point: { x: 100, y: 200 }, hitOk: true, editable: true, disabled: false, priority: 1200 },
		{ index: 1, tag: "button", role: "button", action: "pay", label: "Pay now", selector: "#pay", point: { x: 180, y: 260 }, hitOk: true, clickable: true, disabled: false, priority: 1500 },
		{ index: 2, tag: "button", role: "button", action: "cancel", label: "Cancel", selector: "#cancel", point: { x: 260, y: 260 }, hitOk: false, clickable: true, hitTarget: { tag: "div", id: "modal" }, priority: 800 },
		{ index: 3, tag: "canvas", role: "img", action: "captcha board", label: "Canvas board", selector: "#canvas-board", point: { x: 320, y: 180 }, rect: { x: 260, y: 120, width: 120, height: 120 }, hitOk: true, clickable: true, disabled: false, priority: 900 },
	],
	list_hints: [{ selector: "main > div.cart > div.item", itemCount: 20, hiddenCount: 17, firstItemPreview: "Item 1 $10", sampleHidden: ["Item 4 $40", "Item 5 $50"] }],
};
const richScanEntityContext = {
	browserSessionId: "sess-rich",
	tabId: 3,
	url: "https://example.test/checkout",
	observationId: "scan-rich",
	capturedAt: 1710000000000,
};
const richScan = summarizeScanData(richScanData, [{ id: 1 }], { maxChars: 12_000, entityContext: richScanEntityContext });
const richScanEntities = scanEntitiesForEnvelope(richScanData, { entityContext: richScanEntityContext });
assert.equal(richScan.focus.primary_actions.length >= 2, true, "check-summaries scan.primaryActions: compact high-signal actions must be exposed");
assert.equal(richScan.focus.primary_actions[0].jsonPath.startsWith("data.actionables["), true, "check-summaries scan.primaryActions.path: action summaries must carry artifact jsonPath");
assert.equal(JSON.stringify(richScan.focus.primary_actions).includes("4111111111111111"), false, "check-summaries scan.primaryActions.redactValue: editable summaries must not expose raw input values");
assert.equal(richScan.focus.forms[0].fields.length, 1, "check-summaries scan.forms: editable controls must be summarized as form fields");
assert.equal(richScan.focus.lists[0].more.length, 2, "check-summaries scan.lists: repeated list hints must preserve representative hidden samples");
assert.equal(richScan.focus.text_signals.some((item) => /payment|required|items/i.test(item)), true, "check-summaries scan.textSignals: high-signal status/list lines must replace shallow textPreview dependence");
assert.equal(Array.isArray(richScan.focus.visual_regions), true, "check-summaries scan.visualRegions: internal visual region projections must stay optional but available");
assert.equal(typeof richScan.focus.visual_regions[0], "string", "check-summaries scan.visualRegions: focus visual regions must be refs");
assert.equal(richScanEntities.find((entity) => entity.ref === richScan.focus.visual_regions[0])?.source, "vision", "check-summaries scan.visualRegions.source: canvas region projections must be sourced from vision");
const sidebarDominantScan = summarizeScanData({
	url: "https://example.test/watch",
	title: "Watch",
	readyState: "complete",
	content: "<h1>Watch</h1>\n<input placeholder=\"Search videos\">\n<button>Share</button>",
	node_count: 12,
	actionables: [
		{ index: 0, tag: "button", role: "button", action: "share", label: "Share", selector: "#share", point: { x: 1180, y: 120 }, rect: { x: 1160, y: 100, width: 48, height: 48 }, hitOk: true, clickable: true, priority: 3000, position: "fixed", edgeUtility: true },
		{ index: 1, tag: "button", role: "button", action: "like", label: "Like", selector: "#like", point: { x: 1180, y: 180 }, rect: { x: 1160, y: 160, width: 48, height: 48 }, hitOk: true, clickable: true, priority: 2900, position: "fixed", edgeUtility: true },
		{ index: 2, tag: "button", role: "button", action: "next", label: "Next", selector: "#next", point: { x: 1180, y: 240 }, rect: { x: 1160, y: 220, width: 48, height: 48 }, hitOk: true, clickable: true, priority: 2800, position: "fixed", edgeUtility: true },
		{ index: 3, tag: "input", role: "searchbox", action: "search", label: "Search videos", selector: "#search", point: { x: 240, y: 120 }, rect: { x: 80, y: 100, width: 320, height: 40 }, hitOk: true, editable: true, priority: 200 },
	],
}, []);
assert.equal(sidebarDominantScan.focus.primary_actions[0].jsonPath, "data.actionables[3]", "check-summaries scan.primaryActions.sidebarDominant (B11): edge utility controls must not outrank main page actions");
assert.equal(sidebarDominantScan.actionables.rows.some((row) => row[sidebarDominantScan.actionables.columns.indexOf("selector")] === "#share"), true, "check-summaries scan.actionables.sidebarStillVisible (B11): edge utility controls remain available in full actionables");
const scanBudgetGolden = summarizeScanData(highEntropyScanFixture(), [{ id: 1 }, { id: 2 }], {
	maxChars: 9_000,
	entityContext: {
		browserSessionId: "sess-golden",
		tabId: 7,
		url: "https://example.test/checkout",
		observationId: "scan-golden",
		capturedAt: 1710000000000,
	},
});
const scanBudgetGoldenJson = JSON.stringify(scanBudgetGolden);
assert.equal(scanBudgetGoldenJson.length, 3756, "check-summaries scan.budgetGolden.length: high-entropy scan summary output length must remain byte-shape stable");
assert.equal(sha256(scanBudgetGoldenJson), "122493065afa3bfe94b2fe4914c9414ac5f9a8f15dfd83132e6a96afda07a975", "check-summaries scan.budgetGolden.hash: high-entropy scan summary output must stay byte-for-byte stable before loop refactors");
assert.deepEqual(scanBudgetGolden.summaryOmitted, ["interactive", "textPreview", "media_candidates", "rows"], "check-summaries scan.budgetGolden.omitted: budget retry must land on the same omitted fields");
assert.equal(scanBudgetGolden.focus.primary_actions.length, 3, "check-summaries scan.budgetGolden.primaryActions: final budget rung action count must stay stable");
assert.equal(scanBudgetGolden.actionables.rows.length, 0, "check-summaries scan.budgetGolden.actionRows: final budget rung action rows stay omitted under tight budget");
const scanTmp = await mkdtemp(path.join(os.tmpdir(), "browser-pilot-scan-summary-"));
try {
	const scanEnvelope = parseToolText(await distilledTextResult("scan text", {
		toolName: "browser_observe",
		command: "scan",
		detailLevel: "summary",
		maxChars: 12_000,
		ctx: { cwd: scanTmp },
		fallbackName: "scan-summary.json",
		summary: richScan,
		entities: richScanEntities,
		artifactValue: { data: { content: "x".repeat(9_000), actionables: [{ selector: "#pay" }], list_hints: [] } },
	}));
	assert.ok(scanEnvelope.saved?.path && existsSync(scanEnvelope.saved.path), "check-summaries scan.artifact: large scan result must save raw artifact");
	// H2: nextActions hints now include mode=json so agents can translate directly to a CLI call
	// without knowing that --json-path requires --mode json (blind-eval H2, n=2).
	assert.equal(scanEnvelope.nextActions.some((item) => item.includes("read_saved_artifact") && item.includes("jsonPath=data.actionables") || item.includes("click(pi-ref://") || item.includes("read(pi-ref://")), true, "check-summaries scan.nextActions: artifact or verb follow-up must point directly at actionables evidence");
	assert.equal(scanEnvelope.nextActions.some((item) => item.includes("read_saved_artifact") && item.includes("jsonPath=data.content")), true, "check-summaries scan.nextActions: artifact follow-up must point directly at content jsonPath");
	assert.equal(scanEnvelope.nextActions.filter((item) => item.includes("read_saved_artifact") && item.includes("jsonPath=")).every((item) => item.includes("mode=json")), true, "check-summaries scan.nextActions.mode: every jsonPath artifact follow-up must include mode=json");
} finally {
	await rm(scanTmp, { recursive: true, force: true });
}

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
const noisyHtml = summarizeHtmlSnapshot("<body><h1 data-read-frog-walked='x'>Keep<span class='notranslate read-frog-translated-content-wrapper'><span class='read-frog-translated-block-content'>保留</span></span></h1><p>Real text<span class='immersive-translate-target-translation'>真实文本</span><span class='skiptranslate'>Skip me</span></p><div id='aix-drop-panel'>拖拽到此处完成下载</div><read-frog>Read Frog</read-frog><div id='browser-pilot-bridge-ind'>pi_browser_bridge: 已连接</div></body>");
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
assert.deepEqual(Object.keys(network).sort(), ["active", "artifact_hints", "bodyAvailability", "bodyBytes", "bodyRef", "bodyTruncated", "bodyUnavailableReason", "condition", "entryCount", "event", "failed", "hostCounts", "methodCounts", "recorder", "samples", "sessionId", "statusCounts", "tabId", "total", "typeCounts", "waitId"].sort(), "check-summaries network.keys: summary fields must stay stable");
// N1: artifact-read hints must be data-rooted (resolve against the SAVED bridge-result artifact whose
// root is {id,tabId,data,…}), matching scan's `data.content`. Previously emitted bare `items` → notFound.
assert.equal(network.artifact_hints.preferredReads[0].jsonPath, "data.items", "check-summaries network.artifactHints (N1): entries hint must be data-rooted (data.items) to resolve in the saved artifact");
assert.equal(network.artifact_hints.preferredReads.every((r) => typeof r.jsonPath !== "string" || r.jsonPath.startsWith("data.")), true, "check-summaries network.artifactHints (N1): every network read hint must be data-rooted");
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
const networkEnvelope = parseToolText(await distilledJsonResult({ data: { requestId: "missing-body", url: "https://api.example.test/body", method: "POST", status: 200, bodyAvailability: "expired", bodyUnavailableReason: "cdp_body_expired" } }, { toolName: "browser_network", command: "network.body", detailLevel: "summary", maxChars: 4_000, fallbackName: "network-body.json" }));
assert.equal(networkEnvelope.diagnostics.bodyUnavailableReason, "cdp_body_expired", "check-summaries envelope.diagnostics.network: body unavailable reason must be promoted");
assert.equal(networkEnvelope.nextActions.some((item) => item.includes("inspect network body") || item.includes("read_saved_artifact")), true, "check-summaries envelope.nextActions.network: network body recovery hint must be present");
assert.equal(networkEnvelope.nextActions.filter((item) => item.includes("read_saved_artifact") && item.includes("jsonPath=")).every((item) => item.includes("mode=json")), true, "check-summaries envelope.nextActions.correlationMode: correlation jsonPath follow-ups must include mode=json");
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
assert.equal(generic.selectionVersionAtDispatch, undefined, "check-summaries generic.metadata.selectionVersion: absent selection versions must stay absent");
assert.equal(generic.data.type, "object", "check-summaries generic.data: data object must be summarized");
assert.equal(generic.data.rows.projection, "folded-v1", "check-summaries generic.array.projection: large homogeneous bridge-result arrays must use distill-core folded projection");
assert.equal(generic.data.rows.count, 20, "check-summaries generic.array: arrays must expose count");
assert.equal(generic.data.rows.frontier.retrieve.jsonPath, "data.rows", "check-summaries generic.array.frontier: projected arrays must keep artifact retrieval path");
assert.equal(generic.data.html.truncated, true, "check-summaries generic.string: large strings must be compacted");
assert.equal(JSON.stringify(generic).includes("v".repeat(500)), false, "check-summaries generic.raw: summary must not retain large raw samples");

// F1 regression (real-agent blind eval, n=3 incl. a skill-guided run): a SMALL structured return value
// must be inlined VERBATIM in the summary — never collapsed to {type,count/keyCount} shape placeholders
// that hide the agent's own data and force a second browser_artifact round-trip.
const smallReturn = summarizeGenericValue({ ok: true, tabId: 3, data: { count: 2, rows: [{ id: "A-1", item: "Keyboard", amount: 89 }, { id: "A-2", item: "Monitor", amount: 240 }] } });
assert.equal(smallReturn.data.count, 2, "check-summaries generic.inline.count: a small return must expose its data verbatim");
assert.equal(Array.isArray(smallReturn.data.rows), true, "check-summaries generic.inline.rows: small nested arrays must stay arrays, not {type:array} placeholders");
assert.equal(smallReturn.data.rows.length, 2, "check-summaries generic.inline.len: small nested arrays must keep every element, not 5 samples");
assert.equal(smallReturn.data.rows[1].item, "Monitor", "check-summaries generic.inline.value: nested item VALUES must be present verbatim (no {type,keyCount} collapse)");
const smallString = summarizeGenericValue({ ok: true, data: "x".repeat(280) });
assert.equal(smallString.data, "x".repeat(280), "check-summaries generic.inline.string: a small string return must be shown in full, not truncated to a preview");

const evidence = summarizeEvidenceData({ tabId: 9, collected_at: "now", event_types: ["console"], sources: {
	hook_status: { ok: true, data: { state: "INSTALLED", session_id: "summary-session", installed_at: "2026-05-20T00:00:00.000Z", dispatcher_version: "hook-v1", pi_browser_version: "hook-v1", install_epoch: 12345, buffer_used: 2, stats: { buffer_count: 2 } } },
	hook_events: { ok: true, data: { events: [{ type: "console.log" }, { type: "console.error" }, { type: "console.log" }], total_available: 3 } },
	network_entries: { ok: true, data: { items: [{ id: 1 }, { id: 2 }], total: 2 } },
} });
assert.deepEqual(Object.keys(evidence).sort(), ["artifact_hints", "collected_at", "event_types", "source_count", "sources", "tabId"].sort(), "check-summaries evidence.keys: summary fields must stay stable");
// N1-class: evidence saved artifact is the bridge result (root {id,tabId,data,…}); the hint must be
// data-rooted (data.sources) to resolve, matching scan/network. Bare `sources` resolved to notFound.
assert.equal(evidence.artifact_hints.preferredReads[0].jsonPath, "data.sources", "check-summaries evidence.artifactHints: sources hint must be data-rooted (data.sources) to resolve in the saved artifact");
assert.equal(evidence.source_count, 3);
assert.equal(evidence.sources.hook_status.state, "INSTALLED", "check-summaries evidence.hook_status.state: hook state must stay visible in summary");

// H3: browser_hook collect must surface event types/counts + a compact sample + a data-rooted hint,
// instead of collapsing the events array to opaque {type,keyCount} stubs (blind-eval R7).
const hookCollect = summarizeHookCollectData({ sessionId: "h", total: 3, dropped: 0, events: [
	{ seq: 1, type: "console.log", args: ["hello", { a: 1 }] },
	{ seq: 2, type: "storage.set", key: "k", value: "v", storage: "localStorage" },
	{ seq: 3, type: "console.log", args: ["again"] },
] });
assert.equal(hookCollect.total, 3, "check-summaries hook.collect (H3): total must be surfaced");
assert.equal(hookCollect.eventTypes.find((t) => t.key === "console.log")?.count, 2, "check-summaries hook.collect (H3): event-type counts must be surfaced inline");
assert.equal(hookCollect.samples.rows[1][2], "k", "check-summaries hook.collect (H3): per-event sample must carry a salient detail (storage key)");
assert.equal(hookCollect.artifact_hints.preferredReads[0].jsonPath, "data.events", "check-summaries hook.collect (H3): events hint must be data-rooted (data.events)");

// B8: standalone browser_hook getPerformanceEntries must surface initiatorType counts + a compact
// resource/ms sample, instead of collapsing the resource-timing array to {type,keyCount} stubs.
// (The multi-source evidence AGGREGATE stays counts-only by design — its data.sources hint drills in —
// so it does not exceed the token-economy budget.)
const perf = summarizeHookPerformance({ total: 2, entries: [
	{ name: "https://cdn.example.test/a/app.js", initiatorType: "script", duration: 12.7 },
	{ name: "https://example.test/api/data", initiatorType: "fetch", duration: 4.2 },
] });
assert.equal(perf.total, 2, "check-summaries hook.performance (B8): total must be surfaced");
assert.equal(perf.initiatorTypes.find((t) => t.key === "script")?.count, 1, "check-summaries hook.performance (B8): initiatorType counts must be surfaced");
const perfResourceCol = perf.samples.columns.indexOf("resource");
assert.match(String(perf.samples.rows[0][perfResourceCol]), /app\.js/, "check-summaries hook.performance (B8): sample must carry a compact resource name");
assert.equal(perf.artifact_hints.preferredReads[0].jsonPath, "data.entries", "check-summaries hook.performance (B8): hint must be data-rooted (data.entries)");

// B9b: a media/image download completing with a text/html (anti-bot) body must surface a mimeMismatch.
const mismatch = summarizeTransferData({ data: { downloadId: 9, download: { id: 9, state: "complete", path: "C:/dl/x.jpg", mime: "text/html", finalUrl: "https://site.test/x.jpg" }, mimeMismatch: { expected: "image", actual: "text/html", note: "anti-bot html" } } });
assert.ok(mismatch.mimeMismatch, "check-summaries transfer.mimeMismatch (B9b): mismatch must be surfaced at summary top level");
assert.equal(mismatch.mimeMismatch.actual, "text/html");
assert.equal(mismatch.lines.some((l) => /mime mismatch/i.test(l)), true, "check-summaries transfer.mimeMismatch (B9b): a human line must flag the mismatch");
const okDownload = summarizeTransferData({ data: { downloadId: 8, download: { id: 8, state: "complete", path: "C:/dl/x.png", mime: "image/png" } } });
assert.equal(okDownload.mimeMismatch, undefined, "check-summaries transfer.mimeMismatch (B9b): a matching download must not flag a mismatch");
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
assert.equal(Array.isArray(reconSummary.nextActions), true, "check-summaries webSecurity.recon.nextActions: recon summary must expose bounded follow-up hints");

const crawlSummary = summarizeBrowserCrawlData({ ok: true, maxDepth: 2, activeGraphqlIntrospection: true, artifactRoot: ".pi/crawl", sourceArchiveCount: 1, pages: [{ url: "https://app.example.test/", status: 200, title: "Home", depth: 0, links: ["/a"], forms: [{}], endpoints: [{}], manifests: ["/manifest.json"], serviceWorkers: ["/sw.js"], sourceMaps: ["/app.js.map"], sourceMapDetails: { sourceCount: 2, archivedSourceCount: 1, manifestPath: ".pi/crawl/source-maps/source-map-abc/manifest.json" }, apiSpec: { kind: "openapi", endpointCount: 3, parameterSummary: { totalParameters: 4, requestBodyFieldCount: 1 } }, graphqlSchema: { typeCount: 5, source: "active" }, serviceWorkerDetails: { cacheRouteCount: 2, versionSummary: { versionTokens: ["v1"] } } }], endpoints: [{ url: "https://app.example.test/api", kind: "openapi", method: "POST", source: "openapi", parameterCount: 4, parameterSummary: { requestBodyFieldCount: 1 }, sourceUrl: "/openapi.json" }] });
assert.equal(crawlSummary.activeGraphqlIntrospection, true, "check-summaries webSecurity.crawl.graphqlActive: active GraphQL behavior flag must stay visible");
assert.equal(crawlSummary.sourceArchiveCount, 1, "check-summaries webSecurity.crawl.sourceArchive: source map archive count must stay visible");
assert.equal(crawlSummary.sourceMapManifestCount, 1, "check-summaries webSecurity.crawl.sourceMapManifestCount: source map manifest count must stay visible");
assert.equal(tableCell(crawlSummary.sourceMapManifests, "manifestPath"), ".pi/crawl/source-maps/source-map-abc/manifest.json", "check-summaries webSecurity.crawl.sourceMapManifestPath: manifest path must stay visible");
assert.ok(crawlSummary.artifact_hints?.preferredReads?.some((item) => item.kind === "source-map-details"), "check-summaries webSecurity.crawl.sourceMapArtifactHints: source map details must expose preferred reads");
assert.equal(tableCell(crawlSummary.pages, "graphqlSource"), "active", "check-summaries webSecurity.crawl.graphqlSource: GraphQL source must stay visible");
assert.deepEqual(tableCell(crawlSummary.pages, "swVersions"), ["v1"], "check-summaries webSecurity.crawl.swVersions: service worker version tokens must stay visible");
assert.equal(tableCell(crawlSummary.endpoints, "requestBodyFields"), 1, "check-summaries webSecurity.crawl.apiBodyFields: API body field count must stay visible");
assert.equal(Array.isArray(crawlSummary.nextActions), true, "check-summaries webSecurity.crawl.nextActions: crawl summary must expose bounded follow-up hints");

const fuzzPathsSummary = summarizeFuzzPathsData({ ok: true, requestCount: 1, results: [{ url: "https://app.example.test/admin", status: 200 }], matched: [{ url: "https://app.example.test/admin", depth: 1, status: 200, title: "Admin", bodyBytes: 10, bodySha256: "hp", differentFromBaseline: true, baselineClusterMatched: false, delta: "status" }], clusters: [{ status: 200, title: "Admin", bodyBytes: 10, count: 1, matchedCount: 1, sampleUrls: ["/admin"] }] });
assert.equal(fuzzPathsSummary.matchedCount, 1, "check-summaries webSecurity.fuzzPaths.matched: matched count must stay visible");
assert.equal(tableCell(fuzzPathsSummary.matched, "delta"), "status", "check-summaries webSecurity.fuzzPaths.delta: delta evidence must stay visible");
assert.equal(Array.isArray(fuzzPathsSummary.nextActions), true, "check-summaries webSecurity.fuzzPaths.nextActions: fuzz path summary must expose bounded follow-up hints");
const fuzzVhostsSummary = summarizeFuzzVhostsData({ ok: true, results: [{ host: "admin.example.test", status: 200 }], matched: [{ host: "admin.example.test", status: 200, title: "Admin", tlsFingerprint256: "tls", bodySha256: "hv", sniName: "admin.example.test", nearestBaseline: "wildcard", delta: "tls" }] });
assert.equal(tableCell(fuzzVhostsSummary.matched, "tls"), "tls", "check-summaries webSecurity.fuzzVhosts.tls: TLS fingerprint must stay visible");
assert.equal(tableCell(fuzzVhostsSummary.matched, "nearestBaseline"), "wildcard", "check-summaries webSecurity.fuzzVhosts.baseline: nearest baseline must stay visible");
assert.equal(Array.isArray(fuzzVhostsSummary.nextActions), true, "check-summaries webSecurity.fuzzVhosts.nextActions: fuzz vhost summary must expose bounded follow-up hints");
const fuzzParamsSummary = summarizeFuzzParamsData({ ok: true, results: [{ location: "multipart", operation: "set", status: 200, contentTypeVariant: "missing-boundary" }], matched: [{ location: "multipart", paramName: "file", operation: "set", contentTypeVariant: "missing-boundary", value: "x", status: 500, bodySha256: "hf", multipart: { partCount: 2, fileCount: 1, nestedMultipartPartCount: 1 }, delta: "parser", url: "https://app.example.test/upload" }], parserClusters: [{ status: 500, title: "err", bodyBytes: 9, count: 1, matchedCount: 1, contentTypeVariants: ["missing-boundary"], params: ["file"], multipartShapes: ["2/1/1"], repeatedNames: ["file"], nestedMultipartPartCount: 1 }] });
assert.equal(fuzzParamsSummary.parserClusterCount, 1, "check-summaries webSecurity.fuzzParams.parserCluster: parser clusters must stay visible");
assert.equal(tableCell(fuzzParamsSummary.matched, "multipart"), "2/1/1", "check-summaries webSecurity.fuzzParams.multipart: multipart shape must stay visible");
assert.equal(Array.isArray(fuzzParamsSummary.nextActions), true, "check-summaries webSecurity.fuzzParams.nextActions: fuzz param summary must expose bounded follow-up hints");

const sqliSummary = summarizeSqliProbeData({ ok: true, requestCount: 2, oracleTypes: ["boolean", "union"], dbmsFingerprints: ["mysql"], results: [{ type: "boolean", paramName: "id", status: 200 }], matched: [{ type: "union", location: "query", paramName: "id", payload: "UNION SELECT", response: { status: 200, bodyBytes: 123 }, dbms: "mysql", columnCount: 3, echoPosition: 2, baselineDistance: 0.9 }], columnHints: [{ location: "query", paramName: "id", orderByMaxValid: 3, unionSelectColumns: 3, confidence: "high" }], echoPositions: [{ location: "query", paramName: "id", columnCount: 3, position: 2 }], extractions: [{ location: "query", paramName: "id", expression: "database()", value: "app", length: 3, attempts: 12, complete: true }] });
assert.deepEqual(sqliSummary.dbmsFingerprints, ["mysql"], "check-summaries webSecurity.sqli.dbms: DBMS fingerprints must stay visible");
assert.equal(tableCell(sqliSummary.columnHints, "unionSelectColumns"), 3, "check-summaries webSecurity.sqli.columnHints: UNION column hints must stay visible");
assert.equal(tableCell(sqliSummary.echoPositions, "position"), 2, "check-summaries webSecurity.sqli.echo: UNION echo position must stay visible");
assert.equal(Array.isArray(sqliSummary.nextActions), true, "check-summaries webSecurity.sqli.nextActions: sqli summary must expose bounded follow-up hints");

const sqlmapSummary = summarizeSqlmapBridgeData({ ok: true, launcher: "sqlmap", artifactRoot: ".pi/sqlmap", artifacts: [{ kind: "stdout", label: "stdout", path: ".pi/sqlmap/stdout.log", bytes: 10, lineCount: 1, sha256: "sha" }], runs: [{ index: 0, source: "raw", targetUrl: "https://app.example.test/item?id=1", exitCode: 0, durationMs: 5, vulnerable: true, findingCount: 1, dbmsFingerprints: ["MySQL"], stdoutArtifact: { path: ".pi/sqlmap/stdout.log" }, stderrArtifact: { path: ".pi/sqlmap/stderr.log" } }], findings: [{ runIndex: 0, targetUrl: "https://app.example.test/item?id=1", parameter: "id", place: "GET", type: "boolean", title: "Boolean", payload: "id=1 AND 1=1", dbmsFingerprints: ["MySQL"] }] });
assert.equal(sqlmapSummary.artifactCount, 1, "check-summaries webSecurity.sqlmap.artifacts: bridge artifact count must stay visible");
assert.equal(tableCell(sqlmapSummary.runs, "stdoutArtifact"), ".pi/sqlmap/stdout.log", "check-summaries webSecurity.sqlmap.stdoutArtifact: stdout artifact path must stay visible");
assert.equal(Array.isArray(sqlmapSummary.nextActions), true, "check-summaries webSecurity.sqlmap.nextActions: sqlmap summary must expose bounded follow-up hints");
const nucleiSummary = summarizeNucleiBridgeData({ ok: true, launcher: "nuclei", artifacts: [{ kind: "jsonl", label: "matches", path: ".pi/nuclei/matches.jsonl", bytes: 5, lineCount: 1, sha256: "hn" }], runs: [{ index: 0, source: "url", targetUrl: "https://app.example.test", exitCode: 0, matched: true, matchCount: 1, matchSeverities: ["high"], matchTemplateIds: ["exposure/test"], stdoutArtifact: { path: ".pi/nuclei/stdout.log" } }], matches: [{ runIndex: 0, targetUrl: "https://app.example.test", templateId: "exposure/test", templateName: "Exposure", severity: "high", matchedAt: "https://app.example.test/.env", matcherName: "word", extractorName: "token", extractedResults: ["APP_KEY"], requestPreview: "GET /.env" }] });
assert.equal(nucleiSummary.artifactCount, 1, "check-summaries webSecurity.nuclei.artifacts: bridge artifact count must stay visible");
assert.equal(tableCell(nucleiSummary.matches, "extracts")[0], "APP_KEY", "check-summaries webSecurity.nuclei.extracts: extracted evidence must stay visible");
assert.equal(Array.isArray(nucleiSummary.nextActions), true, "check-summaries webSecurity.nuclei.nextActions: nuclei summary must expose bounded follow-up hints");

const oastSummary = summarizeCallbackOastData({ ok: true, action: "collect", sessionId: "o1", callbackUrl: "http://127.0.0.1/cb", events: [{ seq: 1, protocol: "http", method: "POST", url: "/cb", matchedCorrelation: true, body: { bytes: 12 }, remoteAddress: "127.0.0.1" }, { seq: 2, protocol: "dns", queryName: "x.oast.test", matchedCorrelation: true, queryBytes: 20 }] });
assert.equal(oastSummary.eventCount, 2, "check-summaries webSecurity.oast.eventCount: callback event count must stay visible");
assert.equal(tableCell(oastSummary.events, "bodyBytes"), 12, "check-summaries webSecurity.oast.bodyBytes: callback body bytes must stay visible");
assert.equal(Array.isArray(oastSummary.nextActions), true, "check-summaries webSecurity.oast.nextActions: callback summary must expose bounded follow-up hints");
const templateSummary = summarizeTemplateCheckData({ ok: true, results: [{ templateId: "exposure-env", status: 200 }], matched: [{ templateId: "exposure-env", name: "Env", url: "https://app.example.test/.env", status: 200, title: "", bodyBytes: 20, bodySha256: "ht", checks: [{ matched: true }], extracts: [{ name: "key", value: "APP_KEY" }] }] });
assert.equal(templateSummary.templateCounts[0].key, "exposure-env", "check-summaries webSecurity.template.templateCounts: template counts must stay visible");
assert.equal(tableCell(templateSummary.matched, "extractValues")[0], "APP_KEY", "check-summaries webSecurity.template.extractValues: extractor values must stay visible");
assert.equal(Array.isArray(templateSummary.nextActions), true, "check-summaries webSecurity.template.nextActions: template summary must expose bounded follow-up hints");

const cookieSummary = summarizeCookieAnalyzeData({ ok: true, inputCount: 1, tokenCount: 1, verifiedTokenCount: 1, claimReplayCount: 1, results: [{ source: "cookie", name: "session", attributes: { domain: ".example.test", path: "/", secure: true, httpOnly: true, sameSite: "lax", session: false, expirationDate: 2_000_000_000 }, kind: "jwt", valueLength: 120, token: { format: "jwt", alg: "HS256", kid: "kid1", signature: { verified: true }, payload: { role: "user" }, mutation: { token: "mutated" } }, claimReplay: { mutated: { status: 200 } } }], claimReplays: [{ name: "session", format: "jwt", cookieName: "session", mutated: { status: 200 }, baseline: { status: 403 }, delta: "status" }] });
assert.equal(tableCell(cookieSummary.results, "domain"), ".example.test", "check-summaries webSecurity.cookie.domain: browser cookie attributes must be visible");
assert.equal(tableCell(cookieSummary.results, "path"), "/", "check-summaries webSecurity.cookie.path: browser cookie path must be visible");
assert.equal(tableCell(cookieSummary.results, "secure"), true, "check-summaries webSecurity.cookie.secure: browser cookie secure flag must be visible");
assert.equal(tableCell(cookieSummary.results, "httpOnly"), true, "check-summaries webSecurity.cookie.httpOnly: browser cookie httpOnly flag must be visible");
assert.equal(tableCell(cookieSummary.results, "sameSite"), "lax", "check-summaries webSecurity.cookie.sameSite: browser cookie sameSite must be visible");
assert.equal(tableCell(cookieSummary.results, "verified"), true, "check-summaries webSecurity.cookie.verified: token verification must stay visible");
assert.deepEqual(tableCell(cookieSummary.results, "claimKeys"), ["role"], "check-summaries webSecurity.cookie.claimKeys: claim keys must stay visible without raw values");
assert.equal(Array.isArray(cookieSummary.nextActions), true, "check-summaries webSecurity.cookie.nextActions: cookie summary must expose bounded follow-up hints");
const replaySummary = summarizeHttpReplayData({ ok: true, mode: "sequence", stepCount: 1, variableScope: "sequence", variableNames: ["csrf"], request: { method: "POST", url: "https://app.example.test/api", headerNames: ["Cookie", "X-XSRF-TOKEN"], bodyBytes: 9, cookiesBound: true, csrfReflected: { cookie: "XSRF-TOKEN", header: "X-XSRF-TOKEN" }, multipart: { partCount: 2, fileCount: 1, fieldCount: 1, nestedMultipartPartCount: 1 } }, response: { status: 200, url: "https://app.example.test/api", headerNames: ["Content-Type"], body: { bytes: 31, sha256: "hr", truncated: false, text: "{\"cookie\":\"sid=secret\"}" }, elapsedMs: 10 }, dependencyGraph: { nodeCount: 1, edgeCount: 1, edgeTypes: [{ key: "cookie", count: 1 }] }, multipartMatrix: { caseCount: 2, truncatedCases: false, fieldNames: ["file"], fileValueCount: 1 }, clusters: [{ status: 200, title: "OK", bodyBytes: 31, count: 1, okCount: 1, sampleSteps: [0] }], steps: [{ index: 0, source: "raw", request: { method: "POST", url: "https://app.example.test/api", multipart: { fileCount: 1 } }, response: { status: 200, body: { bytes: 31 } }, variableScope: "sequence", capturedVariableNames: ["csrf"], persistedVariableNames: ["csrf"], delta: "baseline" }] });
assert.equal(replaySummary.request.cookiesBound, true, "check-summaries webSecurity.replay.cookiesBound: browser cookie binding flag must stay visible");
assert.equal(replaySummary.request.csrfReflected.cookie, "XSRF-TOKEN", "check-summaries webSecurity.replay.csrfReflected.cookie: reflected CSRF cookie name must stay visible (C1)");
assert.equal(replaySummary.request.csrfReflected.header, "X-XSRF-TOKEN", "check-summaries webSecurity.replay.csrfReflected.header: reflected CSRF header name must stay visible (C1)");
assert.equal(replaySummary.dependencyGraph.edgeTypes[0].key, "cookie", "check-summaries webSecurity.replay.dependencyGraph: dependency graph edge types must stay visible");
assert.equal(JSON.stringify(replaySummary).includes("sid=secret"), false, "check-summaries webSecurity.replay.redact: replay response previews must redact cookies");
assert.equal(Array.isArray(replaySummary.nextActions), true, "check-summaries webSecurity.replay.nextActions: replay summary must expose bounded follow-up hints");
const replayEnvelope = parseToolText(await distilledJsonResult(replaySummary, { toolName: "browser_http_replay", command: "http.replay", detailLevel: "summary", maxChars: 6_000, fallbackName: "replay.json", distill: () => replaySummary }));
assert.equal(replayEnvelope.diagnostics.entryCount, undefined, "check-summaries envelope.diagnostics.replay: unrelated network fields must not be invented");
assert.equal(replayEnvelope.limits.requestCount, undefined, "check-summaries envelope.limits.replay: absent limits must remain absent");
const contentEnvelope = parseToolText(await distilledTextResult("# T", { toolName: "browser_observe", command: "content", detailLevel: "summary", maxChars: 3_000, fallbackName: "content.json", summary: { url: "https://example.test", markdownChars: 3, empty: true } }));
assert.equal(contentEnvelope.target.url, "https://example.test", "check-summaries envelope.target.content: URL must be promoted to target metadata");
assert.equal(contentEnvelope.diagnostics.warnings.includes("empty_result"), true, "check-summaries envelope.diagnostics.content: empty extraction must be diagnosable");
const correlationEnvelope = parseToolText(await distilledJsonResult({ ok: true, data: { requestId: "req-123", waitId: "wait-123", sourceMode: "scan" }, target: { source: "explicit", implicit: false, browserSessionId: "default", selectionVersionAtDispatch: 7, selectionVersionAtResolve: 8 } }, { toolName: "browser_execute", command: "javascript", detailLevel: "summary", maxChars: 4_000, fallbackName: "correlation.json", operation: { operationId: "op-123", snapshotId: "snap-123", sourceMode: "scan" } }));
assert.equal(correlationEnvelope.correlation.operationId, "op-123", "check-summaries envelope.correlation.operationId: operationId must be promoted for cross-tool evidence linkage");
assert.equal(correlationEnvelope.correlation.snapshotId, "snap-123", "check-summaries envelope.correlation.snapshotId: snapshotId must be promoted for cross-tool evidence linkage");
assert.equal(correlationEnvelope.correlation.requestId, "req-123", "check-summaries envelope.correlation.requestId: requestId must be promoted for cross-tool evidence linkage");
assert.equal(correlationEnvelope.correlation.waitId, "wait-123", "check-summaries envelope.correlation.waitId: waitId must be promoted for cross-tool evidence linkage");
assert.equal(correlationEnvelope.target.selectionVersionAtDispatch, 7, "check-summaries envelope.target.selectionDispatch: selectionVersionAtDispatch must be promoted to target metadata");
assert.equal(correlationEnvelope.target.selectionVersionAtResolve, 8, "check-summaries envelope.target.selectionResolve: selectionVersionAtResolve must be promoted to target metadata");
assert.equal(correlationEnvelope.diagnostics.sourceMode, "scan", "check-summaries envelope.diagnostics.sourceMode: sourceMode must be diagnosable");

// F2: when a summary overflows the budget even after compaction and falls to the scalar-identity
// fallback, the last-resort `preview` must stay a small ORIENTATION snippet (the real model lives in
// the lifted top-level fields + artifact) — not the multi-KB re-dump blob that "drowned the answer".
const fatSummary = { url: "https://x.test", title: "T", ...Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`field_${i}`, i])) };
const overflow = parseToolText(await distilledJsonResult({ data: {} }, { toolName: "browser_observe", command: "scan", detailLevel: "summary", maxChars: 50_000, fallbackName: "scan-overflow.json", distill: () => fatSummary }));
if (typeof overflow.summary?.preview === "string") {
	assert.ok(overflow.summary.preview.length <= 800, `check-summaries F2.previewCap: overflow fallback preview must stay a bounded orientation snippet (≤800), got ${overflow.summary.preview.length}`);
}
assert.ok(!JSON.stringify(overflow).includes("[Circular]"), "check-summaries F2.noCircular: budget-fallback envelope must not emit [Circular] placeholders");

console.log("summary contract ok");
