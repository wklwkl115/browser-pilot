import { ACTIONABLE_ATTRIBUTE_NAMES, ACTIONABLE_HIGH_INTENT_PATTERN, ACTIONABLE_KEYWORD_PATTERN, ACTIONABLE_PRIMARY_INTENT_PATTERN, FRAMEWORK_ACTION_HANDLER_PATTERN, FRAMEWORK_HANDLER_OWNER_PATTERN } from "./actionableRules.js";
import { DOM_ACCESSIBILITY_API_BUNDLE } from "./domAccessibilityApiBundle.js";
import { BROWSER_NOISE_CLASS_PATTERNS, BROWSER_NOISE_IDS, BROWSER_NOISE_SELECTORS, BROWSER_NOISE_TAGS, SCAN_EXTENSION_URL_PATTERN } from "./noiseRules.js";
import { jsonForInlineScript } from "../capture/inject.js";
import { scanPage } from "../../capture-src/entries/scanTemplate.js";
import { PAGE_WORLD_SCAN_SCHEMA } from "../kernels/abml/pageWorldScan.js";

export type BrowserScanOptions = {
	maxChars?: number;
	maxNodes?: number;
};

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
	const n = Number(value);
	const safe = Number.isFinite(n) ? Math.floor(n) : fallback;
	return Math.max(min, Math.min(max, safe));
}

export function buildScanScript(options: BrowserScanOptions = {}): string {
	const opts = {
		maxChars: boundedInt(options.maxChars, 35_000, 1_000, 500_000),
		// ponytail: 200k-node safety ceiling; raise only after capture can be chunked within the tool deadline.
		maxNodes: boundedInt(options.maxNodes, 200_000, 100, 200_000),
	};
	const config = {
		options: opts,
		ignoreIds: BROWSER_NOISE_IDS,
		ignoreTags: BROWSER_NOISE_TAGS,
		ignoreSelectors: BROWSER_NOISE_SELECTORS,
		noiseClassPatterns: BROWSER_NOISE_CLASS_PATTERNS,
		extensionUrlPattern: SCAN_EXTENSION_URL_PATTERN,
		actionAttrs: ACTIONABLE_ATTRIBUTE_NAMES,
		pageWorldScanSchema: PAGE_WORLD_SCAN_SCHEMA,
		actionablePattern: ACTIONABLE_KEYWORD_PATTERN,
		highIntentPattern: ACTIONABLE_HIGH_INTENT_PATTERN,
		primaryIntentPattern: ACTIONABLE_PRIMARY_INTENT_PATTERN,
		frameworkOwnerPattern: FRAMEWORK_HANDLER_OWNER_PATTERN,
		frameworkActionPattern: FRAMEWORK_ACTION_HANDLER_PATTERN,
	};
	return `(() => {
	const __name = (target) => target;
	const BrowserPilotDomAccessibilityApi = (() => {
		try {
			${DOM_ACCESSIBILITY_API_BUNDLE}
			return typeof BrowserPilotDomAccessibilityApi === "object" && BrowserPilotDomAccessibilityApi ? BrowserPilotDomAccessibilityApi : null;
		} catch {
			return null;
		}
	})();
	return (${scanPage.toString()})(${jsonForInlineScript(config)});
})()`;
}
