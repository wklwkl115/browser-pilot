import { readFileSync } from "node:fs";
import vm from "node:vm";
import { buildScanScript, jsonForInlineScript } from "../../../src/scan/buildScanScript.ts";

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

const noiseRules = readFileSync(new URL("../../../src/scan/noiseRules.ts", import.meta.url), "utf8");
const actionableRules = readFileSync(new URL("../../../src/scan/actionableRules.ts", import.meta.url), "utf8");
const unsafeJson = jsonForInlineScript({ marker: "</script><script>alert(1)</script>", line: "\u2028", amp: "&" });
assert(!unsafeJson.includes("</script>"), "scan inline JSON must escape script end tags");
assert(!unsafeJson.includes("<script>"), "scan inline JSON must escape script start tags");
assert(!unsafeJson.includes("&"), "scan inline JSON must escape ampersands for HTML-script embedding safety");
assert(JSON.parse(unsafeJson).marker === "</script><script>alert(1)</script>", "scan inline JSON escaping must preserve parsed values");
assert(actionableRules.includes("ACTIONABLE_KEYWORD_PATTERN") && actionableRules.includes("FRAMEWORK_HANDLER_OWNER_PATTERN"), "scan actionable heuristics must live in actionableRules.ts");
assert(noiseRules.includes("SCAN_IGNORE_IDS"), "scan noise ids must live in noiseRules.ts");
assert(noiseRules.includes("SCAN_IGNORE_SELECTORS"), "scan noise selectors must live in noiseRules.ts");
assert(noiseRules.includes("SCAN_EXTENSION_URL_PATTERN"), "scan extension URL pattern must live in noiseRules.ts");
assert(noiseRules.includes("TRANSLATION_NOISE_SELECTORS"), "translation plugin selectors must live in noiseRules.ts");
assert(noiseRules.includes("BROWSER_NOISE_ATTRIBUTE_PREFIXES"), "translation plugin attribute prefixes must live in noiseRules.ts");

const boundedScript = buildScanScript({ maxChars: Number.POSITIVE_INFINITY, maxNodes: Number.NaN });
assert(!boundedScript.includes('"maxChars":null'), "scan options must not serialize non-finite maxChars as null");
assert(!boundedScript.includes('"maxNodes":null'), "scan options must not serialize non-finite maxNodes as null");
assert(boundedScript.includes('"maxChars":35000'), "scan options must fall back non-finite maxChars before embedding");
assert(boundedScript.includes('"maxNodes":4000'), "scan options must fall back non-finite maxNodes before embedding");
new Function(boundedScript);

for (const options of [
	{ textOnly: true, maxChars: 4_000 },
	{ textOnly: false, maxChars: 4_000, includeIframes: true },
]) {
	const script = buildScanScript(options);
	new Function(script);
	assert(script.includes("\\s+"), "scan script must preserve regex escapes");
	assert(script.includes("'\\n\\n--- iframe ---\\n\\n'"), "scan script must preserve escaped iframe separator");
	assert(script.includes("browser-pilot-bridge-ind"), "scan script must filter Pi bridge indicator noise");
	assert(script.includes("aix-drop-panel"), "scan script must filter AIX extension overlay noise");
	assert(script.includes("READ-FROG"), "scan script must filter Read Frog extension overlay noise");
	assert(script.includes("read-frog-translated"), "scan script must filter Read Frog translated wrappers");
	assert(script.includes("immersive-translate"), "scan script must filter translation plugin wrappers");
	assert(script.includes("data-read-frog"), "scan script must know translation plugin noise attributes");
	assert(script.includes("chrome|moz|safari)-extension"), "scan script must filter extension URL injected nodes");
	assert(script.includes("collectVisibleText"), "scan text mode must not use raw innerText for ignored overlays");
	assert(script.includes("nodeCount >= options.maxNodes"), "scan text mode must enforce maxNodes while traversing visible text");
	assert(script.includes("priorOutputChars = outputChars") && script.includes("traversalTruncated = truncated"), "scan text mode must preserve collected text when maxNodes truncates traversal");
	assert(script.includes("outputChars"), "scan script must track output budget incrementally");
	assert(!script.includes("lines.reduce"), "scan script must not recompute output size with lines.reduce on every push");
	assert(script.includes("resetOutputBudget"), "scan script must reset shared output budget per mode");
	assert(script.includes("cleanLineText") && !script.includes("clean(node.nodeValue, 800)"), "scan script must not silently cap every text node at 800 chars without tying it to the caller maxChars budget");
	assert(script.includes("topLayerRoot") && script.includes("top_layer") && script.includes("modalish") && script.includes("popupish") && script.includes("fixedLayer"), "scan script must prefer real top-layer/modal roots without treating ordinary player popups as modal roots");
	assert(script.includes("collectActionables") && script.includes("actionables") && script.includes("hitOk") && script.includes("selectorFor"), "scan script must expose GA-style actionable candidates for browser_execute scripts");
	assert(script.includes("frameworkHandlers") && script.includes("ACTIONABLE_RE") && script.includes("FRAMEWORK_OWNER_RE") && script.includes("data-e2e") && script.includes("point"), "scan actionables must cover framework delegated clicks, configured actionable controls and CDP-ready center points");
	assert(script.includes(":-webkit-autofill") && script.includes("data-autofilled") && script.includes("protected-autofill"), "scan script must preserve GA-style autofill protected-state hints");
	assert(script.includes("collectListHints") && script.includes("list_hints") && script.includes("hiddenCount") && script.includes("map(cssEscape).join('.')"), "scan script must expose GA-style repeated list compression hints with CSS-escaped selector classes");
	assert(script.includes("collectGrowthProbe") && script.includes("growthProbe") && script.includes("windowShifted") && script.includes("restoredScrollTop") && script.includes("IntersectionObserver"), "scan script must expose bounded collection growth probe evidence and restore scroll position");
	assert(script.includes("collectVisibleRows") && script.includes("const rows = collectVisibleRows(scanRoot)") && script.includes("sameOrigin") && script.includes("containerHint") && script.includes("selector:sel2"), "scan script must expose bounded DOM-ordered visible rows with text/href/origin/container hints and selectors");
	assert(script.includes("collectMediaCandidates") && script.includes("const media_candidates = collectMediaCandidates(scanRoot)") && script.includes("naturalWidth") && script.includes("videoWidth") && script.includes("media_candidates"), "scan script must expose bounded visible media candidates with identity/geometry facts");
	assert(script.includes("edgeUtilityHint") && script.includes("edgeUtility: true") && script.includes("position: edgeHint.position"), "scan actionables must flag fixed/sticky edge utility controls for downstream primary-action ranking");
	assert(!script.includes("headline") && !script.includes("uploader") && !script.includes("author") && !script.includes("ranking semantics"), "scan row projection must stay perception-only and must not grow semantic extractor fields");
	assert(script.includes("input:not([type=hidden])"), "scan text mode must preserve visible form controls");
}

