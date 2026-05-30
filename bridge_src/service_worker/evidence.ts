// evidence.js - Pi browser native event/evidence aggregation.

import { PI_BROWSER_ERROR_CODES, callPagePiBrowser, piBrowserError } from "./runtime";
import { getPerformanceEntries } from "./wait";
import { normalizePiBrowserTimeoutMs } from "./wait_coordinator";
import { handleNetworkRecorderCommand } from "./network";
import type { JsonRecord, PiBridgeCommand, PiBridgeResponse } from "./types";

const PI_BROWSER_EVIDENCE_EVENT_TYPES = ['network', 'dom', 'console', 'error', 'storage', 'websocket', 'crypto', 'dom_sinks'];

function evidenceRecord(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function evidenceErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function safePiBrowserEvidence(label: string, task: () => Promise<PiBridgeResponse> | PiBridgeResponse): Promise<PiBridgeResponse & { source: string }> {
  try {
    const result = await task();
    const error = evidenceRecord(result?.error);
    return result && result.ok === false ? { ok: false, source: label, error_code: String(result.error_code || error.code || PI_BROWSER_ERROR_CODES.INTERNAL_ERROR), error: typeof result.error === 'string' ? result.error : String(result.message || error.message || 'evidence source failed'), details: result.details || evidenceRecord(error.details) } : { ok: true, source: label, data: result?.data !== undefined ? result.data : result };
  } catch (e) {
    return { ok: false, source: label, error_code: PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, error: evidenceErrorMessage(e), details: { name: e instanceof Error ? e.name : 'Error' } };
  }
}

async function handlePiBrowserEvidenceCommand(cmd: string, tabId: number, msg: PiBridgeCommand): Promise<PiBridgeResponse> {
  if (cmd !== 'evidence.collect') return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown Pi Browser evidence command: ' + cmd, { cmd });
  const eventTypes = Array.isArray(msg.event_types) ? msg.event_types : (Array.isArray(msg.eventTypes) ? msg.eventTypes : PI_BROWSER_EVIDENCE_EVENT_TYPES);
  const limit = Math.max(1, Math.min(5000, Number(msg.limit || 500)));
  const hasTimeout = msg.timeoutMs !== undefined || msg.timeout_ms !== undefined;
  const timeout_ms = hasTimeout && typeof normalizePiBrowserTimeoutMs === 'function'
    ? normalizePiBrowserTimeoutMs({ timeoutMs: msg.timeoutMs ?? msg.timeout_ms }, 0)
    : hasTimeout ? Math.max(0, Math.min(300000, Number(msg.timeoutMs ?? msg.timeout_ms))) : 0;
  const evaluateOptions = hasTimeout ? { timeoutMs: timeout_ms } : {};
  const includeHook = msg.includeHook !== false && msg.hook !== false;
  const includeNetwork = msg.includeNetwork !== false && msg.network !== false;
  const includePerformance = msg.includePerformance !== false && msg.performance !== false;
  const networkSessionId = msg.networkSessionId || msg.sessionId || msg.session_id || 'default';
  const out: JsonRecord & { sources: Record<string, unknown> } = {
    tabId: Number(tabId),
    collected_at: new Date().toISOString(),
    event_types: eventTypes,
    sources: {},
  };
  if (includeHook) {
    out.sources.hook_status = await safePiBrowserEvidence('hook.status', () => callPagePiBrowser(tabId, 'hook.status', {}, evaluateOptions));
    out.sources.hook_events = await safePiBrowserEvidence('hook.collect', () => callPagePiBrowser(tabId, 'hook.collect', { event_types: eventTypes, limit, timeout_ms }, evaluateOptions));
  }
  if (includeNetwork) {
    out.sources.network_status = await safePiBrowserEvidence('network.status', async () => await handleNetworkRecorderCommand(tabId, 'network.status', { sessionId: networkSessionId }) as PiBridgeResponse);
    out.sources.network_entries = await safePiBrowserEvidence('network.list', async () => await handleNetworkRecorderCommand(tabId, 'network.list', { sessionId: networkSessionId, limit, includeDetails: true }) as PiBridgeResponse);
  }
  if (includePerformance) {
    const entryType = msg.entryType ?? msg.entry_type;
    const nameContains = msg.nameContains ?? msg.name_contains;
    const performanceArgs: PiBridgeCommand = { entryType, entry_type: entryType, nameContains, name_contains: nameContains };
    if (hasTimeout) performanceArgs.timeoutMs = timeout_ms;
    out.sources.performance = await safePiBrowserEvidence('hook.getPerformanceEntries', async () => await getPerformanceEntries(tabId, performanceArgs) as PiBridgeResponse);
  }
  return { ok: true, data: out };
}
export { PI_BROWSER_EVIDENCE_EVENT_TYPES, safePiBrowserEvidence, handlePiBrowserEvidenceCommand };
// ESM module metadata
export const __piBridgeModule_evidence = { name: "evidence", symbols: { PI_BROWSER_EVIDENCE_EVENT_TYPES, safePiBrowserEvidence, handlePiBrowserEvidenceCommand } };
