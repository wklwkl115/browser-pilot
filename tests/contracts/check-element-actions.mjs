import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildElementActionScript } from "../../src/actions/buildElementActionScript.ts";
import { summarizeElementActionData } from "../../src/tools/summaries/index.ts";

const root = new URL("../..", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), "utf8");

for (const options of [
	{ action: "query", selector: "button", limit: 5, visibleOnly: true },
	{ action: "click", selector: "button.primary", index: 1 },
	{ action: "type", selector: "input[name=email]", text: "hello@example.test", clear: true, submit: false },
]) {
	const script = buildElementActionScript(options);
	new Function(script);
	assert(script.includes("safeQueryAll"), "element action script must validate selectors");
	assert(script.includes("stableSelector"), "element action script must return stable selectors");
	assert(script.includes("scrollIntoCenter"), "click/type must scroll into view");
	assert(script.includes("dispatchInputEvents"), "type must dispatch input/change events");
	assert(script.includes("textWithoutNoise") && script.includes("cleanupClone"), "element summaries must filter translation plugin text/html noise");
	assert(script.includes("data-read-frog") && script.includes("immersive-translate"), "element summaries must include shared translation noise rules");
}

const typeScript = buildElementActionScript({ action: "type", selector: "input[type=password]", text: "secret" });
assert(typeScript.includes("redacted password field"), "browser_type must redact password values");
assert(typeScript.includes("structuredError") && typeScript.includes("ELEMENT_INDEX_OUT_OF_RANGE") && typeScript.includes("ELEMENT_NOT_CLICKABLE") && typeScript.includes("ELEMENT_NOT_TYPEABLE"), "browser query/click/type must use structured error codes");
assert(typeScript.includes("HTMLInputElement") && typeScript.includes("HTMLTextAreaElement") && typeScript.includes("isContentEditable"), "browser_type must support input/textarea/contenteditable");

const summary = summarizeElementActionData({
	action: "query",
	selector: "button",
	totalMatches: 2,
	filteredMatches: 2,
	returnedMatches: 1,
	matches: [{ index: 0, selector: "#go", tagName: "button", id: "go", classes: ["primary"], text: "Go", visible: true, disabled: false, rect: { x: 1, y: 2, width: 3, height: 4 }, outerHtmlSnippet: "<button>Go</button>" }],
});
assert.equal(summary.totalMatches, 2, "element action summary must surface total matches");
assert.equal(summary.matches[0].selector, "#go", "element action summary must surface selectors");
assert.equal(summary.matches[0].htmlSnippet, "<button>Go</button>", "element action summary must include compact HTML snippets");
assert.equal(JSON.stringify(summary).includes("outerHtmlSnippet"), false, "element action summary must rename raw HTML snippet field");

const exec = read("bridge/pi_browser_bridge/exec.js");
for (const token of ["value instanceof Map", "value instanceof Set", "t === 'bigint'", "value instanceof Error", "serializeElement", "[Circular]", "RegExp", "symbol", "WeakSet", "MAX_NODES", "MAX_CHARS"]) {
	assert(exec.includes(token), `exec serialization must handle ${token}`);
}
assert(!exec.includes("JSON.stringify(result, function"), "exec serialization must not rely on the old JSON.stringify-only path");

const pkg = JSON.parse(read("package.json"));
assert(!Object.keys(pkg.dependencies || {}).some((name) => /curio|puppeteer|playwright/i.test(name)), "element actions must not add browser automation runtime deps");
console.log("element action contract ok");
