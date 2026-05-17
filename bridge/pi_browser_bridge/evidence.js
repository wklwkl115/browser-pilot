// evidence.js - Pi browser native event/evidence aggregation.

const PI_BROWSER_EVIDENCE_EVENT_TYPES = ['network', 'dom', 'console', 'error', 'storage', 'websocket', 'crypto', 'dom_sinks'];

async function safePiBrowserEvidence(label, task) {
  try {
    const result = await task();
    return result && result.ok === false ? { ok: false, source: label, error_code: result.error_code || result.error?.code || PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, error: result.error || result.message || result.error?.message || 'evidence source failed', details: result.details || result.error?.details || {} } : { ok: true, source: label, data: result?.data !== undefined ? result.data : result };
  } catch (e) {
    return { ok: false, source: label, error_code: PI_BROWSER_ERROR_CODES.INTERNAL_ERROR, error: e.message || String(e), details: { name: e.name || 'Error' } };
  }
}

async function handlePiBrowserEvidenceCommand(cmd, tabId, msg) {
  if (cmd !== 'evidence.collect') return piBrowserError(PI_BROWSER_ERROR_CODES.INVALID_RULE, 'Unknown Pi Browser evidence command: ' + cmd, { cmd });
  const eventTypes = Array.isArray(msg.event_types) ? msg.event_types : (Array.isArray(msg.eventTypes) ? msg.eventTypes : PI_BROWSER_EVIDENCE_EVENT_TYPES);
  const limit = Math.max(1, Math.min(5000, Number(msg.limit || 500)));
  const timeout_ms = Math.max(0, Math.min(300000, Number(msg.timeout_ms || msg.timeoutMs || 0)));
  const includeHook = msg.includeHook !== false && msg.hook !== false;
  const includeNetwork = msg.includeNetwork !== false && msg.network !== false;
  const includePerformance = msg.includePerformance !== false && msg.performance !== false;
  const networkSessionId = msg.networkSessionId || msg.sessionId || msg.session_id || 'default';
  const out = {
    tabId: Number(tabId),
    collected_at: new Date().toISOString(),
    event_types: eventTypes,
    sources: {},
  };
  if (includeHook) {
    out.sources.hook_status = await safePiBrowserEvidence('hook.status', () => callPagePiBrowserWithAutoReinstall(tabId, 'hook.status', {}));
    out.sources.hook_events = await safePiBrowserEvidence('hook.collect', () => callPagePiBrowserWithAutoReinstall(tabId, 'hook.collect', { event_types: eventTypes, limit, timeout_ms }));
  }
  if (includeNetwork) {
    out.sources.network_status = await safePiBrowserEvidence('network.status', () => handleNetworkRecorderCommand(tabId, 'network.status', { sessionId: networkSessionId }));
    out.sources.network_entries = await safePiBrowserEvidence('network.list', () => handleNetworkRecorderCommand(tabId, 'network.list', { sessionId: networkSessionId, limit, includeDetails: true }));
  }
  if (includePerformance) {
    out.sources.performance = await safePiBrowserEvidence('hook.getPerformanceEntries', () => getPerformanceEntries(tabId, { entryType: msg.entryType, nameContains: msg.nameContains }));
  }
  return { ok: true, data: out };
}
