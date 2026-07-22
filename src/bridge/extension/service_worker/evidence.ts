// evidence.js - Browser Pilot event/evidence aggregation.

import { BROWSER_PILOT_ERROR_CODES, callPageBrowserPilot, browserPilotError, runtimeErrorMessage as evidenceErrorMessage, runtimeRecord as evidenceRecord } from "./runtimeSupport.js";
import { getPerformanceEntries } from "./wait";
import { normalizeBrowserPilotTimeoutMs } from "./wait_coordinator";
import { handleNetworkRecorderCommand } from "./network";
import type { JsonRecord, BrowserPilotBridgeCommand, BrowserPilotBridgeResponse } from "./types";

const BROWSER_PILOT_EVIDENCE_EVENT_TYPES = ['network', 'dom', 'console', 'error', 'storage', 'websocket', 'crypto', 'dom_sinks'];


async function safeBrowserPilotEvidence(label: string, task: () => Promise<BrowserPilotBridgeResponse> | BrowserPilotBridgeResponse): Promise<BrowserPilotBridgeResponse & { source: string }> {
  try {
    const result = await task();
    const error = evidenceRecord(result?.error);
    return result && result.ok === false ? { ok: false, source: label, error_code: String(result.error_code || error.code || BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR), error: typeof result.error === 'string' ? result.error : String(result.message || error.message || 'evidence source failed'), details: result.details || evidenceRecord(error.details) } : { ok: true, source: label, data: result?.data !== undefined ? result.data : result };
  } catch (e) {
    return { ok: false, source: label, error_code: BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, error: evidenceErrorMessage(e), details: { name: e instanceof Error ? e.name : 'Error' } };
  }
}

async function handleBrowserPilotEvidenceCommand(cmd: string, tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
  if (cmd !== 'evidence.collect') return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, 'Unknown Browser Pilot evidence command: ' + cmd, { cmd });
  const eventTypes = Array.isArray(msg.event_types) ? msg.event_types : (Array.isArray(msg.eventTypes) ? msg.eventTypes : BROWSER_PILOT_EVIDENCE_EVENT_TYPES);
  const limit = Math.max(1, Math.min(5000, Number(msg.limit || 500)));
  const hasTimeout = msg.timeoutMs !== undefined || msg.timeout_ms !== undefined;
  const timeout_ms = hasTimeout && typeof normalizeBrowserPilotTimeoutMs === 'function'
    ? normalizeBrowserPilotTimeoutMs({ timeoutMs: msg.timeoutMs ?? msg.timeout_ms }, 0)
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
    out.sources.hook_status = await safeBrowserPilotEvidence('hook.status', () => callPageBrowserPilot(tabId, 'hook.status', {}, evaluateOptions));
    out.sources.hook_events = await safeBrowserPilotEvidence('hook.collect', () => callPageBrowserPilot(tabId, 'hook.collect', { event_types: eventTypes, limit, timeout_ms }, evaluateOptions));
  }
  if (includeNetwork) {
    out.sources.network_status = await safeBrowserPilotEvidence('network.status', async () => await handleNetworkRecorderCommand(tabId, 'network.status', { sessionId: networkSessionId }) as BrowserPilotBridgeResponse);
    out.sources.network_entries = await safeBrowserPilotEvidence('network.list', async () => await handleNetworkRecorderCommand(tabId, 'network.list', { sessionId: networkSessionId, limit, includeDetails: true }) as BrowserPilotBridgeResponse);
  }
  if (includePerformance) {
    const entryType = msg.entryType ?? msg.entry_type;
    const nameContains = msg.nameContains ?? msg.name_contains;
    const performanceArgs: BrowserPilotBridgeCommand = { entryType, entry_type: entryType, nameContains, name_contains: nameContains };
    if (hasTimeout) performanceArgs.timeoutMs = timeout_ms;
    out.sources.performance = await safeBrowserPilotEvidence('hook.getPerformanceEntries', async () => await getPerformanceEntries(tabId, performanceArgs) as BrowserPilotBridgeResponse);
  }
  return { ok: true, data: out };
}
export { BROWSER_PILOT_EVIDENCE_EVENT_TYPES, safeBrowserPilotEvidence, handleBrowserPilotEvidenceCommand };
