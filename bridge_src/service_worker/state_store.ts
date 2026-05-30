// state_store.ts - MV3 runtime state persistence and recovery foundation.
//
// Provides a shared store for persisting structural metadata in chrome.storage.session
// so that service-worker restarts can recover configuration-only state while failing
// closed for volatile runtime data (buffers, transcripts, paused requests).

import { chromeApi as chrome, PI_BROWSER_WORKER_BOOT_ID } from "./runtimeEnv";
import type { JsonRecord } from "./types";

// --- Constants ---

const STORAGE_KEY = "piBrowserRuntimeStateV2";
const SCHEMA_VERSION = "pi.browser.runtime.state/v1" as const;
const MAX_KIND_RECORDS = 50;
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const RECOVERY_CODES = {
  RECOVERED: "RUNTIME_STATE_RECOVERED",
  RECOVERED_WITH_HISTORY_LOSS: "RUNTIME_STATE_RECOVERED_WITH_HISTORY_LOSS",
  LOST: "RUNTIME_STATE_LOST",
} as const;

type RecoveryCode = (typeof RECOVERY_CODES)[keyof typeof RECOVERY_CODES];

type RuntimeStateKind =
  | "network"
  | "intercept"
  | "hook"
  | "ws"
  | "cdp"
  | "wait"
  | "queue"
  | "cspBypass";

type RecoveryPolicy = "auto" | "manual" | "diagnosticOnly";

type RuntimeStateRecord<TConfig = unknown> = {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: RuntimeStateKind;
  key: string;
  tabId?: number;
  sessionId?: string;
  generation: number;
  workerBootId: string;
  updatedAt: number;
  recoveredAt?: number;
  recoveryPolicy: RecoveryPolicy;
  config: TConfig;
  diagnostics?: Array<Record<string, unknown>>;
};

type RecoveryResultEntry = {
  key: string;
  config?: unknown;
  code: RecoveryCode;
  reason?: string;
};

type RecoveryResult = {
  kind: RuntimeStateKind;
  recovered: RecoveryResultEntry[];
  lost: RecoveryResultEntry[];
  diagnostics: Array<Record<string, unknown>>;
};

type StateStoreDiagnostics = {
  totalRecords: number;
  byKind: Record<string, number>;
  oldestUpdatedAt: number | null;
  newestUpdatedAt: number | null;
  lastStorageWriteError?: string | null;
};

type StateStoreWriteResult = { ok: boolean; error?: string; generation?: number };

type RuntimeRecoverySummary = {
  ranAt: number;
  results: RecoveryResult[];
  totals: {
    recovered: number;
    recoveredWithHistoryLoss: number;
    lost: number;
    byKind: Record<string, { recovered: number; lost: number }>;
  };
};

// Sensitive field names that must be redacted from persisted config.
const SENSITIVE_KEYS = new Set([
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "authorization",
  "cookie",
  "set-cookie",
  "apikey",
  "api_key",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "bearer",
  "body",
  "bodybase64",
  "body_base64",
  "postdata",
  "post_data",
  "payloaddata",
  "payload",
  "text",
  "value",
  "content",
  "source",
  "script",
  "expression",
  "html",
]);

const DIRECT_PAYLOAD_KEYS = new Set([
  "body",
  "postdata",
  "payloaddata",
  "payload",
  "source",
  "script",
  "expression",
  "html",
  "text",
  "value",
  "content",
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ""));
}

function normalizeRedactionKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

