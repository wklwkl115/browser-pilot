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

type BrowserPilotOperationDeliveryMessage = Record<string, unknown> | (() => Record<string, unknown>);
type BrowserPilotContentOperationState = {
  observer: MutationObserver;
  mutationCount: number;
  deliveryFailures: number;
  delivery: Promise<void>;
  enqueue: (message: BrowserPilotOperationDeliveryMessage, trackFailure?: boolean) => Promise<unknown>;
  cleanupInteractions: () => void;
  expiryTimer?: ReturnType<typeof setTimeout>;
};

const browserPilotContentOperations = new Map<string, BrowserPilotContentOperationState>();

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

function removeBrowserPilotContentOperation(operationId: string): boolean {
  const state = browserPilotContentOperations.get(operationId);
  if (!state) return false;
  state.observer.disconnect();
  state.cleanupInteractions();
  if (state.expiryTimer) clearTimeout(state.expiryTimer);
  browserPilotContentOperations.delete(operationId);
  return true;
}

function beginBrowserPilotContentOperation(operationId: string, ttlMs: number): Record<string, unknown> {
  removeBrowserPilotContentOperation(operationId);
  let delivery = Promise.resolve();
  let deliveryFailures = 0;
  const enqueue = (message: BrowserPilotOperationDeliveryMessage, trackFailure = true): Promise<unknown> => {
    const send = () => chrome.runtime.sendMessage(typeof message === "function" ? message() : message);
    const response = delivery.then(send, send);
    const tracked = trackFailure ? response.then((value) => {
      const result = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      if (result.ok !== true) deliveryFailures += 1;
      return value;
    }, (error) => {
      deliveryFailures += 1;
      throw error;
    }) : response;
    delivery = tracked.then(() => undefined, () => undefined);
    return tracked;
  };
  let mutationCount = 0;
  const deliver = (batchCount: number, signalType?: string) => {
    mutationCount += batchCount;
    void enqueue({ type: "browser-pilot-operation-dom-event", operationId, mutationCount, batchCount, ...(signalType ? { signalType } : {}) }).catch(() => undefined);
  };
  const observer = new MutationObserver((records) => deliver(records.length));
  const interaction = (event: Event) => deliver(1, event.type);
  let viewportScheduled = false;
  const viewport = (event: Event) => {
    if (viewportScheduled) return;
    viewportScheduled = true;
    interaction(event);
    queueMicrotask(() => { viewportScheduled = false; });
  };
  for (const type of ["input", "change", "focusin", "focusout"]) document.addEventListener(type, interaction, { capture: true, passive: true });
  document.addEventListener("scroll", viewport, { capture: true, passive: true });
  globalThis.addEventListener("resize", viewport, { passive: true });
  const cleanupInteractions = () => {
    for (const type of ["input", "change", "focusin", "focusout"]) document.removeEventListener(type, interaction, { capture: true });
    document.removeEventListener("scroll", viewport, { capture: true });
    globalThis.removeEventListener("resize", viewport);
  };
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  const state: BrowserPilotContentOperationState = {
    observer,
    get mutationCount() { return mutationCount; },
    set mutationCount(value) { mutationCount = value; },
    get deliveryFailures() { return deliveryFailures; },
    set deliveryFailures(value) { deliveryFailures = value; },
    get delivery() { return delivery; },
    set delivery(value) { delivery = value; },
    enqueue,
    cleanupInteractions,
  };
  browserPilotContentOperations.set(operationId, state);
  state.expiryTimer = setTimeout(() => {
    if (browserPilotContentOperations.get(operationId) === state) removeBrowserPilotContentOperation(operationId);
  }, Math.max(1, Math.floor(ttlMs)));
  return { ok: true, operationId, observerArmed: true };
}

async function checkpointBrowserPilotContentOperation(operationId: string, fenceId: string, eventType: "checkpoint" | "dispatch"): Promise<Record<string, unknown>> {
  const state = browserPilotContentOperations.get(operationId);
  if (!state) return { ok: false, operationId, observerFound: false, deliveryFailures: 0, deliveryReliable: false };
  const records = state.observer.takeRecords();
  if (records.length > 0) {
    state.mutationCount += records.length;
    void state.enqueue({ type: "browser-pilot-operation-dom-event", operationId, mutationCount: state.mutationCount, batchCount: records.length }).catch(() => undefined);
  }
  const response = await state.enqueue(() => ({
    type: "browser-pilot-operation-checkpoint-event",
    operationId,
    fenceId,
    eventType,
    deliveryFailures: state.deliveryFailures,
  }), false);
  const result = response && typeof response === "object" && !Array.isArray(response) ? response as Record<string, unknown> : {};
  return {
    mutationCount: state.mutationCount,
    batchCount: records.length,
    observerFound: result.ok === true,
    deliveryFailures: Number(result.deliveryFailures),
    deliveryReliable: result.deliveryReliable === true,
    fenceId,
    checkedAt: Number(result.checkedAt),
    sourceSequence: Number(result.sourceSequence),
  };
}

async function handleBrowserPilotContentOperationMessage(record: Record<string, unknown>): Promise<Record<string, unknown>> {
  const command = String(record.cmd || "");
  const operationId = typeof record.operationId === "string" ? record.operationId.trim() : "";
  if (!operationId) return { ok: false, error: "operationId is required" };
  if (command === "browserPilot.operation.begin") return beginBrowserPilotContentOperation(operationId, Number(record.ttlMs));
  if (command === "browserPilot.operation.remove") return { ok: true, operationId, removed: removeBrowserPilotContentOperation(operationId) };
  if (command !== "browserPilot.operation.checkpoint") return { ok: false, operationId, error: "unknown operation content command" };
  const fenceId = typeof record.fenceId === "string" ? record.fenceId.trim() : "";
  if (!fenceId) return { ok: false, operationId, error: "fenceId is required" };
  return await checkpointBrowserPilotContentOperation(operationId, fenceId, record.eventType === "dispatch" ? "dispatch" : "checkpoint");
}

function installBrowserPilotOperationResponder(): void {
  chrome.runtime.onMessage?.addListener((message, _sender, sendResponse) => {
    const record = message && typeof message === "object" ? message as Record<string, unknown> : {};
    if (!String(record.cmd || "").startsWith("browserPilot.operation.")) return false;
    void handleBrowserPilotContentOperationMessage(record).then(sendResponse, (error) => sendResponse({ ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 500) }));
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
	reportBrowserPilotPrerenderActivation();

  if (document.documentElement) scrubLegacyBridgeNode(document.documentElement);

  installBrowserPilotFingerprintResponder();
  installBrowserPilotOperationResponder();
  installBrowserPilotInteractionFingerprinting();

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