const NODE = { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_NODE: 9 };

class MockText {
	constructor(value) {
		this.nodeType = NODE.TEXT_NODE;
		this.nodeValue = value;
		this.textContent = value;
	}
}

class MockElement {
	constructor(tagName, attrs = {}, children = []) {
		this.nodeType = NODE.ELEMENT_NODE;
		this.tagName = String(tagName).toUpperCase();
		this.children = [];
		this.childNodes = [];
		this.parentElement = null;
		this.style = {};
		this.id = attrs.id || "";
		this.className = attrs.class || "";
		this._attrs = new Map(Object.entries(attrs));
		this._rect = attrs.rect || { x: 10, y: 10, left: 10, top: 10, right: 210, bottom: 50, width: 200, height: 40 };
		for (const child of children) this.append(child);
	}
	append(child) {
		const node = typeof child === "string" ? new MockText(child) : child;
		node.parentElement = this;
		this.childNodes.push(node);
		if (node.nodeType === NODE.ELEMENT_NODE) this.children.push(node);
	}
	getAttribute(name) { return this._attrs.get(name) ?? null; }
	querySelectorAll(selector) {
		const all = descendants(this);
		if (selector === "*") return all;
		return all.filter((node) => selector.split(",").some((part) => node.tagName.toLowerCase() === part.trim().toLowerCase()));
	}
	querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
	getBoundingClientRect() { return { ...this._rect }; }
	get textContent() { return this.childNodes.map((child) => child.textContent || child.nodeValue || "").join(" "); }
	get innerText() { return this.textContent; }
}

function descendants(node) {
	const out = [];
	for (const child of node.children || []) {
		out.push(child, ...descendants(child));
	}
	return out;
}

class MockDocument {
	constructor(children) {
		this.nodeType = NODE.DOCUMENT_NODE;
		this.title = "Rows";
		this.body = new MockElement("body", {}, children);
		this.documentElement = new MockElement("html", {}, [this.body]);
		this.documentElement.clientWidth = 1200;
		this.documentElement.clientHeight = 800;
	}
	querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
	querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
	elementFromPoint() { return this.body; }
}

async function runScanInMockPage(document) {
	const context = {
		console,
		document,
		location: { href: "https://example.test/list", origin: "https://example.test" },
		Node: NODE,
		URL,
		Map,
		Set,
		WeakMap,
		Date,
		RegExp,
		Error,
		Array,
		Object,
		String,
		Number,
		Math,
		innerWidth: 1200,
		innerHeight: 800,
		getComputedStyle: (el) => ({ display: el?.style?.display || "block", visibility: "visible", opacity: "1", position: "static", overflowY: el?.style?.overflowY || "visible", overflow: el?.style?.overflow || "visible", cursor: el?.style?.cursor || "auto", zIndex: "0" }),
		CSS: { escape: (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&") },
	};
	context.window = context;
	return await vm.runInNewContext(buildScanScript({ maxChars: 8_000, maxNodes: 80 }), context, { filename: "scan-visible-rows-behavior.js" });
}

const rowsDoc = new MockDocument([
	new MockElement("section", { id: "results" }, [
		new MockElement("article", { class: "row-a" }, ["Alpha row has enough descriptive text"]),
		new MockElement("div", { class: "row-b" }, ["Beta row has enough descriptive text"]),
		new MockElement("article", { class: "row-a" }, ["Gamma row has enough descriptive text"]),
		new MockElement("div", { class: "row-b" }, ["Delta row has enough descriptive text"]),
	]),
]);
const rowScan = await runScanInMockPage(rowsDoc);
assert(
	JSON.stringify(rowScan.rows.map((row) => row.text)).includes(JSON.stringify([
		"Alpha row has enough descriptive text",
		"Beta row has enough descriptive text",
		"Gamma row has enough descriptive text",
		"Delta row has enough descriptive text",
	])),
	"scan visible rows must preserve sibling DOM order across interleaved repeated groups",
);

console.log("scan script contract ok");
