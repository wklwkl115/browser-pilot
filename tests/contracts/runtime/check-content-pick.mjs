import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildContentScript } from "../../../src/content/buildContentScript.ts";
import { buildPickCleanupScript, buildPickScript } from "../../../src/pick/buildPickScript.ts";
import { assertBridgeCommandSucceeded } from "../../../src/tools/bridgeResultValidation.ts";
import { evaluatePageScriptDirect } from "../../../src/tools/pageScriptEvaluation.ts";
import { distilledTextResult } from "../../../src/tools/resultMiddleware.ts";
import { summarizeContentData, summarizePickData } from "../../../src/tools/summaries/index.ts";

const root = new URL("../../..", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), "utf8");

const contentScript = buildContentScript({ selector: "main", maxChars: 1234, includeLinks: true });
new Function(contentScript);
assert(contentScript.includes("article, main"), "browser_content must prefer article/main readable roots");
assert(contentScript.includes("DROP_SELECTOR"), "browser_content must drop noisy/non-content nodes");
assert(contentScript.includes("read-frog-translated") && contentScript.includes("immersive-translate"), "browser_content must drop translation plugin wrappers");
assert(contentScript.includes("[content truncated]"), "browser_content must bound extracted markdown");
assert(contentScript.includes("includeLinks"), "browser_content must support link-preserving markdown");
assert(contentScript.includes("SELECTOR_NOT_FOUND") && contentScript.includes("INVALID_SELECTOR") && !contentScript.includes("throw new Error('browser_observe content selector not found"), "browser_observe content selector failures must return stable structured errors instead of thrown generic errors");
assert(contentScript.includes("empty,"), "browser_content must expose empty extraction state instead of forcing a generic tool error");
assert(!contentScript.includes("Readability"), "browser_content must not depend on Readability in page script");

const pickScript = buildPickScript({ message: "Pick submit", multiple: true, timeoutMs: 30_000 });
new Function(pickScript);
assert(pickScript.includes("data-browser-pilot-pick"), "browser_pick must mark its overlay for cleanup/debugging");
assert(pickScript.includes("buildSelector"), "browser_pick must build CSS selectors");
assert(pickScript.includes("Cmd/Ctrl+click"), "browser_pick must expose multi-select guidance");
assert(pickScript.includes("read-frog-translated") && pickScript.includes("immersive-translate"), "browser_pick must drop translation plugin wrappers from selected summaries");
assert(pickScript.includes("textWithoutNoise") && pickScript.includes("cleanupClone") && pickScript.includes("isNoiseAttr"), "browser_pick must sanitize text/html/attributes with shared noise rules");
assert(pickScript.includes("normalizePickedElement"), "browser_pick must normalize translation wrapper hits to a real parent element");
assert(pickScript.includes("pagehide") && pickScript.includes("beforeunload") && pickScript.includes("finished"), "browser_pick must settle and cleanup when the page unloads before user interaction");
assert(pickScript.includes("__piBrowserActivePickers") && pickScript.includes("__piBrowserPickCleanup"), "browser_pick must expose a page-side cleanup handle for TS-owned focus:false deadlines");
assert(pickScript.includes("Runtime.evaluate") === false, "browser_pick page script must stay transport-agnostic");
const pickCleanupScript = buildPickCleanupScript("contract-pick");
new Function(pickCleanupScript);
assert(pickCleanupScript.includes("active_cleanup") && pickCleanupScript.includes("[data-browser-pilot-pick]"), "browser_pick cleanup script must call active cleanup and remove stale overlays as fallback");

const contentSummary = summarizeContentData({ url: "https://example.test", title: "T", rootTag: "main", empty: false, markdown: "# T\nBody", headings: ["T"], stats: { markdownChars: 8, textChars: 4, links: 1, images: 0, paragraphs: 1, headings: 1, truncated: false } });
assert.equal(contentSummary.url, "https://example.test", "content summary must surface URL");
assert.equal(contentSummary.markdownChars, 8, "content summary must surface markdown size");
assert.equal(contentSummary.empty, false, "content summary must surface empty state");

const pickSummary = summarizePickData({ message: "Pick", selectedCount: 1, selectors: ["#go"], selections: [{ selector: "#go", tag: "button", text: "Go", rect: { x: 1 } }] });
assert.deepEqual(pickSummary.selectors, ["#go"], "pick summary must surface selectors");
assert.equal(pickSummary.selections.rows[0][pickSummary.selections.columns.indexOf("tag")], "button", "pick summary must include compact element info");

