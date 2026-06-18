import { jsonForInlineScript, renderCaptureTemplate } from "../capture/inject.js";
import { CONTENT_TEMPLATE } from "../../capture-src/entries/contentTemplate.js";
import { BROWSER_NOISE_SELECTORS } from "../scan/noiseRules.js";

export type BrowserContentOptions = {
	selector?: string;
	maxChars?: number;
	includeLinks?: boolean;
};

export function buildContentScript(options: BrowserContentOptions = {}): string {
	const payload = jsonForInlineScript({
		selector: options.selector || "",
		maxChars: Math.max(1, Math.floor(Number(options.maxChars || 200_000))),
		includeLinks: options.includeLinks !== false,
		dropSelector: `script,style,noscript,template,svg,canvas,iframe,object,embed,nav,header,footer,aside,[hidden],[aria-hidden="true"],${BROWSER_NOISE_SELECTORS.join(",")}`,
	});
	return renderCaptureTemplate(CONTENT_TEMPLATE, { payload });
}
