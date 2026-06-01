import assert from "node:assert/strict";
import vm from "node:vm";
import { existsSync, readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { buildContentScript } from "../../../src/content/buildContentScript.ts";
import { buildPickCleanupScript, buildPickScript } from "../../../src/pick/buildPickScript.ts";
import { buildScanScript } from "../../../src/scan/buildScanScript.ts";

const root = new URL("../../..", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), "utf8");
const stripBridgeSource = (text) => text
	.replace(/^\/\/ @ts-nocheck\r?\n/, "")
	.replace(/^import\s+[^;]+;\r?\n/gm, "")
	.replace(/^export\s+\{[^}]+\};\r?\n/gm, "")
	.replace(/^export const (?!__piBridgeModule_)([A-Za-z0-9_$]+)\s*=/gm, "const $1 =")
	.replace(/\s+as\s+any/g, "")
	.replace(/\r?\n\/\/ ESM module metadata\r?\nexport const __piBridgeModule_[\s\S]*?;\s*$/, "")
	.replace(/\r?\nexport \{\};\s*$/, "");
const readServiceWorkerSource = (name) => stripBridgeSource(read(`bridge_src/service_worker/${name}.ts`));
const readPageSource = (name) => stripBridgeSource(read(`bridge_src/page_scripts/${name}.ts`));
const transformBridgeSourceForVm = (text, sourcefile) => transformSync(text, { loader: "ts", target: "chrome120", sourcefile }).code;

const hookDispatcherPageScript = readPageSource("hook_dispatcher");
const hookDispatcherBundleScript = read("bridge/pi_browser_bridge/dist/hook_dispatcher.js");
const contentBundleScript = read("bridge/pi_browser_bridge/dist/content.js");
const disableDialogsBundleScript = read("bridge/pi_browser_bridge/dist/disable_dialogs.js");
const hookRuntimeScript = readServiceWorkerSource("runtime");
const hookServiceWorkerScript = readServiceWorkerSource("hook");