function redactConfig(value: unknown, depth = 0, parentKey = ""): unknown {
  if (value == null) return value;
  const normalizedParent = normalizeRedactionKey(parentKey);
  if (typeof value === "string") {
    if (parentKey && isSensitiveKey(parentKey)) return "[REDACTED]";
    if (DIRECT_PAYLOAD_KEYS.has(normalizedParent)) return "[REDACTED]";
    if (value.length > 256) return "[REDACTED_LONG]";
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return "[REDACTED]";
  if (depth > 6) return "[REDACTED_DEPTH]";
  if (Array.isArray(value)) return value.map((v) => redactConfig(v, depth + 1, parentKey));
  const out: JsonRecord = {};
  for (const [k, v] of Object.entries(value as JsonRecord)) {
    if (isSensitiveKey(k)) out[k] = "[REDACTED]";
    else out[k] = redactConfig(v, depth + 1, k);
  }
  return out;
}

function currentBootId(): string {
  return typeof PI_BROWSER_WORKER_BOOT_ID === "string" && PI_BROWSER_WORKER_BOOT_ID
    ? PI_BROWSER_WORKER_BOOT_ID
    : "unknown";
}

function now(): number {
  return Date.now();
}

function stateKey(kind: RuntimeStateKind, key: string): string {
  return `${kind}:${key}`;
}

function runtimeRecoveryGlobal() {
  return globalThis as typeof globalThis & {
    __PI_BROWSER_RUNTIME_RECOVERY_SUMMARY__?: RuntimeRecoverySummary | null;
  };
}

// --- Storage I/O ---

async function loadAll(): Promise<Record<string, RuntimeStateRecord>> {
  const session = chrome.storage?.session;
  if (!session?.get) return {};
  try {
    const raw = await session.get(STORAGE_KEY);
    const value = raw && typeof raw === "object" ? (raw as JsonRecord)[STORAGE_KEY] : undefined;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, RuntimeStateRecord>;
    }
  } catch (error) {
    console.warn("[PI-BROWSER-STATE] Storage read failed", error instanceof Error ? error.message : error);
    // Storage read failure - return empty
  }
  return {};
}

let lastStorageWriteError: string | null = null;
const writeChains = new Map<RuntimeStateKind, Promise<StateStoreWriteResult>>();

async function saveAll(map: Record<string, RuntimeStateRecord>): Promise<StateStoreWriteResult> {
  const session = chrome.storage?.session;
  if (!session?.set) return { ok: true };
  try {
    await session.set({ [STORAGE_KEY]: map });
    lastStorageWriteError = null;
    return { ok: true };
  } catch (error) {
    lastStorageWriteError = error instanceof Error ? error.message : String(error);
    return { ok: false, error: lastStorageWriteError };
  }
}

// --- Pruning ---

function pruneRecords(map: Record<string, RuntimeStateRecord>): Record<string, RuntimeStateRecord> {
  const cutoff = now() - TTL_MS;
  const byKind = new Map<string, Array<[string, RuntimeStateRecord]>>();

  for (const [key, record] of Object.entries(map)) {
    if (record.updatedAt < cutoff) {
      delete map[key];
      continue;
    }
    const entries = byKind.get(record.kind) || [];
    entries.push([key, record]);
    byKind.set(record.kind, entries);
  }

  for (const [, entries] of byKind) {
    if (entries.length <= MAX_KIND_RECORDS) continue;
    entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    for (const [key] of entries.slice(MAX_KIND_RECORDS)) {
      delete map[key];
    }
  }

  return map;
}

async function pruneMissingTabs(map: Record<string, RuntimeStateRecord>): Promise<Record<string, RuntimeStateRecord>> {
  for (const [key, record] of Object.entries(map)) {
    if (record.tabId == null) continue;
    if (!(await tabExists(record.tabId))) delete map[key];
  }
  return map;
}

// --- Public API ---

function makeRecord<TConfig>(
  kind: RuntimeStateKind,
  key: string,
  config: TConfig,
  opts: {
    tabId?: number;
    sessionId?: string;
    generation?: number;
    recoveryPolicy?: RecoveryPolicy;
    diagnostics?: Array<Record<string, unknown>>;
  } = {}
): RuntimeStateRecord<TConfig> {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind,
    key,
    tabId: opts.tabId,
    sessionId: opts.sessionId,
    generation: opts.generation ?? 0,
    workerBootId: currentBootId(),
    updatedAt: now(),
    recoveryPolicy: opts.recoveryPolicy ?? "auto",
    config,
    diagnostics: opts.diagnostics,
  };
}

function enqueueKindWrite(kind: RuntimeStateKind, task: () => Promise<StateStoreWriteResult>): Promise<StateStoreWriteResult> {
  const previous = writeChains.get(kind) || Promise.resolve({ ok: true } as StateStoreWriteResult);
  const next = previous
    .catch(() => ({ ok: true } as StateStoreWriteResult))
    .then(task);
  writeChains.set(kind, next.catch(() => ({ ok: false } as StateStoreWriteResult)));
  return next.finally(() => {
    if (writeChains.get(kind) === next || writeChains.get(kind) === undefined) writeChains.delete(kind);
  });
}

