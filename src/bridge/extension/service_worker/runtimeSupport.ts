import { chromeApi as chrome } from "./runtimeEnv.js";
import type { BrowserPilotBridgeCommand, BrowserPilotBridgeResponse, BrowserPilotPersistentCdpBridge, JsonRecord } from "./types.js";

export const BROWSER_PILOT_HOOK_DISPATCHER_FILE = "dist/hook_dispatcher.js";
export const BROWSER_PILOT_ERROR_CODES = {
  NO_SESSION: "NO_SESSION", SESSION_NOT_FOUND: "SESSION_NOT_FOUND", INVALID_SESSION: "INVALID_SESSION", ALREADY_INSTALLED: "ALREADY_INSTALLED", NOT_INSTALLED: "NOT_INSTALLED",
  INVALID_RULE: "INVALID_RULE", UNSUPPORTED_TARGET: "UNSUPPORTED_TARGET", INJECTION_FAILED: "INJECTION_FAILED",
  SAFETY_BLOCKED: "SAFETY_BLOCKED", TIMEOUT: "TIMEOUT", NAVIGATION_TIMEOUT: "NAVIGATION_TIMEOUT", SELECTOR_TIMEOUT: "SELECTOR_TIMEOUT", SELECTOR_NOT_FOUND: "SELECTOR_NOT_FOUND", INVALID_SELECTOR: "INVALID_SELECTOR", NETWORK_IDLE_TIMEOUT: "NETWORK_IDLE_TIMEOUT", NETWORK_RECORDER_NOT_STARTED: "NETWORK_RECORDER_NOT_STARTED", NETWORK_RECORDER_TIMEOUT: "NETWORK_RECORDER_TIMEOUT", REQUEST_NOT_FOUND: "REQUEST_NOT_FOUND", BODY_UNAVAILABLE: "BODY_UNAVAILABLE", FRAME_DETACHED: "FRAME_DETACHED", CROSS_ORIGIN_IFRAME: "CROSS_ORIGIN_IFRAME", TAB_NOT_FOUND: "TAB_NOT_FOUND", TAB_CRASHED: "TAB_CRASHED", BACKGROUND_THROTTLED: "BACKGROUND_THROTTLED", EVENT_SUBSCRIPTION_FAILED: "EVENT_SUBSCRIPTION_FAILED", CANCELLED: "CANCELLED", BUFFER_OVERFLOW: "BUFFER_OVERFLOW", AMBIGUOUS_DOWNLOAD: "AMBIGUOUS_DOWNLOAD", INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export function runtimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function runtimeErrorPreview(error: unknown): unknown {
  return error instanceof Error ? error.message : error;
}

export function runtimeRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

export function redactSensitive(value: unknown, depth = 0, seen?: WeakSet<object>): unknown {
  const patterns = [
    /bearer\s+fixture-secret/gi,
    /fixture-secret/gi,
    /fixture-password/gi,
    /(authorization[=:]\s*bearer\s+)[^\s&'"<>]+/gi,
    /([?&](?:token|secret|password|passwd|pwd|auth|authorization)=)[^&#\s'"<>]+/gi,
  ];
  if (value == null) return value;
  if (typeof value === "string") {
    let out = value;
    for (const re of patterns) out = out.replace(re, (_match, prefix) => prefix ? prefix + "[REDACTED]" : "[REDACTED]");
    return out;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return String(value);
  if (depth > 8) return "[REDACTED_DEPTH]";
  seen = seen || new WeakSet();
  if (seen.has(value)) return "[REDACTED_CYCLE]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1, seen));
  const out: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = /(token|secret|password|passwd|pwd|authorization|cookie|set-cookie)/.test(key.toLowerCase())
      ? "[REDACTED]"
      : redactSensitive(item, depth + 1, seen);
  }
  return out;
}

export function browserPilotError(errorCode: string, message: unknown, details?: unknown): BrowserPilotBridgeResponse {
  const text = String(redactSensitive(message || errorCode || "ERROR"));
  return { ok: false, error_code: errorCode, error: text, details: runtimeRecord(redactSensitive(details || {})) };
}

export function bridgeError(errorCode: string | undefined, message: unknown, details?: unknown): BrowserPilotBridgeResponse {
  const code = errorCode || BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR;
  const text = String(redactSensitive(message || code));
  const baseDetails = details && typeof details === "object" ? details : details === undefined ? {} : { raw: details };
  return { ok: false, error_code: code, error: text, details: runtimeRecord(redactSensitive(baseDetails)) };
}

function structuredBridgeError(error: unknown, command?: unknown): BrowserPilotBridgeResponse | undefined {
  const record = runtimeRecord(error);
  if (record.code === undefined || typeof record.message !== "string") return undefined;
  const details = { ...runtimeRecord(record.details) };
  if (command !== undefined && details.cmd === undefined) details.cmd = command;
  return bridgeError(String(record.code), record.message, details);
}

function rawBridgeError(response: BrowserPilotBridgeResponse, command?: unknown): BrowserPilotBridgeResponse {
  const raw = response.error !== undefined ? response.error : response.message !== undefined ? response.message : response;
  const details: JsonRecord = { cmd: command, ...runtimeRecord(response.details), raw };
  const rawRecord = runtimeRecord(raw);
  if (rawRecord.name && details.name === undefined) details.name = rawRecord.name;
  return bridgeError(
    String(response.error_code || rawRecord.error_code || rawRecord.code || BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR),
    rawRecord.message || (raw && typeof raw === "object" ? String(rawRecord.code || rawRecord.name || "bridge command failed") : raw || "bridge command failed"),
    details,
  );
}

export function normalizeBridgeResponse(response: BrowserPilotBridgeResponse, command?: unknown): BrowserPilotBridgeResponse {
  if (!response || response.ok !== false) return response;
  return structuredBridgeError(response.error, command) || rawBridgeError(response, command);
}

export function browserPilotSleep(ms: unknown): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

export function browserPilotPersistentCdp(): BrowserPilotPersistentCdpBridge | undefined {
  const runtime = globalThis as typeof globalThis & {
    browserPilotPersistentCdpBridge?: BrowserPilotPersistentCdpBridge;
    BrowserPilotPersistentCdp?: BrowserPilotPersistentCdpBridge;
  };
  return runtime.browserPilotPersistentCdpBridge || runtime.BrowserPilotPersistentCdp;
}

export function normalizePersistentBrowserPilotResponse(response: BrowserPilotBridgeResponse): BrowserPilotBridgeResponse {
  const error = runtimeRecord(response?.error);
  return response && response.ok === false && response.error && !response.error_code
    ? browserPilotError(String(error.code || BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR), error.message || "persistent CDP command failed", error.details || {})
    : response;
}

function normalizeBrowserPilotEvalTimeoutMs(options: BrowserPilotBridgeCommand = {}): number | undefined {
  const raw = options.timeoutMs !== undefined ? options.timeoutMs : options.timeout_ms;
  if (raw === undefined || raw === null) return undefined;
  const timeoutMs = Number(raw);
  return Number.isFinite(timeoutMs) && timeoutMs >= 0 ? Math.floor(timeoutMs) : undefined;
}

export function browserPilotWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function browserPilotEval(tabId: number, expression: string, awaitPromise = true, options: BrowserPilotBridgeCommand = {}): Promise<BrowserPilotBridgeResponse> {
  const timeoutMs = normalizeBrowserPilotEvalTimeoutMs(options);
  const cdp = browserPilotPersistentCdp();
  if (cdp?.send) {
    const response = normalizePersistentBrowserPilotResponse(await cdp.send(tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, { persistent: true, name: "eval", timeoutMs }));
    if (!response || response.ok === false) return response;
    const result = runtimeRecord(runtimeRecord(response.data).result || response.result || response.data);
    const exceptionDetails = runtimeRecord(result.exceptionDetails);
    if (result.exceptionDetails) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, runtimeRecord(exceptionDetails.exception).description || "Runtime.evaluate failed", exceptionDetails);
    return { ok: true, data: runtimeRecord(result.result).value };
  }
  await chrome.debugger.attach({ tabId }, "1.3");
  try {
    const command = chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    const result = timeoutMs === undefined ? await command : await browserPilotWithTimeout(command, timeoutMs, "Runtime.evaluate");
    await chrome.debugger.detach({ tabId });
    const resultRecord = runtimeRecord(result);
    const exceptionDetails = runtimeRecord(resultRecord.exceptionDetails);
    if (resultRecord.exceptionDetails) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, runtimeRecord(exceptionDetails.exception).description || "Runtime.evaluate failed", exceptionDetails);
    return { ok: true, data: runtimeRecord(resultRecord.result).value };
  } catch (error) {
    try { await chrome.debugger.detach({ tabId }); }
    catch (detachError) { console.warn("[BROWSER-PILOT] Failed to detach debugger after Runtime.evaluate fallback", tabId, runtimeErrorPreview(detachError)); }
    throw error;
  }
}

export async function callPageBrowserPilot(tabId: number, command: string, args: unknown, options: BrowserPilotBridgeCommand = {}): Promise<BrowserPilotBridgeResponse> {
  const expression = `(window.__BROWSER_PILOT_HOOKS__ && window.__BROWSER_PILOT_HOOKS__.dispatch) ? window.__BROWSER_PILOT_HOOKS__.dispatch(${JSON.stringify(command)}, ${JSON.stringify(args || {})}) : {ok:false,error_code:'NO_SESSION',error:'Browser Pilot dispatcher is not installed'}`;
  const response = await browserPilotEval(tabId, expression, true, options);
  return (response.ok ? runtimeRecord(response.data) : response) as BrowserPilotBridgeResponse;
}
