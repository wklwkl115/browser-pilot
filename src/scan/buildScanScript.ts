import { ACTIONABLE_ATTRIBUTE_NAMES, ACTIONABLE_HIGH_INTENT_PATTERN, ACTIONABLE_KEYWORD_PATTERN, ACTIONABLE_PRIMARY_INTENT_PATTERN, FRAMEWORK_ACTION_HANDLER_PATTERN, FRAMEWORK_HANDLER_OWNER_PATTERN } from "./actionableRules.js";
import { DOM_ACCESSIBILITY_API_BUNDLE } from "./domAccessibilityApiBundle.js";
import { BROWSER_NOISE_ATTRIBUTE_NAMES, BROWSER_NOISE_ATTRIBUTE_PREFIXES, BROWSER_NOISE_CLASS_PATTERNS, BROWSER_NOISE_IDS, BROWSER_NOISE_SELECTORS, BROWSER_NOISE_TAGS, SCAN_EXTENSION_URL_PATTERN } from "./noiseRules.js";
import { jsonForInlineScript, renderCaptureTemplate } from "../capture/inject.js";
import { SCAN_TEMPLATE } from "../../capture-src/entries/scanTemplate.js";
import { PAGE_WORLD_SCAN_SCHEMA } from "../kernels/abml/pageWorldScan.js";

export type BrowserScanOptions = {
	textOnly?: boolean;
	maxChars?: number;
	maxNodes?: number;
	includeIframes?: boolean;
};

function injectAccessibleNameProvider(script: string): string {
	const markerStart = "  const options = ";
	const markerEnd = ";\n";
	const markerIndex = script.indexOf(markerStart);
	if (markerIndex < 0) throw new Error("scan template options marker missing; update accessible-name provider injection");
	const markerEndIndex = script.indexOf(markerEnd, markerIndex);
	if (markerEndIndex < 0) throw new Error("scan template options terminator missing; update accessible-name provider injection");
	const insertionIndex = markerEndIndex + markerEnd.length;
	const injected = `  const BrowserPilotDomAccessibilityApi = (() => {
    try {
      ${DOM_ACCESSIBILITY_API_BUNDLE}
      return typeof BrowserPilotDomAccessibilityApi === 'object' && BrowserPilotDomAccessibilityApi ? BrowserPilotDomAccessibilityApi : null;
    } catch (_) {
      return null;
    }
  })();
`;
	return script.slice(0, insertionIndex) + injected + script.slice(insertionIndex);
}

function injectPassiveGrowthProbe(script: string): string {
	const marker = "  const rows = collectVisibleRows(scanRoot);\n";
	if (!script.includes(marker)) throw new Error("scan template growth probe marker missing; update scan growth injection");
	return script.replace(marker, marker + "  const growthProbe = undefined;\n");
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
	const rendered = renderCaptureTemplate(SCAN_TEMPLATE, {
		optionsJson: jsonForInlineScript(opts),
		ignoreIdsJson: jsonForInlineScript(BROWSER_NOISE_IDS),
		ignoreTagsJson: jsonForInlineScript(BROWSER_NOISE_TAGS),
		ignoreSelectorsJson: jsonForInlineScript(BROWSER_NOISE_SELECTORS),
		noiseAttrNamesJson: jsonForInlineScript(BROWSER_NOISE_ATTRIBUTE_NAMES),
		noiseAttrPrefixesJson: jsonForInlineScript(BROWSER_NOISE_ATTRIBUTE_PREFIXES),
		noiseClassPatternsJson: jsonForInlineScript(BROWSER_NOISE_CLASS_PATTERNS),
		extensionUrlPatternJson: jsonForInlineScript(SCAN_EXTENSION_URL_PATTERN),
		actionAttrsJson: jsonForInlineScript(ACTIONABLE_ATTRIBUTE_NAMES),
		pageWorldScanSchemaJson: jsonForInlineScript(PAGE_WORLD_SCAN_SCHEMA),
		actionablePatternJson: jsonForInlineScript(ACTIONABLE_KEYWORD_PATTERN),
		highIntentPatternJson: jsonForInlineScript(ACTIONABLE_HIGH_INTENT_PATTERN),
		primaryIntentPatternJson: jsonForInlineScript(ACTIONABLE_PRIMARY_INTENT_PATTERN),
		frameworkOwnerPatternJson: jsonForInlineScript(FRAMEWORK_HANDLER_OWNER_PATTERN),
		frameworkActionPatternJson: jsonForInlineScript(FRAMEWORK_ACTION_HANDLER_PATTERN),
	});
	return injectPassiveGrowthProbe(injectAccessibleNameProvider(rendered));
}
