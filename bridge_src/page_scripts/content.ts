import { TID } from "../shared/protocol";

declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
  };
};

function scrubLegacyBridgeNode(root: ParentNode): void {
  const selectors = [`#${TID}`];
  for (const selector of selectors) {
    for (const node of Array.from(root.querySelectorAll(selector))) {
      if (!node || typeof (node as Element).remove !== "function") continue;
      try {
        (node as Element).remove();
      } catch {}
    }
  }
}

;(function PiBrowserContentWake() {
  if (/streamlit/i.test(document.title)) return;

  void chrome.runtime.sendMessage({ cmd: "bridge_wake", url: location.href, title: document.title }).catch(() => {});

  if (document.documentElement) scrubLegacyBridgeNode(document.documentElement);

  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        const element = node && typeof (node as Element).querySelector === "function" ? node as Element : null;
        if (!element) continue;
        if (element.id === TID) {
          try { element.remove(); } catch {}
          continue;
        }
        if (element.querySelector?.(`#${TID}`)) scrubLegacyBridgeNode(element);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
