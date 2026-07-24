declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    onMessage?: {
      addListener(listener: (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean | void): void;
    };
  };
};

type PageFingerprint = {
  changeSeq: number;
  url: string;
  title: string;
  readyState: string;
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  visibleCount: number;
  interactiveCount: number;
  capturedAt: number;
  dirty?: {
    roots: string[];
    overflow: boolean;
    sinceSeq: number;
  };
};

const BROWSER_PILOT_DIRTY_ROOT_LIMIT = 32;
let browserPilotChangeSeq = 1;
let browserPilotLastChangedAt = Date.now();
let browserPilotDirtySinceSeq = 1;
let browserPilotDirtyOverflow = false;
const browserPilotDirtyRoots = new Set<string>();

function browserPilotCssEscape(value: string): string {
  try {
    const css = (globalThis as unknown as { CSS?: { escape?: (input: string) => string } }).CSS;
    return css?.escape ? css.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  } catch {
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }
}

function browserPilotSelectorForDirtyElement(element: Element): string {
  if (element.id) return `#${browserPilotCssEscape(element.id)}`;
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body && current !== document.documentElement && parts.length < 5) {
    let part = current.tagName.toLowerCase();
    const className = typeof current.className === "string" ? current.className : "";
    const cls = className.split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) part += `.${cls.map(browserPilotCssEscape).join(".")}`;
    parts.unshift(part);
    current = current.parentElement;
  }
  return parts.join(" > ") || element.tagName.toLowerCase();
}

function browserPilotDirtyElementFromNode(node: Node | null): Element | undefined {
  if (!node) return undefined;
  if (node.nodeType === Node.ELEMENT_NODE) return node as Element;
  const parent = (node as ChildNode).parentElement;
  return parent || undefined;
}

function recordBrowserPilotDirtyRoot(element: Element | undefined): void {
  if (!element) return;
  if (browserPilotDirtyRoots.size >= BROWSER_PILOT_DIRTY_ROOT_LIMIT) {
    browserPilotDirtyOverflow = true;
    return;
  }
  browserPilotDirtyRoots.add(browserPilotSelectorForDirtyElement(element));
}

function bumpBrowserPilotFingerprint(mutations: MutationRecord[] = []): void {
  const priorSeq = browserPilotChangeSeq;
  browserPilotChangeSeq += 1;
  browserPilotLastChangedAt = Date.now();
  if (!browserPilotDirtyRoots.size && !browserPilotDirtyOverflow) browserPilotDirtySinceSeq = priorSeq;
  for (const mutation of mutations) {
    recordBrowserPilotDirtyRoot(browserPilotDirtyElementFromNode(mutation.target));
    for (const node of Array.from(mutation.addedNodes)) recordBrowserPilotDirtyRoot(browserPilotDirtyElementFromNode(node));
    for (const node of Array.from(mutation.removedNodes)) recordBrowserPilotDirtyRoot(browserPilotDirtyElementFromNode(node) || browserPilotDirtyElementFromNode(mutation.target));
  }
}

function bumpBrowserPilotInteractionFingerprint(event: Event): void {
  const priorSeq = browserPilotChangeSeq;
  browserPilotChangeSeq += 1;
  browserPilotLastChangedAt = Date.now();
  if (!browserPilotDirtyRoots.size && !browserPilotDirtyOverflow) browserPilotDirtySinceSeq = priorSeq;
  recordBrowserPilotDirtyRoot(event.target instanceof Element ? event.target : document.documentElement);
}

let browserPilotViewportBumpScheduled = false;
function scheduleBrowserPilotViewportFingerprint(event: Event): void {
  if (browserPilotViewportBumpScheduled) return;
  browserPilotViewportBumpScheduled = true;
  requestAnimationFrame(() => {
    browserPilotViewportBumpScheduled = false;
    bumpBrowserPilotInteractionFingerprint(event);
  });
}

function installBrowserPilotInteractionFingerprinting(): void {
  for (const type of ["input", "change", "focusin", "focusout"]) {
    document.addEventListener(type, bumpBrowserPilotInteractionFingerprint, { capture: true, passive: true });
  }
  document.addEventListener("scroll", scheduleBrowserPilotViewportFingerprint, { capture: true, passive: true });
  window.addEventListener("resize", scheduleBrowserPilotViewportFingerprint, { passive: true });
}

function countVisibleElements(elements: Element[]): number {
  let count = 0;
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    if ((rect.width > 0 || rect.height > 0) && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth) count += 1;
  }
  return count;
}

function currentBrowserPilotFingerprint(): PageFingerprint {
  const interactive = Array.from(document.querySelectorAll("a[href],button,input,textarea,select,[role='button'],[tabindex]"));
  return {
    changeSeq: browserPilotChangeSeq,
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    scrollX: Number(window.scrollX || 0),
    scrollY: Number(window.scrollY || 0),
    viewportWidth: Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0),
    viewportHeight: Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0),
    devicePixelRatio: Number(window.devicePixelRatio || 1),
    visibleCount: countVisibleElements(Array.from(document.body?.querySelectorAll("*") ?? []).slice(0, 500)),
    interactiveCount: interactive.length,
    capturedAt: browserPilotLastChangedAt,
    dirty: {
      roots: Array.from(browserPilotDirtyRoots).slice(0, BROWSER_PILOT_DIRTY_ROOT_LIMIT),
      overflow: browserPilotDirtyOverflow,
      sinceSeq: browserPilotDirtySinceSeq,
    },
  };
}

function drainBrowserPilotDirtyRoots(): void {
  browserPilotDirtyRoots.clear();
  browserPilotDirtyOverflow = false;
  browserPilotDirtySinceSeq = browserPilotChangeSeq;
}

function installBrowserPilotFingerprintResponder(): void {
  chrome.runtime.onMessage?.addListener((message, _sender, sendResponse) => {
    const record = message && typeof message === "object" ? message as Record<string, unknown> : {};
    if (record.cmd !== "browserPilot.contentFingerprint") return false;
    const data = currentBrowserPilotFingerprint();
    if (record.drainDirty === true) drainBrowserPilotDirtyRoots();
    sendResponse({ ok: true, data });
    return true;
  });
}

function reportBrowserPilotPrerenderActivation(): void {
	if ((globalThis as unknown as { top?: unknown }).top !== (globalThis as unknown)) return;
	const report = (activationStart?: number) => {
		void chrome.runtime.sendMessage({ type: "browser-pilot-prerender-activated", ...(activationStart && activationStart > 0 ? { activationStart } : {}), url: location.href }).catch(() => {});
	};
	const prerenderDocument = document as Document & { prerendering?: boolean };
	if (prerenderDocument.prerendering === true) {
		document.addEventListener("prerenderingchange", () => report(), { once: true });
		return;
	}
	const navigation = performance.getEntriesByType("navigation")[0] as (PerformanceEntry & { activationStart?: number }) | undefined;
	const activationStart = Number(navigation?.activationStart ?? 0);
	if (!(activationStart > 0)) return;
	report(activationStart);
}

;(function BrowserPilotContentWake() {
  if (/streamlit/i.test(document.title)) return;

	void chrome.runtime.sendMessage({ cmd: "bridge_wake", url: location.href, title: document.title }).catch(() => {});
	reportBrowserPilotPrerenderActivation();

  installBrowserPilotFingerprintResponder();
  installBrowserPilotInteractionFingerprinting();

  new MutationObserver(bumpBrowserPilotFingerprint).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
})();
