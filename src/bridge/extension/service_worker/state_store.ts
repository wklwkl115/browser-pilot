// state_store.ts - MV3 runtime state persistence and recovery foundation.
//
// Provides a shared store for persisting structural metadata in chrome.storage.session
// so that service-worker restarts can recover configuration-only state while failing
// closed for volatile runtime data (buffers, transcripts, paused requests).

import { chromeApi as chrome, BROWSER_PILOT_WORKER_BOOT_ID } from "./runtimeEnv.js";
import { redactSensitive, runtimeRecord } from "./runtimeSupport.js";
import type { JsonRecord } from "./types.js";

// --- Constants ---

const STORAGE_KEY = "browserPilotRuntimeStateV2";
const SCHEMA_VERSION = "browser-pilot.runtime.state/v1" as const;
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
  | "cdp";

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

type BrowserPilotSessionRecord = JsonRecord & {
  session_id?: string;
  targets?: unknown;
  options?: unknown;
  buffer_size?: number;
  install_fingerprint?: string;
  install_args?: JsonRecord;
  state?: string;
  installed_at?: string;
};

const browserPilotSessions = new Map<number, BrowserPilotSessionRecord>();

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

function normalizeRedactionKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function redactPersistedConfig(value: unknown, depth = 0, parentKey = ""): unknown {
  const normalizedParent = normalizeRedactionKey(parentKey);
  if (DIRECT_PAYLOAD_KEYS.has(normalizedParent)) return "[redacted]";
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length > 256) return "[redacted long value]";
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return "[redacted]";
  if (depth > 6) return "[redacted depth]";
  if (Array.isArray(value)) return value.map((v) => redactPersistedConfig(v, depth + 1, parentKey));
  return Object.fromEntries(
    Object.entries(value as JsonRecord).map(([k, v]) => [k, redactPersistedConfig(v, depth + 1, k)])
  ) as JsonRecord;
}

function redactConfig(value: unknown): unknown {
  return redactPersistedConfig(redactSensitive(value));
}

function currentBootId(): string {
  return typeof BROWSER_PILOT_WORKER_BOOT_ID === "string" && BROWSER_PILOT_WORKER_BOOT_ID
    ? BROWSER_PILOT_WORKER_BOOT_ID
    : "unknown";
}

async function findLostRuntimeSession(kind: RuntimeStateKind, tabId: number, sessionId: string): Promise<JsonRecord | undefined> {
  const record = await get(kind, `${Number(tabId)}:${String(sessionId || "default")}`);
  if (!record || record.workerBootId === currentBootId()) return undefined;
  return { kind: record.kind, tabId: record.tabId, sessionId: record.sessionId, workerBootId: record.workerBootId, updatedAt: record.updatedAt, details: runtimeRecord(record.config) };
}

function summarizeLostRuntimeSession(record: JsonRecord | undefined): JsonRecord | undefined {
  if (!record) return undefined;
  return { stateLost: true, previousWorkerBootId: record.workerBootId, updatedAt: record.updatedAt, kind: record.kind, tabId: record.tabId, sessionId: record.sessionId, details: runtimeRecord(record.details) };
}

function now(): number {
  return Date.now();
}

function stateKey(kind: RuntimeStateKind, key: string): string {
  return `${kind}:${key}`;
}

function runtimeRecoveryGlobal() {
  return globalThis as typeof globalThis & {
    __BROWSER_PILOT_RUNTIME_RECOVERY_SUMMARY__?: RuntimeRecoverySummary | null;
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
    console.warn("[BROWSER-PILOT-STATE] Storage read failed", error instanceof Error ? error.message : error);
    // Storage read failure - return empty
  }
  return {};
}

let writeChain = Promise.resolve({ ok: true } as StateStoreWriteResult);

async function saveAll(map: Record<string, RuntimeStateRecord>): Promise<StateStoreWriteResult> {
  const session = chrome.storage?.session;
  if (!session?.set) return { ok: true };
  try {
    await session.set({ [STORAGE_KEY]: map });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
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

function enqueueWrite(task: () => Promise<StateStoreWriteResult>): Promise<StateStoreWriteResult> {
  const next = writeChain
    .catch(() => ({ ok: true } as StateStoreWriteResult))
    .then(task);
  writeChain = next.catch(() => ({ ok: false } as StateStoreWriteResult));
  return next;
}

function markRecovered(kind: RuntimeStateKind, key: string, bootId: string): Promise<StateStoreWriteResult> {
  return enqueueWrite(async () => {
    const map = await loadAll();
    const existing = map[stateKey(kind, key)];
    if (!existing) return { ok: true };
    existing.workerBootId = bootId;
    existing.recoveredAt = now();
    existing.updatedAt = now();
    return await saveAll(map);
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
  return await enqueueWrite(async () => {
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
  return await enqueueWrite(async () => {
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
  } catch {
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
          await markRecovered(kind, key, bootId);
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
      await markRecovered(kind, key, bootId);
    }
  }

  return result;
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

runtimeRecoveryGlobal().__BROWSER_PILOT_RUNTIME_RECOVERY_SUMMARY__ = null;

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
      console.warn("[BROWSER-PILOT-STATE] Recovery registrar failed", error instanceof Error ? error.message : error);
    }
  }
  const summary: RuntimeRecoverySummary = {
    ranAt: now(),
    results,
    totals: summarizeRecovery(results),
  };
  runtimeRecoveryGlobal().__BROWSER_PILOT_RUNTIME_RECOVERY_SUMMARY__ = summary;
  return summary;
}

export {
  RECOVERY_CODES,
  type RecoveryCode,
  type RuntimeStateKind,
  type RecoveryPolicy,
  type RuntimeStateRecord,
  type RecoveryResult,
  type RecoveryResultEntry,
  type StateStoreWriteResult,
  type RuntimeRecoverySummary,
  makeRecord,
  persist,
  forget,
  get,
  getAll,
  recover,
  summarizeRecovery,
  registerRecovery,
  runStartupRecovery,
  redactConfig,
  currentBootId,
  browserPilotSessions,
  findLostRuntimeSession,
  summarizeLostRuntimeSession,
  MAX_KIND_RECORDS,
  TTL_MS,
  SCHEMA_VERSION,
  STORAGE_KEY,
};
