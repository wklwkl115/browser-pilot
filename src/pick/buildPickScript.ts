import { jsonForInlineScript, renderCaptureTemplate } from "../capture/inject.js";
import { PICK_CLEANUP_TEMPLATE, PICK_TEMPLATE } from "../capture/generated/pickBundle.js";
import { BROWSER_NOISE_ATTRIBUTE_NAMES, BROWSER_NOISE_ATTRIBUTE_PREFIXES, BROWSER_NOISE_CLASS_PATTERNS, BROWSER_NOISE_SELECTORS } from "../scan/noiseRules.js";

export type BrowserPickOptions = {
	message: string;
	multiple?: boolean;
	timeoutMs?: number;
	pickId?: string;
};

export function buildPickScript(options: BrowserPickOptions): string {
	const timeoutMs = Math.max(1_000, Math.floor(Number(options.timeoutMs || 120_000)));
	const payload = jsonForInlineScript({
		message: options.message,
		multiple: options.multiple !== false,
		timeoutMs: Math.max(1_000, timeoutMs - 500),
		pickId: options.pickId || `pick-${Date.now()}-${Math.random().toString(16).slice(2)}`,
		noiseSelectors: BROWSER_NOISE_SELECTORS,
		noiseAttrNames: BROWSER_NOISE_ATTRIBUTE_NAMES,
		noiseAttrPrefixes: BROWSER_NOISE_ATTRIBUTE_PREFIXES,
		noiseClassPatterns: BROWSER_NOISE_CLASS_PATTERNS,
	});
	return renderCaptureTemplate(PICK_TEMPLATE, { payload });
}

export function buildPickCleanupScript(pickId: string): string {
	return renderCaptureTemplate(PICK_CLEANUP_TEMPLATE, { payload: jsonForInlineScript({ pickId }) });
}
