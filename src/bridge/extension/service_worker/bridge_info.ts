// bridge_info.js - shared bridge metadata and tab helpers.

import { BROWSER_PILOT_WORKER_BOOT_ID, BROWSER_PILOT_WORKER_STARTED_AT, chromeApi as chrome } from "./runtimeEnv";
import { BRIDGE_BUILD_ID, BRIDGE_BUILD_PIPELINE_VERSION } from "../shared/buildInfo";

let lostHookSessionsGetter: (() => Array<Record<string, unknown>>) | null = null;
function registerLostHookSessionsGetter(getter: () => Array<Record<string, unknown>>): void {
  lostHookSessionsGetter = getter;
}

let offscreenUnreachableGetter: (() => boolean) | null = null;
function registerOffscreenUnreachableGetter(getter: () => boolean): void {
  offscreenUnreachableGetter = getter;
}

function browserPilotBridgeInfo() {
  const manifest = chrome.runtime.getManifest();
  const recovery = (globalThis as typeof globalThis & {
    __BROWSER_PILOT_RUNTIME_RECOVERY_SUMMARY__?: {
      ranAt?: number;
      totals?: {
        recovered?: number;
        recoveredWithHistoryLoss?: number;
        lost?: number;
        byKind?: Record<string, { recovered: number; lost: number }>;
      };
    } | null;
  }).__BROWSER_PILOT_RUNTIME_RECOVERY_SUMMARY__;
  return {
    id: chrome.runtime.id,
    name: manifest.name,
    version: manifest.version_name || manifest.version,
    manifestVersion: manifest.version,
    build: {
      buildId: BRIDGE_BUILD_ID,
      pipelineVersion: BRIDGE_BUILD_PIPELINE_VERSION,
    },
    userAgent: navigator.userAgent,
    workerBootId: BROWSER_PILOT_WORKER_BOOT_ID,
    workerStartedAt: BROWSER_PILOT_WORKER_STARTED_AT,
    captureContractVersion: 1,
    runtimeRecovery: recovery ? {
      ranAt: recovery.ranAt,
      recovered: recovery.totals?.recovered || 0,
      recoveredWithHistoryLoss: recovery.totals?.recoveredWithHistoryLoss || 0,
      lost: recovery.totals?.lost || 0,
      byKind: recovery.totals?.byKind || {},
    } : null,
    lostHookSessions: (() => { const lost = lostHookSessionsGetter?.() || []; return lost.length ? lost : undefined; })(),
    offscreenUnreachable: offscreenUnreachableGetter?.() === true ? true : undefined,
  };
}

// Stable per-installation identity that survives service-worker restarts and reconnects
// (unlike workerBootId, which is minted fresh each SW boot). Persisted in
// chrome.storage.local so the bridge can tell a reconnecting instance apart from a new
// browser, collapse duplicate sockets to one per instance, and reconcile in-flight work
// across a reconnect. Cached in-memory after first read.
const EXTENSION_INSTANCE_ID_KEY = "browserPilotExtensionInstanceId";
let cachedExtensionInstanceId: string | undefined;
async function getExtensionInstanceId(): Promise<string | undefined> {
  if (cachedExtensionInstanceId) return cachedExtensionInstanceId;
  const local = chrome.storage?.local;
  if (!local?.get || !local?.set) return undefined;
  try {
    const raw = await local.get(EXTENSION_INSTANCE_ID_KEY);
    const existing = raw && typeof raw === "object" ? (raw as Record<string, unknown>)[EXTENSION_INSTANCE_ID_KEY] : undefined;
    if (typeof existing === "string" && existing) {
      cachedExtensionInstanceId = existing;
      return existing;
    }
    const generated = globalThis.crypto?.randomUUID?.() ?? `inst:${BROWSER_PILOT_WORKER_BOOT_ID}`;
    await local.set({ [EXTENSION_INSTANCE_ID_KEY]: generated });
    cachedExtensionInstanceId = generated;
    return generated;
  } catch (_error) {
    return undefined;
  }
}

// Track normal scriptable tabs plus about:blank tabs created by browser_tabs before navigation.
const isScriptable = (url: unknown): boolean => {
  const text = typeof url === 'string' ? url : '';
  return !!text && (/^https?:/.test(text) || text === 'about:blank');
};
export { BROWSER_PILOT_WORKER_STARTED_AT, BROWSER_PILOT_WORKER_BOOT_ID, browserPilotBridgeInfo, getExtensionInstanceId, isScriptable, registerLostHookSessionsGetter, registerOffscreenUnreachableGetter };
