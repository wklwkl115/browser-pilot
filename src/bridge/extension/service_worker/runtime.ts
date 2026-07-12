import { browserPilotBridgeInfo } from "./bridge_info.js";
import { handleBrowserPilotEvidenceCommand } from "./evidence.js";
import { handleBrowserPilotFrameCommand } from "./frame.js";
import { handleBrowserPilotHookCommand } from "./hook.js";
import { handleBrowserPilotHtml } from "./html.js";
import { handleBrowserPilotInputCommand } from "./input.js";
import { handleBrowserPilotInterceptCommand } from "./intercept.js";
import { handleBrowserPilotLayerCommand } from "./layer.js";
import { handleNetworkRecorderCommand } from "./network.js";
import { BrowserPilotNativeProtocol } from "./protocol.js";
import { BROWSER_PILOT_ERROR_CODES, browserPilotError, runtimeErrorMessage } from "./runtimeSupport.js";
import { captureScreenshotWithRetry } from "./screenshot.js";
import { enqueueBrowserPilotCommand } from "./state_store.js";
import { handleBrowserPilotTransferCommand } from "./transfer.js";
import { cancelWait, diagnoseBrowserPilot, waitForAll, waitForAny } from "./wait.js";
import { navigateAndWait, navigateBrowserPilot, waitForLoadState, waitForNavigation } from "./wait_navigation.js";
import { waitForNetworkIdle } from "./wait_network_idle.js";
import { waitForSelector } from "./wait_selector.js";
import { handleBrowserPilotWsCommand } from "./ws.js";
import type { JsonRecord, BrowserPilotBridgeCommand, BrowserPilotBridgeResponse, BrowserPilotBridgeSender, BrowserPilotNativeProtocolRuntime } from "./types.js";
import { handleBrowserPilotOperationCommand } from "./operation_coordinator";

// runtime.js - Browser Pilot command runtime (wait/network/hook/frame/html/screenshot).

const BROWSER_PILOT_PROTOCOL = (typeof BrowserPilotNativeProtocol !== 'undefined' ? BrowserPilotNativeProtocol : (self as typeof self & { BrowserPilotNativeProtocol?: unknown }).BrowserPilotNativeProtocol) as BrowserPilotNativeProtocolRuntime;
if (!BROWSER_PILOT_PROTOCOL || !BROWSER_PILOT_PROTOCOL.schema || !BROWSER_PILOT_PROTOCOL.nativeCommandMap) throw new Error('Browser Pilot protocol schema is not loaded');
const BROWSER_PILOT_ALIASES = BROWSER_PILOT_PROTOCOL.aliases || {};
function canonicalBrowserPilotCommand(cmd: unknown): string { const key = String(cmd || ''); return BROWSER_PILOT_PROTOCOL.canonicalCommand ? BROWSER_PILOT_PROTOCOL.canonicalCommand(key) : (BROWSER_PILOT_ALIASES[key] || key); }
const BROWSER_PILOT_NATIVE_COMMANDS = BROWSER_PILOT_PROTOCOL.nativeCommandMap;
function isBrowserPilotNativeCommand(cmd: unknown): boolean { return typeof cmd === 'string' && Object.prototype.hasOwnProperty.call(BROWSER_PILOT_NATIVE_COMMANDS, cmd); }
function nativeToBrowserPilotMessage(msg: BrowserPilotBridgeCommand): BrowserPilotBridgeCommand {
  const rawCmd = String(msg.cmd || '');
  const mapped = BROWSER_PILOT_NATIVE_COMMANDS[rawCmd];
  return { ...msg, cmd: mapped, native_cmd: rawCmd };
}

function attachNativeCommandMetadata(response: BrowserPilotBridgeResponse, nativeCommand: unknown): void {
  if (response.details && typeof response.details === "object" && response.details.cmd === undefined) response.details.cmd = nativeCommand;
  if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) return;
  const data = response.data as JsonRecord;
  if (data.native_cmd === undefined) data.native_cmd = nativeCommand;
}

function attachBridgeMetadata(response: BrowserPilotBridgeResponse): void {
  const bridge = browserPilotBridgeInfo();
  if (!bridge) return;
  if (response.ok === false) {
    if (!response.details || typeof response.details !== "object" || Array.isArray(response.details)) response.details = {};
    if (response.details.bridge === undefined) response.details.bridge = bridge;
    return;
  }
  if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) return;
  const data = response.data as JsonRecord;
  if (data.bridge === undefined) data.bridge = bridge;
}

async function handleBrowserPilotNativeCommand(msg: BrowserPilotBridgeCommand, sender: BrowserPilotBridgeSender): Promise<BrowserPilotBridgeResponse> {
  const response = await handleBrowserPilot(nativeToBrowserPilotMessage(msg), sender);
  attachNativeCommandMetadata(response, msg.cmd);
  attachBridgeMetadata(response);
  return response;
}

type RuntimeHandler = (command: string, tabId: number, message: BrowserPilotBridgeCommand) => Promise<unknown> | unknown;

