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
};

let piBrowserChangeSeq = 1;
let piBrowserLastChangedAt = Date.now();

function bumpPiBrowserFingerprint(): void {
  piBrowserChangeSeq += 1;
  piBrowserLastChangedAt = Date.now();
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
  };
}

function installPiBrowserFingerprintResponder(): void {
  chrome.runtime.onMessage?.addListener((message, _sender, sendResponse) => {
    const record = message && typeof message === "object" ? message as Record<string, unknown> : {};
    if (record.cmd !== "pi.contentFingerprint") return false;
    sendResponse({ ok: true, data: currentPiBrowserFingerprint() });
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
    bumpPiBrowserFingerprint();
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
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
