import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildContentScript } from "../../src/content/buildContentScript.ts";
import { buildPickScript } from "../../src/pick/buildPickScript.ts";
import { assertBridgeCommandSucceeded } from "../../src/tools/bridgeResultValidation.ts";
import { summarizeContentData, summarizePickData } from "../../src/tools/summaries/index.ts";

const root = new URL("../..", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), "utf8");

const contentScript = buildContentScript({ selector: "main", maxChars: 1234, includeLinks: true });
new Function(contentScript);
assert(contentScript.includes("article, main"), "browser_content must prefer article/main readable roots");
assert(contentScript.includes("DROP_SELECTOR"), "browser_content must drop noisy/non-content nodes");
assert(contentScript.includes("read-frog-translated") && contentScript.includes("immersive-translate"), "browser_content must drop translation plugin wrappers");
assert(contentScript.includes("[content truncated]"), "browser_content must bound extracted markdown");
assert(contentScript.includes("includeLinks"), "browser_content must support link-preserving markdown");
assert(!contentScript.includes("Readability"), "browser_content must not depend on Readability in page script");

const pickScript = buildPickScript({ message: "Pick submit", multiple: true, timeoutMs: 30_000 });
new Function(pickScript);
assert(pickScript.includes("data-pi-browser-pick"), "browser_pick must mark its overlay for cleanup/debugging");
assert(pickScript.includes("buildSelector"), "browser_pick must build CSS selectors");
assert(pickScript.includes("Cmd/Ctrl+click"), "browser_pick must expose multi-select guidance");
assert(pickScript.includes("read-frog-translated") && pickScript.includes("immersive-translate"), "browser_pick must drop translation plugin wrappers from selected summaries");
assert(pickScript.includes("textWithoutNoise") && pickScript.includes("cleanupClone") && pickScript.includes("isNoiseAttr"), "browser_pick must sanitize text/html/attributes with shared noise rules");
assert(pickScript.includes("normalizePickedElement"), "browser_pick must normalize translation wrapper hits to a real parent element");
assert(pickScript.includes("Runtime.evaluate") === false, "browser_pick page script must stay transport-agnostic");

const contentSummary = summarizeContentData({ url: "https://example.test", title: "T", rootTag: "main", markdown: "# T\nBody", headings: ["T"], stats: { markdownChars: 8, textChars: 4, links: 1, images: 0, paragraphs: 1, headings: 1, truncated: false } });
assert.equal(contentSummary.url, "https://example.test", "content summary must surface URL");
assert.equal(contentSummary.markdownChars, 8, "content summary must surface markdown size");

const pickSummary = summarizePickData({ message: "Pick", selectedCount: 1, selectors: ["#go"], selections: [{ selector: "#go", tag: "button", text: "Go", rect: { x: 1 } }] });
assert.deepEqual(pickSummary.selectors, ["#go"], "pick summary must surface selectors");
assert.equal(pickSummary.selections[0].tag, "button", "pick summary must include compact element info");

const pkg = JSON.parse(read("package.json"));
assert(!Object.keys(pkg.dependencies || {}).some((name) => /puppeteer|readability|turndown|jsdom/i.test(name)), "browser_pick/content must not add Puppeteer/Readability/Turndown/JSDOM runtime deps");
assert(read("src/tools/registerPickTool.ts").includes("Runtime.evaluate"), "browser_pick must use CDP Runtime.evaluate for interactive await");
const registerContentToolSource = read("src/tools/registerContentTool.ts");
assert(registerContentToolSource.includes("distilledTextResult"), "browser_content must use text distillation");
assert(registerContentToolSource.includes("assertBridgeCommandSucceeded(navigation, \"wait.navigateAndWait\")"), "browser_content must fail when URL navigation returns ok:false instead of extracting the old page");
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
console.log("content/pick contract ok");
