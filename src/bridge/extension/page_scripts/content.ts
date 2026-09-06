declare const chrome: {
	runtime: {
		sendMessage(message: unknown): Promise<unknown>;
		onMessage?: {
			addListener(
				listener: (
					message: unknown,
					sender: unknown,
					sendResponse: (response?: unknown) => void,
				) => boolean | void,
			): void;
		};
	};
};

type PageFingerprint = {
	changeSeq: number;
	observerEpoch: string;
	url: string;
	title: string;
	readyState: string;
	scrollX: number;
	scrollY: number;
	viewportWidth: number;
	viewportHeight: number;
	devicePixelRatio: number;
	/** Every element in the document; the cheapest structural signal and the one that moves on any add/remove. */
	elementCount: number;
	/** Interactive elements in the whole document (links, buttons, fields, focusable). */
	interactiveCount: number;
	/** Interactive elements intersecting the viewport, counted over a deterministic sample of at most 300. */
	visibleCount: number;
	capturedAt: number;
};

const INTERACTIVE_SELECTOR = "a[href],button,input,textarea,select,[role='button'],[role='link'],[tabindex]";
const VISIBLE_SAMPLE_LIMIT = 300;

let browserPilotChangeSeq = 1;
let browserPilotLastChangedAt = Date.now();
const browserPilotObserverEpoch = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
function bumpBrowserPilotFingerprint(): void {
	browserPilotChangeSeq += 1;
	browserPilotLastChangedAt = Date.now();
}

function bumpBrowserPilotInteractionFingerprint(): void {
	bumpBrowserPilotFingerprint();
}

let browserPilotViewportBumpScheduled = false;
function scheduleBrowserPilotViewportFingerprint(): void {
	if (browserPilotViewportBumpScheduled) return;
	browserPilotViewportBumpScheduled = true;
	requestAnimationFrame(() => {
		browserPilotViewportBumpScheduled = false;
		bumpBrowserPilotFingerprint();
	});
}

function installBrowserPilotInteractionFingerprinting(): void {
	for (const type of ["input", "change", "focusin", "focusout"]) {
		document.addEventListener(type, bumpBrowserPilotInteractionFingerprint, { capture: true, passive: true });
	}
	document.addEventListener("scroll", scheduleBrowserPilotViewportFingerprint, { capture: true, passive: true });
	window.addEventListener("resize", scheduleBrowserPilotViewportFingerprint, { passive: true });
}

function currentBrowserPilotElementCounts(): { elementCount: number; interactiveCount: number; visibleCount: number } {
	const root = document.body ?? document.documentElement;
	if (!root) return { elementCount: 0, interactiveCount: 0, visibleCount: 0 };
	const elementCount = document.getElementsByTagName("*").length;
	const interactive = root.querySelectorAll(INTERACTIVE_SELECTOR);
	const interactiveCount = interactive.length;
	// Layout reads are the expensive part, so sample the interactive set with a fixed stride. The
	// stride depends only on the count, which keeps the sample stable while the DOM is unchanged.
	const stride = Math.max(1, Math.ceil(interactiveCount / VISIBLE_SAMPLE_LIMIT));
	const viewportWidth = window.innerWidth;
	const viewportHeight = window.innerHeight;
	let visibleCount = 0;
	for (let index = 0; index < interactiveCount; index += stride) {
		const rect = interactive[index]!.getBoundingClientRect();
		if (
			(rect.width > 0 || rect.height > 0) &&
			rect.bottom > 0 &&
			rect.right > 0 &&
			rect.top < viewportHeight &&
			rect.left < viewportWidth
		)
			visibleCount += 1;
	}
	return { elementCount, interactiveCount, visibleCount };
}

function currentBrowserPilotFingerprint(): PageFingerprint {
	const elementCounts = currentBrowserPilotElementCounts();
	return {
		changeSeq: browserPilotChangeSeq,
		observerEpoch: browserPilotObserverEpoch,
		url: location.href,
		title: document.title,
		readyState: document.readyState,
		scrollX: Number(window.scrollX || 0),
		scrollY: Number(window.scrollY || 0),
		viewportWidth: Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0),
		viewportHeight: Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0),
		devicePixelRatio: Number(window.devicePixelRatio || 1),
		...elementCounts,
		capturedAt: browserPilotLastChangedAt,
	};
}

function installBrowserPilotFingerprintResponder(): void {
	chrome.runtime.onMessage?.addListener((message, _sender, sendResponse) => {
		const record = message && typeof message === "object" ? (message as Record<string, unknown>) : {};
		if (record.cmd !== "browserPilot.contentFingerprint") return false;
		const data = currentBrowserPilotFingerprint();
		sendResponse({ ok: true, data });
		return true;
	});
}

function reportBrowserPilotPrerenderActivation(): void {
	if ((globalThis as unknown as { top?: unknown }).top !== (globalThis as unknown)) return;
	const report = (activationStart?: number) => {
		void chrome.runtime
			.sendMessage({
				type: "browser-pilot-prerender-activated",
				...(activationStart && activationStart > 0 ? { activationStart } : {}),
				url: location.href,
			})
			.catch(() => {});
	};
	const prerenderDocument = document as Document & { prerendering?: boolean };
	if (prerenderDocument.prerendering === true) {
		document.addEventListener("prerenderingchange", () => report(), { once: true });
		return;
	}
	const navigation = performance.getEntriesByType("navigation")[0] as
		(PerformanceEntry & { activationStart?: number }) | undefined;
	const activationStart = Number(navigation?.activationStart ?? 0);
	if (!(activationStart > 0)) return;
	report(activationStart);
}

(function BrowserPilotContentWake() {
	void chrome.runtime.sendMessage({ cmd: "bridge_wake", url: location.href, title: document.title }).catch(() => {});
	reportBrowserPilotPrerenderActivation();

	installBrowserPilotFingerprintResponder();
	installBrowserPilotInteractionFingerprinting();

	new MutationObserver(bumpBrowserPilotFingerprint).observe(document.documentElement, {
		childList: true,
		subtree: true,
		attributes: true,
		characterData: true,
	});
})();
