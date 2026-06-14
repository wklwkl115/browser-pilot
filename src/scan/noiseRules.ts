export const BROWSER_NOISE_IDS = [
	"ljq-ind",
	"browser-pilot-bridge-ind",
	"__pi_browser_bridge_request__",
	"aix-drop-panel",
	"aix-supported-by",
	"goog-gt-tt",
	"google_translate_element",
	"immersive-translate-popup",
	"mate-translate-tooltip",
] as const;

export const BROWSER_NOISE_TAGS = ["READ-FROG"] as const;

export const TRANSLATION_NOISE_SELECTORS = [
	"read-frog",
	".read-frog-translated-content-wrapper",
	".read-frog-translated-block-content",
	".read-frog-translated-inline-content",
	"[class*=\"read-frog-translated\"]",
	"#goog-gt-tt",
	"#google_translate_element",
	".goog-te-banner-frame",
	".goog-te-balloon-frame",
	".goog-te-menu-frame",
	".goog-tooltip",
	".goog-text-highlight",
	".skiptranslate",
	"[class^=\"VIpgJd-\"]",
	"[class*=\" VIpgJd-\"]",
	"#immersive-translate-popup",
	".immersive-translate-target-wrapper",
	".immersive-translate-target-translation",
	"[class*=\"immersive-translate\"]",
	"#mate-translate-tooltip",
	".mate-translate-tooltip",
	"[class*=\"mate-translate\"]",
] as const;

export const BROWSER_NOISE_SELECTORS = [
	"#browser-pilot-bridge-ind",
	"#ljq-ind",
	"#__pi_browser_bridge_request__",
	"#aix-drop-panel",
	"#aix-supported-by",
	"[id^=\"aix-drop-panel\"]",
	"[data-testid=\"floating-button-container\"]",
	...TRANSLATION_NOISE_SELECTORS,
] as const;

export const BROWSER_NOISE_ATTRIBUTE_PREFIXES = [
	"data-read-frog",
	"data-immersive-translate",
	"data-google-translate",
	"data-mate-translate",
] as const;

export const BROWSER_NOISE_ATTRIBUTE_NAMES = [
	"data-read-frog-walked",
	"data-read-frog-paragraph",
	"data-read-frog-block-node",
	"data-read-frog-inline-node",
] as const;

export const BROWSER_NOISE_CLASS_PATTERNS = [
	"read-frog-translated",
	"goog-te",
	"goog-tooltip",
	"goog-text-highlight",
	"skiptranslate",
	"VIpgJd-",
	"immersive-translate",
	"mate-translate",
] as const;

export const SCAN_IGNORE_IDS = BROWSER_NOISE_IDS;
export const SCAN_IGNORE_TAGS = BROWSER_NOISE_TAGS;
export const SCAN_IGNORE_SELECTORS = BROWSER_NOISE_SELECTORS;
export const SCAN_EXTENSION_URL_PATTERN = "^(chrome|moz|safari)-extension://";