async function persist<TConfig>(
  kind: RuntimeStateKind,
  key: string,
  config: TConfig,
  opts: {
    tabId?: number;
    sessionId?: string;
    generation?: number;
    recoveryPolicy?: RecoveryPolicy;
    diagnostics?: Array<Record<string, unknown>>;
  } = {}
): Promise<StateStoreWriteResult> {
  return await enqueueKindWrite(kind, async () => {
    const map = await loadAll();
    const sk = stateKey(kind, key);
    const existing = map[sk];
    const record = makeRecord(kind, key, redactConfig(config) as TConfig, {
      ...opts,
      generation: opts.generation ?? (existing ? existing.generation + 1 : 0),
      diagnostics: Array.isArray(opts.diagnostics) ? [...opts.diagnostics] : undefined,
    });
    map[sk] = record as RuntimeStateRecord;
    await pruneMissingTabs(map);
    const saved = await saveAll(pruneRecords(map));
    return { ...saved, generation: record.generation };
  });
}

async function forget(kind: RuntimeStateKind, key: string): Promise<StateStoreWriteResult> {
  return await enqueueKindWrite(kind, async () => {
    const map = await loadAll();
    const sk = stateKey(kind, key);
    if (!(sk in map)) return { ok: true };
    delete map[sk];
    return await saveAll(map);
  });
}

async function get(kind: RuntimeStateKind, key: string): Promise<RuntimeStateRecord | undefined> {
  const map = await loadAll();
  return map[stateKey(kind, key)];
}

async function getAll(kind: RuntimeStateKind): Promise<RuntimeStateRecord[]> {
  const map = await loadAll();
  return Object.values(map).filter((r) => r.kind === kind);
}

async function tabExists(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return !!tab;
  } catch (error) {
    console.warn("[PI-BROWSER-STATE] tabExists lookup failed", tabId, error instanceof Error ? error.message : error);
    return false;
  }
}