const pkg = JSON.parse(read("package.json"));
assert(!Object.keys(pkg.dependencies || {}).some((name) => /puppeteer|readability|turndown|jsdom/i.test(name)), "browser_pick/content must not add Puppeteer/Readability/Turndown/JSDOM runtime deps");
assert(read("src/tools/registerPickTool.ts").includes("Runtime.evaluate"), "browser_pick must use CDP Runtime.evaluate for interactive await");
const registerPickToolSource = read("src/tools/registerPickTool.ts");
assert(registerPickToolSource.includes("PICK_FOCUS_FALSE_CDP_GRACE_MS") && registerPickToolSource.includes("Promise.race") && registerPickToolSource.includes("cleanupPick"), "browser_pick focus:false must race the user deadline and actively cleanup instead of surfacing CDP timeout");
assert(registerPickToolSource.includes("buildTimedOutPickResult") && registerPickToolSource.includes('reason: "timeout"') && registerPickToolSource.includes("void rawPromise.catch"), "browser_pick focus:false must return structured timeout and absorb late CDP completion/rejection");
const bridgeResultValidationSource = read("src/tools/bridgeResultValidation.ts");
assert(bridgeResultValidationSource.includes("suppressErrorStack(error)"), "bridge ok:false errors must use non-throwing stack suppression");
assert(!bridgeResultValidationSource.includes("delete error.stack"), "bridge ok:false errors must not use strict-mode delete on Error.stack");
const observeRunnerSource = read("src/tools/observe/scanRunner.ts");
const contentRunnerSource = read("src/tools/observe/contentRunner.ts");
const observeCommonSource = read("src/tools/observe/common.ts");
const toolAdapterSource = read("src/tools/toolAdapter.ts");
function usesTextDistillation(source) {
	return source.includes("distilledTextResult") || (source.includes("textToolResult") && toolAdapterSource.includes("distilledTextResult"));
}
assert(usesTextDistillation(`${observeRunnerSource}\n${contentRunnerSource}`), "browser_observe must use text distillation for observation text modes");
assert(contentRunnerSource.includes("executeBrowserWaitWithSupervisor") && !contentRunnerSource.includes("server.sendCommand({ cmd: \"wait.navigateAndWait\""), "browser_observe content URL navigation must use the TS wait supervisor instead of direct bridge wait.navigateAndWait");
assert(contentRunnerSource.includes("assertBridgeCommandSucceeded(navigation, \"wait.navigateAndWait\")"), "browser_observe content must fail when URL navigation returns ok:false instead of extracting the old page");
assert(contentRunnerSource.includes("navigation: navigationData") || contentRunnerSource.includes("navigation: result.navigationData"), "browser_observe content must preserve wait supervisor navigation metadata in tool details");
assert(observeCommonSource.includes("MIN_CONTENT_TIMEOUT_MS = 100") && contentRunnerSource.includes("normalizeContentTimeoutMs(params.timeoutMs)"), "browser_observe content must explicitly validate tiny timeoutMs values instead of silently expanding them");
assert(contentRunnerSource.includes("evaluatePageScriptDirect(server, script") && !contentRunnerSource.includes("server.executeJavaScript(script, { browserSessionId: params.browserSessionId, tabId: params.tabId, timeoutMs })") && !contentRunnerSource.includes("Math.max(timeoutMs"), "browser_observe content extraction must use the direct CDP value channel with the normalized user timeout");
assert(observeRunnerSource.includes("evaluatePageScriptDirect(server, scanScript") && !observeRunnerSource.includes("server.executeJavaScript(scanScript"), "browser_observe scan extraction must use the direct CDP value channel instead of exec.js smart serializer");
const pageScriptEvaluationSource = read("src/tools/pageScriptEvaluation.ts");
assert(pageScriptEvaluationSource.includes('cmd: "persistent_cdp"') && pageScriptEvaluationSource.includes('cdpMethod: "Runtime.evaluate"') && pageScriptEvaluationSource.includes("precompile: true") && pageScriptEvaluationSource.includes("returnByValue: true"), "direct page script evaluation must use precompiled persistent CDP Runtime.evaluate returnByValue");
assert.doesNotThrow(() => assertBridgeCommandSucceeded({ data: { waitId: "ok" } }, "wait.navigateAndWait"), "bridge success data must pass");
assert.throws(() => assertBridgeCommandSucceeded({ data: { ok: false, error_code: "NAVIGATION_FAILED", error: "bad URL", details: { url: "https://bad.test", raw: { stack: "secret stack", message: "boom" } } } }, "wait.navigateAndWait"), (error) => {
	assert.equal(error.code, "NAVIGATION_FAILED");
	assert.equal(error.message, "bad URL");
	assert.equal(error.details.command, "wait.navigateAndWait");
	assert.equal(error.details.url, "https://bad.test");
	assert.equal(error.details.raw.message, "boom");
	assert.equal(Object.hasOwn(error.details.raw, "stack"), false, "bridge ok:false details must not carry stack traces into tool output");
	return true;
}, "bridge ok:false data must throw structured errors");

