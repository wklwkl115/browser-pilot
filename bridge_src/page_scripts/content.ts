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

const PI_BROWSER_DIRTY_ROOT_LIMIT = 32;
let piBrowserChangeSeq = 1;
let piBrowserLastChangedAt = Date.now();
let piBrowserDirtySinceSeq = 1;
let piBrowserDirtyOverflow = false;
const piBrowserDirtyRoots = new Set<string>();

function piBrowserCssEscape(value: string): string {
  try {
    const css = (globalThis as unknown as { CSS?: { escape?: (input: string) => string } }).CSS;
    return css?.escape ? css.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  } catch {
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }
}

function piBrowserSelectorForDirtyElement(element: Element): string {
  if (element.id) return `#${piBrowserCssEscape(element.id)}`;
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body && current !== document.documentElement && parts.length < 5) {
    let part = current.tagName.toLowerCase();
    const className = typeof current.className === "string" ? current.className : "";
    const cls = className.split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) part += `.${cls.map(piBrowserCssEscape).join(".")}`;
    parts.unshift(part);
    current = current.parentElement;
  }
  return parts.join(" > ") || element.tagName.toLowerCase();
}

function piBrowserDirtyElementFromNode(node: Node | null): Element | undefined {
  if (!node) return undefined;
  if (node.nodeType === Node.ELEMENT_NODE) return node as Element;
  const parent = (node as ChildNode).parentElement;
  return parent || undefined;
}

function recordPiBrowserDirtyRoot(element: Element | undefined): void {
  if (!element || element.id === TID) return;
  if (piBrowserDirtyRoots.size >= PI_BROWSER_DIRTY_ROOT_LIMIT) {
    piBrowserDirtyOverflow = true;
    return;
  }
  piBrowserDirtyRoots.add(piBrowserSelectorForDirtyElement(element));
}

function bumpPiBrowserFingerprint(mutations: MutationRecord[] = []): void {
  const priorSeq = piBrowserChangeSeq;
  piBrowserChangeSeq += 1;
  piBrowserLastChangedAt = Date.now();
  if (!piBrowserDirtyRoots.size && !piBrowserDirtyOverflow) piBrowserDirtySinceSeq = priorSeq;
  for (const mutation of mutations) {
    recordPiBrowserDirtyRoot(piBrowserDirtyElementFromNode(mutation.target));
    for (const node of Array.from(mutation.addedNodes)) recordPiBrowserDirtyRoot(piBrowserDirtyElementFromNode(node));
    for (const node of Array.from(mutation.removedNodes)) recordPiBrowserDirtyRoot(piBrowserDirtyElementFromNode(node) || piBrowserDirtyElementFromNode(mutation.target));
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

function currentPiBrowserFingerprint(): PageFingerprint {
  const interactive = Array.from(document.querySelectorAll("a[href],button,input,textarea,select,[role='button'],[tabindex]"));
  return {
    changeSeq: piBrowserChangeSeq,
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    visibleCount: countVisibleElements(Array.from(document.body?.querySelectorAll("*") ?? []).slice(0, 500)),
    interactiveCount: interactive.length,
    capturedAt: piBrowserLastChangedAt,
    dirty: {
      roots: Array.from(piBrowserDirtyRoots).slice(0, PI_BROWSER_DIRTY_ROOT_LIMIT),
      overflow: piBrowserDirtyOverflow,
      sinceSeq: piBrowserDirtySinceSeq,
    },
  };
}

function drainPiBrowserDirtyRoots(): void {
  piBrowserDirtyRoots.clear();
  piBrowserDirtyOverflow = false;
  piBrowserDirtySinceSeq = piBrowserChangeSeq;
}

function installPiBrowserFingerprintResponder(): void {
  chrome.runtime.onMessage?.addListener((message, _sender, sendResponse) => {
    const record = message && typeof message === "object" ? message as Record<string, unknown> : {};
    if (record.cmd !== "pi.contentFingerprint") return false;
    const data = currentPiBrowserFingerprint();
    if (record.drainDirty === true) drainPiBrowserDirtyRoots();
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

;(function PiBrowserContentWake() {
  if (/streamlit/i.test(document.title)) return;

  void chrome.runtime.sendMessage({ cmd: "bridge_wake", url: location.href, title: document.title }).catch(() => {});

  if (document.documentElement) scrubLegacyBridgeNode(document.documentElement);

  installPiBrowserFingerprintResponder();

  new MutationObserver((mutations) => {
    bumpPiBrowserFingerprint(mutations);
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
