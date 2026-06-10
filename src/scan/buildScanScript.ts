import { ACTIONABLE_ATTRIBUTE_NAMES, ACTIONABLE_HIGH_INTENT_PATTERN, ACTIONABLE_KEYWORD_PATTERN, ACTIONABLE_PRIMARY_INTENT_PATTERN, FRAMEWORK_ACTION_HANDLER_PATTERN, FRAMEWORK_HANDLER_OWNER_PATTERN } from "./actionableRules.js";
import { BROWSER_NOISE_ATTRIBUTE_NAMES, BROWSER_NOISE_ATTRIBUTE_PREFIXES, BROWSER_NOISE_CLASS_PATTERNS, SCAN_EXTENSION_URL_PATTERN, SCAN_IGNORE_IDS, SCAN_IGNORE_SELECTORS, SCAN_IGNORE_TAGS } from "./noiseRules.js";
import { jsonForInlineScript as captureJsonForInlineScript, renderCaptureTemplate } from "../capture/inject.js";
import { SCAN_TEMPLATE } from "../capture/generated/scanBundle.js";

export type BrowserScanOptions = {
	textOnly?: boolean;
	maxChars?: number;
	maxNodes?: number;
	includeIframes?: boolean;
};

export function jsonForInlineScript(value: unknown): string {
	return captureJsonForInlineScript(value);
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
	const n = Number(value);
	const safe = Number.isFinite(n) ? Math.floor(n) : fallback;
	return Math.max(min, Math.min(max, safe));
}

export function buildScanScript(options: BrowserScanOptions = {}): string {
	const opts = {
		textOnly: options.textOnly === true,
		maxChars: boundedInt(options.maxChars, 35_000, 1_000, 500_000),
		maxNodes: boundedInt(options.maxNodes, 4_000, 100, 20_000),
		includeIframes: options.includeIframes !== false,
	};
	return renderCaptureTemplate(SCAN_TEMPLATE, {
		optionsJson: jsonForInlineScript(opts),
		ignoreIdsJson: jsonForInlineScript(SCAN_IGNORE_IDS),
		ignoreTagsJson: jsonForInlineScript(SCAN_IGNORE_TAGS),
		ignoreSelectorsJson: jsonForInlineScript(SCAN_IGNORE_SELECTORS),
		noiseAttrNamesJson: jsonForInlineScript(BROWSER_NOISE_ATTRIBUTE_NAMES),
		noiseAttrPrefixesJson: jsonForInlineScript(BROWSER_NOISE_ATTRIBUTE_PREFIXES),
		noiseClassPatternsJson: jsonForInlineScript(BROWSER_NOISE_CLASS_PATTERNS),
		extensionUrlPatternJson: jsonForInlineScript(SCAN_EXTENSION_URL_PATTERN),
		actionAttrsJson: jsonForInlineScript(ACTIONABLE_ATTRIBUTE_NAMES),
		actionablePatternJson: jsonForInlineScript(ACTIONABLE_KEYWORD_PATTERN),
		highIntentPatternJson: jsonForInlineScript(ACTIONABLE_HIGH_INTENT_PATTERN),
		primaryIntentPatternJson: jsonForInlineScript(ACTIONABLE_PRIMARY_INTENT_PATTERN),
		frameworkOwnerPatternJson: jsonForInlineScript(FRAMEWORK_HANDLER_OWNER_PATTERN),
		frameworkActionPatternJson: jsonForInlineScript(FRAMEWORK_ACTION_HANDLER_PATTERN),
	});
}