const largeMarkdown = `${"content-line\n".repeat(21_000)}[content truncated]`;
const largeScanContent = `${"scan-line\n".repeat(21_000)}[scan truncated]`;
const fakeServer = {
	calls: [],
	async sendCommand(command, options) {
		this.calls.push({ command, options });
		const expression = String(command.params?.expression || "");
		const value = expression.includes("content-script") ? {
			url: "https://example.test/content",
			title: "Content fixture",
			selector: null,
			rootTag: "main",
			rootId: "fixture",
			rootClass: "",
			empty: false,
			markdown: largeMarkdown,
			textPreview: largeMarkdown.slice(0, 1000),
			headings: ["Fixture"],
			stats: { markdownChars: largeMarkdown.length, originalMarkdownChars: largeMarkdown.length, textChars: largeMarkdown.length, links: 0, images: 0, paragraphs: 1, headings: 1, truncated: true },
		} : {
			url: "https://example.test/scan",
			title: "Scan fixture",
			readyState: "complete",
			text_only: true,
			content: largeScanContent,
			truncated: true,
			node_count: 2,
			iframe_notes: [],
			top_layer: null,
			actionables: [],
			list_hints: [],
		};
		return { id: `direct-${this.calls.length}`, acknowledged: true, tabId: Number(options.tabId || 1), data: { result: { type: "object", value } }, target: { source: "explicit", implicit: false, selectionVersionAtDispatch: 1 } };
	},
};

const tmp = await mkdtemp(path.join(os.tmpdir(), "browser-pilot-large-channel-"));
try {
	await mkdir(path.join(tmp, ".pi", "browser-artifacts"), { recursive: true });
	const contentPath = path.join(tmp, ".pi", "browser-artifacts", "content-large.json");
	const contentDirect = await evaluatePageScriptDirect(fakeServer, "content-script", { tabId: 1, timeoutMs: 1_000, name: "content_extract" });
	await distilledTextResult(contentDirect.data.markdown, {
		toolName: "browser_observe",
		command: "content",
		maxChars: 8_000,
		ctx: { cwd: tmp },
		outputPath: contentPath,
		fallbackName: "content-large.json",
		summary: summarizeContentData(contentDirect.data),
		artifactValue: contentDirect,
	});
	const contentArtifact = JSON.parse(await readFile(contentPath, "utf8"));
	assert.equal(contentArtifact.data.markdown.length, largeMarkdown.length, "browser_content outputPath artifact must preserve the direct CDP markdown length");
	assert.equal(contentArtifact.data.markdown.endsWith("[content truncated]"), true, "browser_content artifact must keep script-level truncation marker");
	assert.equal(contentArtifact.data.markdown.includes("…"), false, "browser_content artifact must not contain exec.js serializer ellipsis");

	const scanPath = path.join(tmp, ".pi", "browser-artifacts", "scan-large.json");
	const scanDirect = await evaluatePageScriptDirect(fakeServer, "scan-script", { tabId: 1, timeoutMs: 1_000, name: "scan_extract" });
	await distilledTextResult(scanDirect.data.content, {
		toolName: "browser_observe",
		command: "scan",
		maxChars: 8_000,
		ctx: { cwd: tmp },
		outputPath: scanPath,
		fallbackName: "scan-large.json",
		summary: { contentChars: scanDirect.data.content.length, truncated: scanDirect.data.truncated },
		artifactValue: scanDirect,
	});
	const scanArtifact = JSON.parse(await readFile(scanPath, "utf8"));
	assert.equal(scanArtifact.data.content.length, largeScanContent.length, "browser_scan outputPath artifact must preserve the direct CDP content length");
	assert.equal(scanArtifact.data.content.endsWith("[scan truncated]"), true, "browser_scan artifact must keep script-level truncation marker");
	assert.equal(scanArtifact.data.content.includes("…"), false, "browser_scan artifact must not contain exec.js serializer ellipsis");
	assert.equal(fakeServer.calls.every((call) => call.command.cmd === "persistent_cdp" && call.command.cdpMethod === "Runtime.evaluate"), true, "content/scan large channel must use direct persistent CDP Runtime.evaluate");
} finally {
	await rm(tmp, { recursive: true, force: true });
}

console.log("content/pick contract ok");