async function recover(
  kind: RuntimeStateKind,
  opts: {
    recover?: (record: RuntimeStateRecord) => Promise<{ recovered: boolean; historyLost: boolean; reason?: string }>;
    validateTab?: boolean;
  } = {}
): Promise<RecoveryResult> {
  const bootId = currentBootId();
  const records = await getAll(kind);
  const result: RecoveryResult = { kind, recovered: [], lost: [], diagnostics: [] };

  for (const record of records) {
    const key = record.key;
    const sk = stateKey(kind, key);

    if (record.workerBootId === bootId) continue;

    if (opts.validateTab && record.tabId != null) {
      const exists = await tabExists(record.tabId);
      if (!exists) {
        result.lost.push({
          key,
          code: RECOVERY_CODES.LOST,
          reason: `tab ${record.tabId} no longer exists`,
        });
        await forget(kind, key);
        continue;
      }
    }

    if (opts.recover) {
      try {
        const recovery = await opts.recover(record);
        if (recovery.recovered) {
          const map = await loadAll();
          const existing = map[sk];
          if (existing) {
            existing.workerBootId = bootId;
            existing.recoveredAt = now();
            existing.updatedAt = now();
            await saveAll(map);
          }
          result.recovered.push({
            key,
            config: record.config,
            code: recovery.historyLost
              ? RECOVERY_CODES.RECOVERED_WITH_HISTORY_LOSS
              : RECOVERY_CODES.RECOVERED,
          });
        } else {
          result.lost.push({
            key,
            code: RECOVERY_CODES.LOST,
            reason: recovery.reason || "recovery failed",
          });
        }
      } catch (error) {
        result.lost.push({
          key,
          code: RECOVERY_CODES.LOST,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      result.recovered.push({
        key,
        config: record.config,
        code: RECOVERY_CODES.RECOVERED_WITH_HISTORY_LOSS,
      });
      const map = await loadAll();
      const existing = map[sk];
      if (existing) {
        existing.workerBootId = bootId;
        existing.recoveredAt = now();
        existing.updatedAt = now();
        await saveAll(map);
      }
    }
  }

  return result;
}

async function diagnostics(): Promise<StateStoreDiagnostics> {
  const map = await loadAll();
  const records = Object.values(map);
  const byKind: Record<string, number> = {};
  let oldest: number | null = null;
  let newest: number | null = null;

  for (const record of records) {
    byKind[record.kind] = (byKind[record.kind] || 0) + 1;
    if (oldest === null || record.updatedAt < oldest) oldest = record.updatedAt;
    if (newest === null || record.updatedAt > newest) newest = record.updatedAt;
  }

  return {
    totalRecords: records.length,
    byKind,
    oldestUpdatedAt: oldest,
    newestUpdatedAt: newest,
    lastStorageWriteError,
  };
}

function summarizeRecovery(results: RecoveryResult[]): {
  recovered: number;
  recoveredWithHistoryLoss: number;
  lost: number;
  byKind: Record<string, { recovered: number; lost: number }>;
} {
  let recovered = 0;
  let recoveredWithHistoryLoss = 0;
  let lost = 0;
  const byKind: Record<string, { recovered: number; lost: number }> = {};

  for (const result of results) {
    const kindStats = byKind[result.kind] || { recovered: 0, lost: 0 };
    for (const entry of result.recovered) {
      if (entry.code === RECOVERY_CODES.RECOVERED) recovered++;
      else recoveredWithHistoryLoss++;
      kindStats.recovered++;
    }
    for (const _ of result.lost) {
      lost++;
      kindStats.lost++;
    }
    byKind[result.kind] = kindStats;
  }

  return { recovered, recoveredWithHistoryLoss, lost, byKind };
}

function getRecoveryCodes() {
  return RECOVERY_CODES;
}

let lastRecoverySummary: RuntimeRecoverySummary | null = null;
runtimeRecoveryGlobal().__PI_BROWSER_RUNTIME_RECOVERY_SUMMARY__ = null;

type RecoveryRegistrar = (results: RecoveryResult[]) => Promise<void>;

const recoveryRegistrars: RecoveryRegistrar[] = [];

function registerRecovery(registrar: RecoveryRegistrar): void {
  recoveryRegistrars.push(registrar);
}

async function runStartupRecovery(): Promise<RuntimeRecoverySummary> {
  const results: RecoveryResult[] = [];
  for (const registrar of recoveryRegistrars) {
    try {
      await registrar(results);
    } catch (error) {
      console.warn("[PI-BROWSER-STATE] Recovery registrar failed", error instanceof Error ? error.message : error);
    }
  }
  const summary: RuntimeRecoverySummary = {
    ranAt: now(),
    results,
    totals: summarizeRecovery(results),
  };
  lastRecoverySummary = summary;
  runtimeRecoveryGlobal().__PI_BROWSER_RUNTIME_RECOVERY_SUMMARY__ = summary;
  if (summary.totals.recovered + summary.totals.recoveredWithHistoryLoss + summary.totals.lost > 0) {
    console.log(
      "[PI-BROWSER-STATE] Startup recovery complete",
      `recovered=${summary.totals.recovered}`,
      `historyLoss=${summary.totals.recoveredWithHistoryLoss}`,
      `lost=${summary.totals.lost}`
    );
  }
  return summary;
}

function getRuntimeRecoverySummary(): RuntimeRecoverySummary | null {
  return lastRecoverySummary;
}

export {
  RECOVERY_CODES,
  type RecoveryCode,
  type RuntimeStateKind,
  type RecoveryPolicy,
  type RuntimeStateRecord,
  type RecoveryResult,
  type RecoveryResultEntry,
  type StateStoreDiagnostics,
  type StateStoreWriteResult,
  type RuntimeRecoverySummary,
  makeRecord,
  persist,
  forget,
  get,
  getAll,
  recover,
  diagnostics,
  summarizeRecovery,
  getRecoveryCodes,
  registerRecovery,
  runStartupRecovery,
  getRuntimeRecoverySummary,
  redactConfig,
  currentBootId,
  MAX_KIND_RECORDS,
  TTL_MS,
  SCHEMA_VERSION,
  STORAGE_KEY,
};
// ESM module boundary marker
export const __piBridgeModule_state_store = {
  name: "state_store",
  symbols: {
    RECOVERY_CODES,
    persist,
    forget,
    get,
    getAll,
    recover,
    diagnostics,
    summarizeRecovery,
    registerRecovery,
    runStartupRecovery,
    getRuntimeRecoverySummary,
  },
};
