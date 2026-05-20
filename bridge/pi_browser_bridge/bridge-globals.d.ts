type PiBridgeDict = Record<string, unknown>;

type PiBridgeData = PiBridgeDict & {
  session_id?: string;
  state?: string;
  installed_at?: string;
  dispatcher_version?: string;
  pi_browser_version?: string;
  install_epoch?: number;
  owner_session_id?: string;
  install_fingerprint?: string;
  cleanup_warnings?: unknown[];
  residue_signatures?: unknown[];
  listener_cleanup?: unknown;
  result?: PiBridgeData;
  readyState?: string;
  frames?: unknown[];
  frameCount?: number;
  iframeCount?: number;
  inflight?: number;
  last_errors?: unknown[];
};

type PiBridgeResponse = {
  ok?: boolean;
  data?: PiBridgeData;
  result?: PiBridgeData;
  results?: PiBridgeDict[];
  error?: string | PiBridgeDict;
  message?: string;
  error_code?: string;
  details?: PiBridgeDict;
  newTabs?: unknown[];
  [key: string]: unknown;
};

type PiBridgeCommand = {
  cmd: string;
  tabId?: number | string;
  targetTabId?: number | string;
  timeoutMs?: number;
  timeout_ms?: number;
  timeout?: number;
  method?: string;
  action?: string;
  params?: PiBridgeDict;
  [key: string]: unknown;
};

type PiBridgeWsEnvelope = {
  id?: string | number;
  code?: string | PiBridgeCommand | PiBridgeDict;
  tabId?: number | string;
  [key: string]: unknown;
};

type PiBridgeTab = {
  id?: number;
  tabId?: number;
  url?: string;
  title?: string;
  active?: boolean;
  status?: string;
  windowId?: number;
  [key: string]: unknown;
};

type PiBridgeWaitRecord = {
  waitId?: string;
  wait_id?: string;
  requestId?: string;
  request_id?: string;
  key?: string;
  tabId: number;
  kind?: string;
  status?: string;
  createdAt?: number;
  listeners?: Array<{ remove?: () => void }>;
  timers?: ReturnType<typeof setTimeout>[];
  cdpDomains?: Set<string>;
  cdpSubscriptions?: string[];
  cdpEvents?: PiBridgeDict[];
  diagnostics?: PiBridgeDict[];
  lastEventAt?: number;
  lastError?: unknown;
  abortController?: AbortController;
  [key: string]: unknown;
};

type PiBridgeWebSocketLike = {
  readyState: number;
  send(data: string): void;
  close?(): void;
  onopen?: ((event?: Event) => void) | null;
  onclose?: ((event?: CloseEvent) => void) | null;
  onerror?: ((event?: Event) => void) | null;
  onmessage?: ((event: { data: unknown }) => void | Promise<void>) | null;
};

type PiNativeProtocolGlobal = {
  schema?: PiBridgeDict;
  aliases?: Record<string, string>;
  nativeCommandMap?: Record<string, string>;
  validateCommand?: (msg: PiBridgeCommand, options?: PiBridgeDict) => { ok: boolean; command?: PiBridgeCommand; error?: string; details?: PiBridgeDict };
  canonicalCommand?: (cmd: string) => string;
};

type PiChromeEvent<TListener> = {
  addListener(callback: TListener): void;
  removeListener(callback: TListener): void;
};

type PiChromeMessageSender = {
  tab?: PiBridgeTab;
  frameId?: number;
  id?: string;
  url?: string;
  [key: string]: unknown;
};

type PiChromeManifest = PiBridgeDict & {
  name?: string;
  version?: string;
  version_name?: string;
};

type PiChromeDebuggee = { tabId?: number; extensionId?: string; targetId?: string };
type PiChromeDebuggerTarget = PiBridgeDict & { tabId?: number; id?: string; title?: string; url?: string; attached?: boolean };

type PiChromeDebuggerApi = {
  attach(target: PiChromeDebuggee, requiredVersion?: string): Promise<void>;
  detach(target: PiChromeDebuggee): Promise<void>;
  sendCommand(target: PiChromeDebuggee, method: string, commandParams?: PiBridgeDict): Promise<PiBridgeDict>;
  getTargets?: () => Promise<PiChromeDebuggerTarget[]>;
  onEvent: PiChromeEvent<(source: PiChromeDebuggee, method: string, params?: PiBridgeDict) => void>;
  onDetach: PiChromeEvent<(source: PiChromeDebuggee, reason: string) => void>;
};

type PiChromeTabsApi = {
  query(queryInfo: PiBridgeDict): Promise<PiBridgeTab[]>;
  update(tabId: number, updateProperties: PiBridgeDict): Promise<PiBridgeTab>;
  create(createProperties: PiBridgeDict): Promise<PiBridgeTab>;
  get(tabId: number): Promise<PiBridgeTab>;
  remove(tabId: number): Promise<void>;
  captureVisibleTab(windowId: number, options?: PiBridgeDict): Promise<string>;
  onCreated: PiChromeEvent<(tab: PiBridgeTab) => void>;
  onUpdated: PiChromeEvent<(tabId: number, changeInfo: PiBridgeDict, tab: PiBridgeTab) => void>;
  onRemoved: PiChromeEvent<(tabId: number, removeInfo?: PiBridgeDict) => void>;
};

type PiChromeDownloadsApi = {
  download(options: PiBridgeDict, callback?: (downloadId?: number) => void): void;
  search(query: PiBridgeDict, callback: (items: PiBridgeDict[]) => void): void;
  onChanged: PiChromeEvent<(delta: PiBridgeDict) => void>;
  onCreated: PiChromeEvent<(item: PiBridgeDict) => void>;
};

