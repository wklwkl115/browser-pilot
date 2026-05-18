import { readFileSync } from "node:fs";
import { buildScanScript } from "../../src/scan/buildScanScript.ts";

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

const noiseRules = readFileSync(new URL("../../src/scan/noiseRules.ts", import.meta.url), "utf8");
const actionableRules = readFileSync(new URL("../../src/scan/actionableRules.ts", import.meta.url), "utf8");
assert(actionableRules.includes("ACTIONABLE_KEYWORD_PATTERN") && actionableRules.includes("FRAMEWORK_HANDLER_OWNER_PATTERN"), "scan actionable heuristics must live in actionableRules.ts");
assert(noiseRules.includes("SCAN_IGNORE_IDS"), "scan noise ids must live in noiseRules.ts");
assert(noiseRules.includes("SCAN_IGNORE_SELECTORS"), "scan noise selectors must live in noiseRules.ts");
assert(noiseRules.includes("SCAN_EXTENSION_URL_PATTERN"), "scan extension URL pattern must live in noiseRules.ts");
assert(noiseRules.includes("TRANSLATION_NOISE_SELECTORS"), "translation plugin selectors must live in noiseRules.ts");
assert(noiseRules.includes("BROWSER_NOISE_ATTRIBUTE_PREFIXES"), "translation plugin attribute prefixes must live in noiseRules.ts");

for (const options of [
	{ textOnly: true, maxChars: 4_000 },
	{ textOnly: false, maxChars: 4_000, includeIframes: true },
]) {
	const script = buildScanScript(options);
	new Function(script);
	assert(script.includes("\\s+"), "scan script must preserve regex escapes");
	assert(script.includes("'\\n\\n--- iframe ---\\n\\n'"), "scan script must preserve escaped iframe separator");
	assert(script.includes("pi-browser-bridge-ind"), "scan script must filter Pi bridge indicator noise");
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
	assert(script.includes("topLayerRoot") && script.includes("top_layer") && script.includes("modalish") && script.includes("popupish") && script.includes("fixedLayer"), "scan script must prefer real top-layer/modal roots without treating ordinary player popups as modal roots");
	assert(script.includes("collectActionables") && script.includes("actionables") && script.includes("hitOk") && script.includes("selectorFor"), "scan script must expose GA-style actionable candidates for browser_execute scripts");
	assert(script.includes("frameworkHandlers") && script.includes("ACTIONABLE_RE") && script.includes("FRAMEWORK_OWNER_RE") && script.includes("data-e2e") && script.includes("point"), "scan actionables must cover framework delegated clicks, configured actionable controls and CDP-ready center points");
	assert(script.includes(":-webkit-autofill") && script.includes("data-autofilled") && script.includes("protected-autofill"), "scan script must preserve GA-style autofill protected-state hints");
	assert(script.includes("collectListHints") && script.includes("list_hints") && script.includes("hiddenCount") && script.includes("map(cssEscape).join('.')"), "scan script must expose GA-style repeated list compression hints with CSS-escaped selector classes");
	assert(script.includes("input:not([type=hidden])"), "scan text mode must preserve visible form controls");
}

console.log("scan script contract ok");