const PREFIX_HANDLERS: Array<readonly [string, RuntimeHandler]> = [
  ["hook.", (command, tabId, message) => handleBrowserPilotHookCommand(command, tabId, message)],
  ["intercept.", (command, tabId, message) => handleBrowserPilotInterceptCommand(command, tabId, message)],
  ["evidence.", (command, tabId, message) => handleBrowserPilotEvidenceCommand(command, tabId, message)],
  ["ws.", (command, tabId, message) => handleBrowserPilotWsCommand(command, tabId, message)],
  ["frame.", (command, tabId, message) => handleBrowserPilotFrameCommand(command, tabId, message)],
  ["layer.", (command, tabId, message) => handleBrowserPilotLayerCommand(command, tabId, message)],
  ["transfer.", (command, tabId, message) => handleBrowserPilotTransferCommand(command, tabId, message)],
  ["input.", (command, tabId, message) => handleBrowserPilotInputCommand(command, tabId, message)],
];

const NETWORK_COMMANDS = new Set(["network.start", "network.stop", "network.status", "network.clear", "network.list", "network.get", "network.body", "network.exportHar", "network.wait"]);
const EXACT_HANDLERS = new Map<string, RuntimeHandler>([
  ["operation.begin", (command, _tabId, message) => handleBrowserPilotOperationCommand(command, message)],
  ["operation.finish", (command, _tabId, message) => handleBrowserPilotOperationCommand(command, message)],
  ["operation.cancel", (command, _tabId, message) => handleBrowserPilotOperationCommand(command, message)],
  ["wait.navigate", (_command, tabId, message) => navigateBrowserPilot(tabId, message)],
  ["wait.navigateAndWait", (_command, tabId, message) => navigateAndWait(tabId, message)],
  ["wait.navigation", (_command, tabId, message) => waitForNavigation(tabId, message)],
  ["wait.loadState", (_command, tabId, message) => waitForLoadState(tabId, message)],
  ["wait.networkIdle", (_command, tabId, message) => waitForNetworkIdle(tabId, message)],
  ["wait.selector", (_command, tabId, message) => waitForSelector(tabId, message)],
  ["wait.any", (_command, tabId, message) => waitForAny(tabId, message)],
  ["wait.all", (_command, tabId, message) => waitForAll(tabId, message)],
  ["wait.cancel", (_command, tabId, message) => cancelWait(tabId, message)],
  ["wait.diagnose", (_command, tabId, message) => diagnoseBrowserPilot(tabId, message)],
  ["html.get", (_command, tabId, message) => handleBrowserPilotHtml(tabId, message)],
  ["screenshot.capture", (_command, tabId, message) => captureScreenshotWithRetry(tabId, message)],
]);

function resolveRuntimeHandler(command: string): RuntimeHandler | undefined {
  if (NETWORK_COMMANDS.has(command)) return (networkCommand, tabId, message) => handleNetworkRecorderCommand(tabId, networkCommand, message);
  return PREFIX_HANDLERS.find(([prefix]) => command.startsWith(prefix))?.[1] || EXACT_HANDLERS.get(command);
}

async function handleBrowserPilot(msg: BrowserPilotBridgeCommand, sender: BrowserPilotBridgeSender): Promise<BrowserPilotBridgeResponse> {
  const cmd = canonicalBrowserPilotCommand(msg.cmd);
  const tabId = Number(msg.tabId || sender.tab?.id || 0);
  if (cmd === 'hook.list_sessions' || cmd.startsWith('operation.')) return await handleBrowserPilotImpl(msg, sender, cmd, tabId);
  if (!tabId) return browserPilotError('NO_SESSION', cmd + ' requires tabId', { cmd, details: {} });
  // Diagnostics must be out-of-band: enqueueing wait.diagnose makes its own
  // queue report show pending/depth=1 and masks the real post-uninstall state.
  // Running it directly still reports any pre-existing queued/running command
  // through getBrowserPilotQueueStats(tabId), so genuine queue leaks remain visible.
  if (cmd === 'wait.diagnose') return await handleBrowserPilotImpl(msg, sender, cmd, tabId);
  return await enqueueBrowserPilotCommand(tabId, cmd, () => handleBrowserPilotImpl(msg, sender, cmd, tabId));
}
async function handleBrowserPilotImpl(msg: BrowserPilotBridgeCommand, _sender: BrowserPilotBridgeSender, cmd: string, tabId: number): Promise<BrowserPilotBridgeResponse> {
  try {
    const handler = resolveRuntimeHandler(cmd);
    return handler
      ? await handler(cmd, tabId, msg) as BrowserPilotBridgeResponse
      : browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, "Unknown Browser Pilot command: " + cmd, { cmd });
  } catch (e) { return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, runtimeErrorMessage(e), { cmd, tabId }); }
}
export { BROWSER_PILOT_PROTOCOL, BROWSER_PILOT_ALIASES, canonicalBrowserPilotCommand, BROWSER_PILOT_NATIVE_COMMANDS, isBrowserPilotNativeCommand, nativeToBrowserPilotMessage, handleBrowserPilotNativeCommand, handleBrowserPilot, handleBrowserPilotImpl };
// ESM module metadata
export const __browserPilotBridgeModule_runtime = { name: "runtime", symbols: { BROWSER_PILOT_PROTOCOL, BROWSER_PILOT_ALIASES, canonicalBrowserPilotCommand, BROWSER_PILOT_NATIVE_COMMANDS, isBrowserPilotNativeCommand, nativeToBrowserPilotMessage, handleBrowserPilotNativeCommand, handleBrowserPilot, handleBrowserPilotImpl } };