for (const pageScript of ["content", "hook_dispatcher", "disable_dialogs"]) {
	assert(existsSync(new URL(`bridge_src/page_scripts/${pageScript}.ts`, root)), `page-scripts bundle source must exist: ${pageScript}`);
}
assert(hookRuntimeScript.includes("const PI_BROWSER_HOOK_DISPATCHER_FILE = 'dist/hook_dispatcher.js';"), "page-scripts hook boundary: generated dispatcher filename must stay stable");
assert(hookServiceWorkerScript.includes("files: [PI_BROWSER_HOOK_DISPATCHER_FILE]"), "page-scripts hook boundary: scripting injection must use the stable dispatcher file");
assert(hookServiceWorkerScript.includes("chrome.runtime.getURL(PI_BROWSER_HOOK_DISPATCHER_FILE)"), "page-scripts hook boundary: CDP fallback must fetch the stable dispatcher file");
assert(hookDispatcherPageScript.includes(";(function PiBrowserHookDispatcher()") && hookDispatcherPageScript.includes("__PI_BROWSER_HOOKS__ = {"), "page-scripts hook boundary: dispatcher must stay a self-contained IIFE with one public page global");
assert(!/\bimport\s+|\bimport\s*\(|\bexport\s+|importScripts\s*\(/.test(hookDispatcherPageScript), "page-scripts hook boundary: dispatcher must not require page-side imports before TODO 190");
assert(!/chrome\./.test(hookDispatcherPageScript), "page-scripts hook boundary: dispatcher must not call background-only Chrome APIs from MAIN world");
assert(hookDispatcherBundleScript.includes("PiBrowserHookDispatcher") && hookDispatcherBundleScript.includes("__PI_BROWSER_HOOKS__"), "page-scripts dist hook bundle: dispatcher public page global must survive bundling");
assert(!/\bimport\s+|\bimport\s*\(|\bexport\s+|importScripts\s*\(|\bchrome\./.test(hookDispatcherBundleScript), "page-scripts dist hook bundle: must remain a self-contained MAIN-world file without background APIs");
assert(contentBundleScript.includes("__pi_browser_bridge_request__") && contentBundleScript.includes("bridge_wake") && contentBundleScript.includes("MutationObserver"), "page-scripts dist content bundle: must include content bridge behavior and explicit TID");
assert(disableDialogsBundleScript.includes("window.prompt") && disableDialogsBundleScript.includes("promptAcceptedValue") && !/chrome\./.test(disableDialogsBundleScript), "page-scripts dist disable-dialogs bundle: must preserve dialog overrides without Chrome APIs");

const NODE = { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 };

function cssEscape(value) {
	return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

function splitSelectors(selector) {
	return String(selector || "").split(",").map((part) => part.trim()).filter(Boolean);
}

function attrValueFor(el, name) {
	if (name === "class") return el.className || "";
	if (name === "id") return el.id || "";
	if (name === "type") return el.type || el.getAttribute("type") || "";
	return el.getAttribute(name) || "";
}

function matchesSimpleSelector(el, rawSelector) {
	let selector = String(rawSelector || "").trim();
	if (!selector || el.nodeType !== NODE.ELEMENT_NODE) return false;
	if (selector.includes(">")) {
		const parts = selector.split(">").map((part) => part.trim()).filter(Boolean).reverse();
		let current = el;
		for (const part of parts) {
			if (!current || !matchesSimpleSelector(current, part)) return false;
			current = current.parentElement;
		}
		return true;
	}
	const notMatch = selector.match(/^([a-zA-Z][\w-]*):not\(\[([\w-]+)=([^\]]+)\]\)$/);
	if (notMatch) {
		const [, tag, attr, value] = notMatch;
		return el.tagName === tag.toUpperCase() && attrValueFor(el, attr) !== value.replace(/^['"]|['"]$/g, "");
	}
	const tagMatch = selector.match(/^[a-zA-Z][\w-]*/);
	if (tagMatch && el.tagName !== tagMatch[0].toUpperCase()) return false;
	const idMatch = selector.match(/#([\w-]+)/);
	if (idMatch && el.id !== idMatch[1]) return false;
	for (const cls of selector.matchAll(/\.([\w-]+)/g)) {
		if (!el.classList.includes(cls[1])) return false;
	}
	for (const attr of selector.matchAll(/\[([^\]\^\*\$=]+)(\^=|\*=|\$=|=)?(?:"([^"]*)"|'([^']*)'|([^\]]*))?\]/g)) {
		const name = attr[1].trim();
		const op = attr[2] || "";
		const expected = (attr[3] ?? attr[4] ?? attr[5] ?? "").trim();
		const actual = attrValueFor(el, name);
		const hasAttr = el.getAttribute(name) !== null || (name === "hidden" && el.hidden === true) || (name === "disabled" && el.disabled === true);
		if (!op && !hasAttr) return false;
		if (op === "=" && actual !== expected) return false;
		if (op === "^=" && !actual.startsWith(expected)) return false;
		if (op === "*=" && !actual.includes(expected)) return false;
		if (op === "$=" && !actual.endsWith(expected)) return false;
	}
	return true;
}

function matchesSelector(el, selector) {
	return splitSelectors(selector).some((part) => matchesSimpleSelector(el, part));
}

function descendants(rootNode) {
	const out = [];
	function walk(node) {
		for (const child of node.childNodes || []) {
			if (child.nodeType === NODE.ELEMENT_NODE) {
				out.push(child);
				walk(child);
			}
		}
	}
	walk(rootNode);
	return out;
}

class MockText {
	constructor(text) {
		this.nodeType = NODE.TEXT_NODE;
		this.nodeValue = String(text || "");
		this.childNodes = [];
		this.parentElement = null;
	}
	get textContent() { return this.nodeValue; }
	set textContent(value) { this.nodeValue = String(value || ""); }
	cloneNode() { return new MockText(this.nodeValue); }
}

class MockElement {
	constructor(tagName, attrs = {}, children = []) {
		this.nodeType = NODE.ELEMENT_NODE;
		this.tagName = String(tagName || "div").toUpperCase();
		this.parentElement = null;
		this.childNodes = [];
		this.style = {};
		this.id = "";
		this.className = "";
		this.type = "";
		this.value = "";
		this.disabled = false;
		this.hidden = false;
		this.clicked = false;
		this._attrs = new Map();
		this._rect = { x: 10, y: 10, left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 };
		for (const [name, value] of Object.entries(attrs || {})) this.setAttribute(name, value);
		for (const child of children || []) this.appendChild(typeof child === "string" ? new MockText(child) : child);
	}
	get attributes() { return Array.from(this._attrs, ([name, value]) => ({ name, value })); }
	get classList() { return String(this.className || "").split(/\s+/).filter(Boolean); }
	get children() { return this.childNodes.filter((child) => child.nodeType === NODE.ELEMENT_NODE); }
	get textContent() { return this.childNodes.map((child) => child.textContent || "").join(""); }
	set textContent(value) { this.childNodes = []; this.appendChild(new MockText(value)); }
	get outerHTML() {
		const attrs = this.attributes.map(({ name, value }) => ` ${name}="${String(value).replace(/"/g, "&quot;" )}"`).join("");
		return `<${this.tagName.toLowerCase()}${attrs}>${this.childNodes.map((child) => child.outerHTML || child.textContent || "").join("")}</${this.tagName.toLowerCase()}>`;
	}
	setAttribute(name, value) {
		const key = String(name);
		const text = String(value);
		this._attrs.set(key, text);
		if (key === "id") this.id = text;
		if (key === "class") this.className = text;
		if (key === "type") this.type = text;
		if (key === "value") this.value = text;
		if (key === "hidden") this.hidden = true;
		if (key === "disabled") this.disabled = true;
	}
	getAttribute(name) { return this._attrs.has(String(name)) ? this._attrs.get(String(name)) : null; }
	removeAttribute(name) {
		const key = String(name);
		this._attrs.delete(key);
		if (key === "id") this.id = "";
		if (key === "class") this.className = "";
	}
	appendChild(child) {
		child.parentElement = this;
		child.ownerDocument = this.ownerDocument;
		this.childNodes.push(child);
		return child;
	}
	remove() {
		const siblings = this.parentElement?.childNodes;
		if (!siblings) return;
		const index = siblings.indexOf(this);
		if (index >= 0) siblings.splice(index, 1);
		this.parentElement = null;
	}
	cloneNode(deep = false) {
		const clone = new this.constructor(this.tagName.toLowerCase());
		for (const { name, value } of this.attributes) clone.setAttribute(name, value);
		clone.style = { ...this.style };
		clone.value = this.value;
		clone.type = this.type;
		clone.disabled = this.disabled;
		clone.hidden = this.hidden;
		clone._rect = { ...this._rect };
		if (deep) for (const child of this.childNodes) clone.appendChild(child.cloneNode(true));
		return clone;
	}
	querySelectorAll(selector) { return descendants(this).filter((node) => matchesSelector(node, selector)); }
	querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
	matches(selector) { return matchesSelector(this, selector); }
	closest(selector) {
		let current = this;
		while (current) {
			if (current.matches?.(selector)) return current;
			current = current.parentElement;
		}
		return null;
	}
	contains(node) {
		let current = node;
		while (current) {
			if (current === this) return true;
			current = current.parentElement;
		}
		return false;
	}
	getBoundingClientRect() { return { ...this._rect }; }
	scrollIntoView() {}
	focus() { this.focused = true; }
	click() { this.clicked = true; }
}

class MockInputElement extends MockElement {
	constructor(attrs = {}, children = []) { super("input", attrs, children); }
}
class MockTextAreaElement extends MockElement {
	constructor(attrs = {}, children = []) { super("textarea", attrs, children); }
}

function mockEl(tagName, attrs = {}, children = []) {
	if (String(tagName).toLowerCase() === "input") return new MockInputElement(attrs, children);
	if (String(tagName).toLowerCase() === "textarea") return new MockTextAreaElement(attrs, children);
	return new MockElement(tagName, attrs, children);
}
function mockText(value) { return new MockText(value); }

class MockDocument {
	constructor(bodyChildren = []) {
		this.nodeType = NODE.DOCUMENT_NODE;
		this.title = "Mock Page";
		this._listeners = new Map();
		this.body = mockEl("body", {}, bodyChildren);
		this.documentElement = mockEl("html", {}, [this.body]);
		this.body.ownerDocument = this;
		this.documentElement.ownerDocument = this;
		this._pointElement = this.body;
		this.execCommand = () => false;
	}
	createElement(tagName) { const node = mockEl(tagName); node.ownerDocument = this; return node; }
	createTextNode(value) { const node = mockText(value); node.ownerDocument = this; return node; }
	createRange() { return { selectNodeContents() {}, collapse() {} }; }
	getSelection() { return { removeAllRanges() {}, addRange() {} }; }
	querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
	querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
	addEventListener(type, handler) {
		const handlers = this._listeners.get(type) || [];
		handlers.push(handler);
		this._listeners.set(type, handlers);
	}
	removeEventListener(type, handler) {
		const handlers = this._listeners.get(type) || [];
		this._listeners.set(type, handlers.filter((item) => item !== handler));
	}
	dispatch(type, event) {
		for (const handler of this._listeners.get(type) || []) handler(event);
	}
	elementFromPoint() { return this._pointElement; }
}

function createPageContext(document) {
	const windowListeners = new Map();
	const context = {
		console,
		document,
		location: { href: "http://example.test/page" },
		Node: NODE,
		HTMLElement: MockElement,
		HTMLInputElement: MockInputElement,
		HTMLTextAreaElement: MockTextAreaElement,
		InputEvent: class InputEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
		Event: class Event { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
		KeyboardEvent: class KeyboardEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
		URL,
		Map,
		Set,
		WeakSet,
		Date,
		RegExp,
		Error,
		Array,
		Object,
		String,
		Number,
		Math,
		setTimeout,
		clearTimeout,
		getComputedStyle: (el) => ({ display: el?.style?.display || "block", visibility: el?.style?.visibility || "visible", opacity: el?.style?.opacity ?? "1" }),
	};
	context.addEventListener = (type, handler) => {
		const handlers = windowListeners.get(type) || [];
		handlers.push(handler);
		windowListeners.set(type, handlers);
	};
	context.removeEventListener = (type, handler) => {
		const handlers = windowListeners.get(type) || [];
		windowListeners.set(type, handlers.filter((item) => item !== handler));
	};
	context.dispatchWindowEvent = (type, event = {}) => {
		for (const handler of windowListeners.get(type) || []) handler(event);
	};
	context.window = context;
	context.window.innerHeight = 800;
	context.window.innerWidth = 1200;
	context.window.CSS = { escape: cssEscape };
	return context;
}

function clickEvent(target) {
	return { target, clientX: 12, clientY: 12, metaKey: false, ctrlKey: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
}

async function runPageScript(script, document) {
	return await vm.runInNewContext(script, createPageContext(document));
}

const scan = buildScanScript({ maxChars: 4_000, includeIframes: true });
new Function(scan);
assert(scan.includes("outputChars"), "page-scripts scan: must track output budget incrementally");
assert(!scan.includes("lines.reduce"), "page-scripts scan: must not recompute line size per push");
assert(scan.includes("pi-browser-bridge-ind") && scan.includes("aix-drop-panel"), "page-scripts scan: must filter known extension noise");

const scanDoc = new MockDocument([
	mockEl("main", {}, [mockEl("h1", {}, ["Keep Heading"]), mockEl("p", {}, ["Keep body text"])]),
	mockEl("div", { id: "aix-drop-panel" }, ["Noise text"]),
]);
const scanBehavior = await runPageScript(buildScanScript({ textOnly: true, maxChars: 4_000, maxNodes: 20 }), scanDoc);
assert.equal(scanBehavior.text_only, true, "scan behavior: textOnly result must be marked");
assert(scanBehavior.content.includes("Keep body text"), "scan behavior: visible text must be collected");
assert(!scanBehavior.content.includes("Noise text"), "scan behavior: known extension noise must be ignored");
assert(scanBehavior.node_count > 0, "scan behavior: textOnly traversal must count visited elements");
const textOnlyNoIframeDoc = new MockDocument([mockEl("input", { name: "q", placeholder: "Search", value: "pi" })]);
const textOnlyNoIframeScan = await runPageScript(buildScanScript({ textOnly: true, includeIframes: false, maxChars: 4_000, maxNodes: 20 }), textOnlyNoIframeDoc);
assert(textOnlyNoIframeScan.content.includes("[input name=q"), "scan behavior: textOnly must include main-document control summaries when iframe traversal is disabled");

const delegatedCard = mockEl("div", { class: "search-result-card" }, ["Video card"]);
delegatedCard["__reactProps$pi"] = { onClick() {} };
const dataE2eControl = mockEl("div", { "data-e2e": "feed-comment-icon" }, ["2.9万"]);
const headerSearch = mockEl("input", { "data-e2e": "searchbar-input" });
headerSearch._rect = { x: 10, y: 10, left: 10, top: 10, right: 210, bottom: 42, width: 200, height: 32 };
const commentInputContainer = mockEl("div", { id: "comment-input-container" }, ["留下你的精彩评论吧"]);
const draftEditor = mockEl("div", { class: "notranslate public-DraftEditor-content", contenteditable: "true", role: "combobox" }, [""]);
const scrollAction = mockEl("button", { class: "comment-reply-expand-btn" }, ["展开回复"]);
const scrollContainer = mockEl("div", { class: "route-scroll-container" }, [scrollAction]);
scrollContainer.style.overflowY = "auto";
scrollContainer._rect = { x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 300, width: 300, height: 300 };
scrollAction._rect = { x: 20, y: 240, left: 20, top: 240, right: 120, bottom: 270, width: 100, height: 30 };
const ordinaryPlayerPopup = mockEl("div", { class: "basePlayerContainer lowPopup xgplayer" }, [mockEl("button", {}, ["Play"])]);
ordinaryPlayerPopup._rect = { x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 500, width: 800, height: 500 };
const repeatedList = mockEl("section", { id: "results" }, Array.from({ length: 6 }, (_, index) => mockEl("article", { class: "result-card w-1/2" }, [`Result item ${index} with enough descriptive text for list hint scoring`])));
const actionableDoc = new MockDocument([delegatedCard, dataE2eControl, headerSearch, commentInputContainer, draftEditor, scrollContainer, ordinaryPlayerPopup, repeatedList]);
const actionableScan = await runPageScript(buildScanScript({ maxChars: 4_000, maxNodes: 40 }), actionableDoc);
assert.equal(actionableScan.top_layer, null, "scan behavior: ordinary player lowPopup must not become modal top_layer");
assert(actionableScan.actionables.some((node) => node.selector.includes("search-result-card") && node.handlers.includes("onClick") && node.point?.x >= 0), "scan behavior: actionables must include framework delegated card clicks with CDP-ready point");
assert(actionableScan.actionables.some((node) => node.action === "feed-comment-icon" && node.clickable === true), "scan behavior: actionables must include data-e2e controls such as comment icons");
assert(actionableScan.actionables.some((node) => node.action === "comment-input-container" && node.clickable === true), "scan behavior: actionables must promote id/class based comment input containers");
assert(actionableScan.actionables.findIndex((node) => node.action === "comment-input-container") < actionableScan.actionables.findIndex((node) => node.action === "searchbar-input"), "scan behavior: comment/reply/send controls must outrank persistent search inputs");
assert(actionableScan.actionables.some((node) => node.editable === true && node.role === "combobox"), "scan behavior: actionables must include Draft-like contenteditable editors");
assert(actionableScan.actionables.some((node) => node.action === "comment-reply-expand-btn" && node.point?.y >= 0), "scan behavior: actionables must include visible controls inside scroll containers");
assert(actionableScan.list_hints.some((hint) => String(hint.selector).includes("article.result-card") && String(hint.selector).includes("w-1\\/2") && hint.hiddenCount === 3), "scan behavior: repeated lists must expose GA-style hidden item hints with CSS-escaped class selectors");

const content = buildContentScript({ selector: "main", maxChars: 4_000, includeLinks: true });
new Function(content);
assert(content.includes("DROP_SELECTOR"), "page-scripts content: must drop noisy nodes");
assert(content.includes("[content truncated]"), "page-scripts content: must bound markdown output");
assert(content.includes("SELECTOR_NOT_FOUND") && content.includes("INVALID_SELECTOR"), "page-scripts content: selector failures must be structured and stable");
assert(!content.includes("Readability"), "page-scripts content: must stay dependency-free");

const contentDoc = new MockDocument([
	mockEl("main", { id: "main" }, [
		mockEl("h1", {}, ["Article Title"]),
		mockEl("p", {}, ["Useful article body with ", mockEl("a", { href: "/target" }, ["a link"])]),
		mockEl("nav", {}, ["Navigation noise"]),
	]),
]);
const contentBehavior = await runPageScript(content, contentDoc);
assert.equal(contentBehavior.rootTag, "main", "content behavior: selector root must be used");
assert(contentBehavior.markdown.includes("# Article Title"), "content behavior: heading must render as markdown");
assert(contentBehavior.markdown.includes("[a link](http://example.test/target)"), "content behavior: links must be made absolute when requested");
assert(!contentBehavior.markdown.includes("Navigation noise"), "content behavior: noisy navigation must be removed before extraction");
assert.equal(contentBehavior.empty, false, "content behavior: non-empty extraction must expose empty:false");

const missingContent = await runPageScript(buildContentScript({ selector: "#missing", maxChars: 4_000 }), contentDoc);
assert.equal(missingContent.ok, false, "content behavior: missing selector must return a structured failure result");
assert.equal(missingContent.error_code, "SELECTOR_NOT_FOUND", "content behavior: missing selector must not be reported as generic execution failure");
assert.equal(missingContent.details.selector, "#missing", "content behavior: missing selector details must preserve selector");

const emptyContentDoc = new MockDocument([mockEl("main", { id: "main" }, [])]);
const emptyContent = await runPageScript(buildContentScript({ selector: "main", maxChars: 4_000 }), emptyContentDoc);
assert.equal(emptyContent.empty, true, "content behavior: empty selected node must return structured empty:true instead of throwing");
assert.equal(emptyContent.markdown, "", "content behavior: empty selected node markdown should remain empty");

const pick = buildPickScript({ message: "Pick", timeoutMs: 5_000 });
new Function(pick);
assert(pick.includes("data-pi-browser-pick"), "page-scripts pick: overlay must be identifiable");
assert(pick.includes("buildSelector"), "page-scripts pick: must return CSS selectors");
assert(pick.includes("textWithoutNoise") && pick.includes("read-frog-translated"), "page-scripts pick: selected summaries must filter translation plugin noise");
assert(pick.includes("normalizePickedElement"), "page-scripts pick: translation wrapper hits must normalize to a real parent element");
assert(pick.includes("pagehide") && pick.includes("beforeunload"), "page-scripts pick: must settle on page unload before timeout");
assert(pick.includes("__piBrowserActivePickers") && pick.includes("__piBrowserPickCleanup"), "page-scripts pick: must expose cleanup hooks for tool-owned timeout");

const unloadDoc = new MockDocument([mockEl("button", { id: "leave" }, ["Leave"])]);
const unloadContext = createPageContext(unloadDoc);
const unloadPromise = vm.runInNewContext(buildPickScript({ message: "Pick unload", timeoutMs: 30_000 }), unloadContext);
unloadContext.dispatchWindowEvent("pagehide", { persisted: false });
const unloadPick = await unloadPromise;
assert.equal(unloadPick.cancelled, true, "pick behavior: pagehide must cancel picker instead of waiting for timeout");
assert.equal(unloadPick.reason, "pagehide", "pick behavior: pagehide cancellation reason must be explicit");

const cleanupDoc = new MockDocument([mockEl("button", { id: "slow" }, ["Slow"])]);
const cleanupContext = createPageContext(cleanupDoc);
const cleanupPromise = vm.runInNewContext(buildPickScript({ message: "Pick cleanup", timeoutMs: 30_000, pickId: "cleanup-contract" }), cleanupContext);
const cleanupResult = vm.runInNewContext(buildPickCleanupScript("cleanup-contract"), cleanupContext);
const cleanupPick = await cleanupPromise;
assert.equal(cleanupResult.cleaned, true, "pick cleanup script must call the active picker cleanup handle");
assert.equal(cleanupPick.cancelled, true, "pick cleanup behavior: external cleanup must settle the picker");
assert.equal(cleanupPick.reason, "timeout", "pick cleanup behavior: external cleanup should preserve timeout reason");

const noisySpan = mockEl("span", { class: "read-frog-translated-inline-content" }, ["Translated noise"]);
const realPickTarget = mockEl("p", { id: "real" }, ["Real text ", noisySpan]);
const pickDoc = new MockDocument([realPickTarget]);
pickDoc._pointElement = noisySpan;
const pickContext = createPageContext(pickDoc);
const pickPromise = vm.runInNewContext(pick, pickContext);
pickDoc.dispatch("click", clickEvent(noisySpan));
const pickBehavior = await pickPromise;
assert.equal(pickBehavior.cancelled, false, "pick behavior: click must finish selection");
assert.equal(JSON.stringify(pickBehavior.selectors), JSON.stringify(["#real"]), "pick behavior: translated wrapper hit must normalize to a stable real parent selector");
assert(!String(pickBehavior.selections[0]?.text || "").includes("Translated noise"), "pick behavior: selection text must exclude translation wrapper noise");

const wait = readServiceWorkerSource("wait");
const waitSelector = readServiceWorkerSource("wait_selector");
const waitNavigation = readServiceWorkerSource("wait_navigation");
assert(waitSelector.includes("textWithoutNoise") && waitSelector.includes("sanitizedOuterHtml") && waitSelector.includes("read-frog-translated"), "page-scripts wait.selector: element snapshots must filter translation plugin noise");
assert(waitSelector.includes("const visible = rectVisible") && waitSelector.includes("hitTarget") && waitSelector.includes("IntersectionObserver can lag"), "page-scripts wait.selector: visible must be CSS/rect based with IO kept as diagnostics");
assert(!waitSelector.includes("text:(el.innerText||el.textContent||'').slice"), "page-scripts wait.selector: must not return raw innerText snapshots");
assert(waitNavigation.includes("chrome.webNavigation.onCommitted") && waitNavigation.includes("chrome.tabs.onUpdated.addListener(onTabsUpdated)") && waitNavigation.includes("Page.frameNavigated") && waitNavigation.includes("Page.navigatedWithinDocument"), "wait.navigation must register webNavigation/tabs/CDP success listeners instead of timeout-only waiting");
assert(waitNavigation.includes("if (!value) return !targetUrl && !urlContains") && !waitNavigation.includes("target.startsWith(value)"), "wait.navigation must not match targetUrl against an empty or partial current URL before navigation starts");
assert(/const\s+checkCurrent\s*=\s*async\s*\(\s*source(?:\s*:\s*string)?\s*\)/.test(waitNavigation) && waitNavigation.includes("wait.navigation.currentUrl") && waitNavigation.includes("setInterval(() => { void checkCurrent('poll'); }"), "wait.navigation must poll current URL/readyState as a deterministic fallback for missed navigation events");
assert(waitNavigation.includes("chrome.webNavigation.onErrorOccurred") && waitNavigation.includes("waitForNavigation failed"), "wait.navigation must handle navigation failure events");
assert(wait.includes("target.addEventListener(eventType, handler, true)") && wait.includes("removeEventListener(rec.eventType, rec.handler"), "hook add/removeEventListener must store handlers and remove the real page listener");
assert(
	(
		wait.includes("const entries = Array.isArray(result?.result?.value) ? result.result.value : []")
		|| (/const\s+value\s*=\s*waitRecord\s*\(\s*result\.result\s*\)\.value/.test(wait) && /const\s+entries\s*=\s*Array\.isArray\s*\(\s*value\s*\)\s*\?\s*value\s*:\s*\[\]/.test(wait))
	) && wait.includes("data: { entries, entryType, nameContains, count"),
	"hook.getPerformanceEntries must unwrap Runtime.evaluate result.value into entries",
);

const exec = readServiceWorkerSource("exec");
assert(exec.includes("MAX_NODES") && exec.includes("MAX_CHARS") && exec.includes("MAX_DEPTH") && exec.includes("nodesUsed") && exec.includes("charsUsed"), "page-scripts exec: serializer must have traversal budgets");
assert(exec.includes("LARGE_TEXT_KEYS") && exec.includes("['content', 'markdown', 'html']") && exec.includes("trim(child, MAX_CHARS)"), "page-scripts exec: serializer must not truncate scan/content/html payload fields at nested string defaults");
assert(exec.includes("value instanceof Map") && exec.includes("value instanceof Set") && exec.includes("[Circular]"), "page-scripts exec: serializer must handle rich JS values");
const execSandbox = {};
vm.runInNewContext(transformBridgeSourceForVm(exec, "bridge_src/service_worker/exec.ts"), execSandbox, { filename: "exec.js" });
const generatedExec = execSandbox.buildExecScript("return 'status smoke class test'", "return {ok:false}");
assert(generatedExec.includes("return charge(String(value || ''), limit);") && !generatedExec.includes("replace(/s+/g, ' ')") && !generatedExec.includes("replace(/\\s+/g, ' ')"), "page-scripts exec: generated serializer must preserve returned string whitespace and not strip lowercase s");
const largeTextExec = execSandbox.buildExecScript("return { content: 'x'.repeat(5000), nested: { text: 'y'.repeat(2000) } }", "return {ok:false}");
const largeTextResult = await vm.runInNewContext(largeTextExec, { console, setTimeout, clearTimeout, WeakSet, Map, Set, Date, RegExp, Error, NodeList: class NodeList {}, HTMLCollection: class HTMLCollection {} }, { filename: "generated-exec-large-text.js" });
assert.equal(largeTextResult.ok, true, "page-scripts exec behavior: generated script must execute in a mocked runtime");
assert.equal(largeTextResult.data.content.length, 5000, "page-scripts exec behavior: top-level content payload must not be truncated at nested string defaults");
assert(largeTextResult.data.nested.text.length <= 1001, "page-scripts exec behavior: ordinary nested strings must still be bounded");
const circularExec = execSandbox.buildExecScript("const a = { label: 'root' }; a.self = a; return a", "return {ok:false}");
const circularExecResult = await vm.runInNewContext(circularExec, { console, setTimeout, clearTimeout, WeakSet, Map, Set, Date, RegExp, Error, NodeList: class NodeList {}, HTMLCollection: class HTMLCollection {} }, { filename: "generated-exec-circular.js" });
assert.equal(circularExecResult.data.self, "[Circular]", "page-scripts exec behavior: serializer must mark object reference cycles");
const deepExec = execSandbox.buildExecScript("let root = {}; let cur = root; for (let i = 0; i < 20; i++) { cur.child = {}; cur = cur.child; } return root", "return {ok:false}");
const deepExecResult = await vm.runInNewContext(deepExec, { console, setTimeout, clearTimeout, WeakSet, Map, Set, Date, RegExp, Error, NodeList: class NodeList {}, HTMLCollection: class HTMLCollection {} }, { filename: "generated-exec-depth.js" });
let deepCursor = deepExecResult.data;
for (let i = 0; i < 8 && deepCursor && typeof deepCursor === "object"; i++) deepCursor = deepCursor.child;
assert.equal(deepCursor, "[MaxDepth]", "page-scripts exec behavior: serializer must bound deep acyclic objects");

console.log("page script contract ok");