type PiChromeRuntimeApi = {
  id: string;
  lastError?: { message?: string };
  getManifest(): PiChromeManifest;
  getURL(path: string): string;
  reload(): void;
  sendMessage(message: unknown): Promise<PiBridgeResponse>;
  onMessage: PiChromeEvent<(msg: PiBridgeCommand, sender: PiChromeMessageSender, sendResponse: (response?: unknown) => void) => boolean | void | Promise<unknown>>;
  onInstalled: PiChromeEvent<() => void>;
  onStartup: PiChromeEvent<() => void>;
};

type PiChromeScriptingApi = {
  executeScript(details: {
    target: { tabId: number; frameIds?: number[]; allFrames?: boolean };
    world?: "MAIN" | "ISOLATED" | string;
    files?: string[];
    func?: Function;
    args?: unknown[];
    injectImmediately?: boolean;
  }): Promise<Array<{ result?: unknown; frameId?: number; documentId?: string }>>;
};

type PiChromeApi = {
  runtime: PiChromeRuntimeApi;
  tabs: PiChromeTabsApi;
  windows: { update(windowId: number, updateInfo: PiBridgeDict): Promise<PiBridgeDict> };
  debugger: PiChromeDebuggerApi;
  scripting: PiChromeScriptingApi;
  downloads?: PiChromeDownloadsApi;
  cookies: { getAll(details: PiBridgeDict): Promise<PiBridgeDict[]> };
  management: { getAll(): Promise<PiBridgeDict[]>; setEnabled(id: string, enabled: boolean): Promise<void> };
  alarms: {
    create(name: string, alarmInfo: PiBridgeDict): void;
    onAlarm: PiChromeEvent<(alarm: { name: string; scheduledTime?: number }) => void | Promise<void>>;
  };
  contentSettings?: Record<string, { set(details: PiBridgeDict): Promise<void> }>;
  declarativeNetRequest: { updateDynamicRules(details: PiBridgeDict): Promise<void> | void };
  webNavigation?: Record<string, PiChromeEvent<(details: PiBridgeDict) => void>>;
};

type PiPersistentCdpBridge = {
  send(tabId: number | string, method: string, params?: PiBridgeDict, options?: PiBridgeDict): Promise<PiBridgeResponse>;
  frameTree?(tabId: number | string, options?: PiBridgeDict): Promise<PiBridgeResponse>;
  evaluateInFrame?(tabId: number | string, expression: string, options?: PiBridgeDict): Promise<PiBridgeResponse>;
  addNewDocumentScript?(tabId: number | string, source: string, options?: PiBridgeDict): Promise<PiBridgeResponse>;
  removeNewDocumentScript?(tabId: number | string, identifier: string, options?: PiBridgeDict): Promise<PiBridgeResponse>;
  handleCommand?(msg: PiBridgeCommand, sender?: PiChromeMessageSender): Promise<PiBridgeResponse>;
};

type PiBrowserCdpSubscriptionRecord = {
  id: string;
  tabId: number;
  method?: string;
  handler?: (source: PiChromeDebuggee, method: string, params?: PiBridgeDict) => void;
  createdAt?: number;
  [key: string]: unknown;
};

type PiBrowserNetworkRecord = PiBridgeDict & {
  requestId?: string;
  url?: string;
  method?: string;
  status?: number;
  type?: string;
  bodyRef?: string | null;
  bodyAvailability?: string;
};

type PiBrowserNetworkRecorder = {
  tabId: number;
  sessionId: string;
  key: string;
  records: PiBrowserNetworkRecord[];
  bodies?: Map<string, PiBridgeDict>;
  config?: PiBridgeDict;
  [key: string]: unknown;
};

type PiBrowserHookCommand = PiBridgeCommand & {
  session_id?: string;
  sessionId?: string;
  targets?: PiBridgeDict;
  options?: PiBridgeDict;
  buffer_size?: number;
};

type PiBrowserHookPageApi = {
  version?: string;
  dispatcher_version?: string;
  dispatch?: (cmd: string, args?: PiBridgeDict) => PiBridgeResponse;
  uninstall?: (options?: PiBridgeDict) => PiBridgeResponse;
  [key: string]: unknown;
};

type PiBridgeGlobalThis = typeof globalThis & {
  PiNativeProtocol?: PiNativeProtocolGlobal;
  PiPersistentCdp?: PiPersistentCdpBridge;
  piPersistentCdpBridge?: PiPersistentCdpBridge;
  __piBrowserUnhandledRejectionCleanupInstalled?: boolean;
  __PI_BROWSER_HOOKS__?: PiBrowserHookPageApi;
};

declare const chrome: PiChromeApi;
declare function importScripts(...urls: string[]): void;

interface Window {
  PiNativeProtocol?: PiNativeProtocolGlobal;
  PiPersistentCdp?: PiPersistentCdpBridge;
  piPersistentCdpBridge?: PiPersistentCdpBridge;
  __piBrowserUnhandledRejectionCleanupInstalled?: boolean;
  __PI_BROWSER_HOOKS__?: PiBrowserHookPageApi;
}

interface WorkerGlobalScope {
  PiNativeProtocol?: PiNativeProtocolGlobal;
  PiPersistentCdp?: PiPersistentCdpBridge;
  piPersistentCdpBridge?: PiPersistentCdpBridge;
  __piBrowserUnhandledRejectionCleanupInstalled?: boolean;
  __PI_BROWSER_HOOKS__?: PiBrowserHookPageApi;
}
