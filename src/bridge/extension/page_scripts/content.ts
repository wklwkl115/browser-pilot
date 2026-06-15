import { TID } from "../shared/protocol";

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
  if (!element || element.id === TID) return;
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

function scrubLegacyBridgeNode(root: ParentNode): void {
  const selectors = [`#${TID}`];
  for (const selector of selectors) {
    for (const node of Array.from(root.querySelectorAll(selector))) {
      if (!node || typeof (node as Element).remove !== "function") continue;
      try {
        (node as Element).remove();
      } catch {
        /* best-effort legacy node cleanup */
      }
    }
  }
}

;(function BrowserPilotContentWake() {
  if (/streamlit/i.test(document.title)) return;

  void chrome.runtime.sendMessage({ cmd: "bridge_wake", url: location.href, title: document.title }).catch(() => {});

  if (document.documentElement) scrubLegacyBridgeNode(document.documentElement);

  installBrowserPilotFingerprintResponder();

  new MutationObserver((mutations) => {
    bumpBrowserPilotFingerprint(mutations);
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        const element = node && typeof (node as Element).querySelector === "function" ? node as Element : null;
        if (!element) continue;
        if (element.id === TID) {
          try { element.remove(); } catch {
            /* best-effort mutation cleanup */
          }
          continue;
        }
        if (element.querySelector?.(`#${TID}`)) scrubLegacyBridgeNode(element);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
})();
