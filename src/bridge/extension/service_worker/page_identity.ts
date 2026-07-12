import { BROWSER_PILOT_WORKER_BOOT_ID } from "./runtimeEnv";
import type { BrowserPilotChromeTab, JsonRecord } from "./types";

type ExtensionPageIdentity = {
  pageEpoch: string;
  documentId?: string;
  url: string;
};

type TabPageIdentityState = ExtensionPageIdentity & {
  documentLineage: Map<string, string>;
};

const MAX_DOCUMENT_LINEAGE = 8;
const pageIdentities = new Map<number, TabPageIdentityState>();
let pageEpochSequence = 0;

function positiveTabId(value: unknown): number | undefined {
  const tabId = Number(value);
  return Number.isInteger(tabId) && tabId > 0 ? tabId : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mintPageEpoch(): string {
  pageEpochSequence += 1;
  return `${BROWSER_PILOT_WORKER_BOOT_ID}:page:${pageEpochSequence.toString(36)}`;
}

function pruneDocumentLineage(lineage: Map<string, string>): void {
  while (lineage.size > MAX_DOCUMENT_LINEAGE) {
    const oldest = lineage.keys().next().value;
    if (typeof oldest !== "string") return;
    lineage.delete(oldest);
  }
}

function ensureBrowserPilotPageIdentity(tabIdValue: unknown, urlValue?: unknown): ExtensionPageIdentity | undefined {
  const tabId = positiveTabId(tabIdValue);
  if (!tabId) return undefined;
  const url = stringValue(urlValue) ?? pageIdentities.get(tabId)?.url ?? "";
  let state = pageIdentities.get(tabId);
  if (!state) {
    state = { pageEpoch: mintPageEpoch(), url, documentLineage: new Map() };
    pageIdentities.set(tabId, state);
  } else if (url) {
    state.url = url;
  }
  return { pageEpoch: state.pageEpoch, ...(state.documentId ? { documentId: state.documentId } : {}), url: state.url };
}

/** A top-level commit starts a new epoch, except a BFCache restore whose documentId lineage is still proven in this worker. */
function recordBrowserPilotDocumentCommit(details: JsonRecord & { tabId?: number; frameId?: number; documentId?: string; url?: string }): ExtensionPageIdentity | undefined {
  const tabId = positiveTabId(details.tabId);
  if (!tabId || Number(details.frameId ?? 0) !== 0) return undefined;
  const current = pageIdentities.get(tabId);
  const lineage = current?.documentLineage ?? new Map<string, string>();
  const documentId = stringValue(details.documentId);
  const provenEpoch = documentId ? lineage.get(documentId) : undefined;
  const pageEpoch = provenEpoch ?? mintPageEpoch();
  if (documentId) {
    lineage.delete(documentId);
    lineage.set(documentId, pageEpoch);
    pruneDocumentLineage(lineage);
  }
  const state: TabPageIdentityState = {
    pageEpoch,
    ...(documentId ? { documentId } : {}),
    url: stringValue(details.url) ?? current?.url ?? "",
    documentLineage: lineage,
  };
  pageIdentities.set(tabId, state);
  return { pageEpoch: state.pageEpoch, ...(state.documentId ? { documentId: state.documentId } : {}), url: state.url };
}

/** pushState/replaceState/hash updates change only the URL fact, never the document epoch. */
function recordBrowserPilotSameDocumentUpdate(details: JsonRecord & { tabId?: number; frameId?: number; url?: string }): ExtensionPageIdentity | undefined {
  if (Number(details.frameId ?? 0) !== 0) return undefined;
  return ensureBrowserPilotPageIdentity(details.tabId, details.url);
}

function replaceBrowserPilotPageIdentity(removedTabIdValue: unknown, addedTabIdValue: unknown, urlValue?: unknown): ExtensionPageIdentity | undefined {
  const removedTabId = positiveTabId(removedTabIdValue);
  const addedTabId = positiveTabId(addedTabIdValue);
  if (removedTabId) pageIdentities.delete(removedTabId);
  if (!addedTabId) return undefined;
  pageIdentities.delete(addedTabId);
  return ensureBrowserPilotPageIdentity(addedTabId, urlValue);
}

function forgetBrowserPilotPageIdentity(tabIdValue: unknown): void {
  const tabId = positiveTabId(tabIdValue);
  if (tabId) pageIdentities.delete(tabId);
}

function browserPilotPageIdentityFields(tab: BrowserPilotChromeTab): Record<string, unknown> {
  const identity = ensureBrowserPilotPageIdentity(tab.id ?? tab.tabId, tab.url);
  return identity ? { pageEpoch: identity.pageEpoch, ...(identity.documentId ? { documentId: identity.documentId } : {}) } : {};
}

function browserPilotPageIdentityForTab(tabId: number, url?: string): ExtensionPageIdentity | undefined {
  return ensureBrowserPilotPageIdentity(tabId, url);
}

function resetBrowserPilotPageIdentitiesForTest(): void {
  pageIdentities.clear();
  pageEpochSequence = 0;
}

export {
  ensureBrowserPilotPageIdentity,
  recordBrowserPilotDocumentCommit,
  recordBrowserPilotSameDocumentUpdate,
  replaceBrowserPilotPageIdentity,
  forgetBrowserPilotPageIdentity,
  browserPilotPageIdentityFields,
  browserPilotPageIdentityForTab,
  resetBrowserPilotPageIdentitiesForTest,
};

export const __browserPilotBridgeModule_page_identity = {
  name: "page_identity",
  symbols: {
    ensureBrowserPilotPageIdentity,
    recordBrowserPilotDocumentCommit,
    recordBrowserPilotSameDocumentUpdate,
    replaceBrowserPilotPageIdentity,
    forgetBrowserPilotPageIdentity,
    browserPilotPageIdentityFields,
    browserPilotPageIdentityForTab,
  },
};
