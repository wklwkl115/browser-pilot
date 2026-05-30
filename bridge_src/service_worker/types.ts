export type JsonRecord = Record<string, unknown>;

export type PiBridgeErrorPayload = {
  code?: string;
  message?: string;
  details?: JsonRecord;
};

export type PiBridgeResponse<T = unknown> = {
  ok: boolean;
  data?: T;
  result?: T;
  results?: unknown;
  error?: PiBridgeErrorPayload | string | unknown;
  error_code?: string;
  message?: string;
  details?: JsonRecord;
};


export type PiBridgeDict = JsonRecord;
export type PiChromeMessageSender = PiBridgeSender;
export type PiBridgeWebSocketLike = PiWebSocketLike;
export type PiChromeAlarm = { name?: string };
export type PiBrowserTabSyncTransport = {
  getSocket: () => PiBridgeWebSocketLike | null;
  getSockets?: () => PiBridgeWebSocketLike[];
  probe: (resetDelay: boolean) => Promise<void> | void;
};

export type PiBridgeWsEnvelope = JsonRecord & {
  id?: string | number | null;
  code?: unknown;
  tabId?: number;
};

export type PiBridgeCommand = JsonRecord & {
  cmd?: string;
  method?: string;
  tabId?: number;
  timeoutMs?: number;
  timeout_ms?: number;
  waitId?: string;
  wait_id?: string;
  abortController?: AbortController;
};

export type PiBridgeSender = {
  tab?: PiChromeTab;
  [key: string]: unknown;
};

export type PiNativeProtocolRuntime = {
  schema: JsonRecord;
  aliases?: Record<string, string>;
  nativeCommandMap: Record<string, string>;
  canonicalCommand?: (cmd: unknown) => string;
};

export type PiPersistentCdpBridge = {
  send?: (tabId: number, method: string, params?: JsonRecord, options?: JsonRecord) => Promise<PiBridgeResponse<JsonRecord>>;
  frameTree?: (tabId: number, options?: JsonRecord) => Promise<PiBridgeResponse<JsonRecord>>;
  evaluateInFrame?: (tabId: number, expression: string, options?: JsonRecord) => Promise<PiBridgeResponse<JsonRecord>>;
  addNewDocumentScript?: (tabId: number, source: string, options?: JsonRecord) => Promise<PiBridgeResponse<JsonRecord>>;
  removeNewDocumentScript?: (tabId: number, identifier: string, options?: JsonRecord) => Promise<PiBridgeResponse<JsonRecord>>;
  releaseIdle?: (maxIdleMs?: unknown) => Promise<PiBridgeResponse<JsonRecord>>;
  handleCommand?: (msg: PiBridgeCommand, sender: PiBridgeSender) => Promise<PiBridgeResponse<JsonRecord>>;
  hasSessionForTab?: (tabId: number) => boolean;
};

export type PiBrowserWaitRecord = JsonRecord & {
  key: string;
  waitId: string;
  wait_id: string;
  requestId: string;
  request_id: string;
  tabId: number;
  kind: string;
  criteria: JsonRecord;
  createdAt: number;
  status: string;
  listeners: Array<{ remove: () => void }>;
  timers: ReturnType<typeof setTimeout>[];
  cdpAttached: boolean;
  cdpDomains: Set<string>;
  cdpSubscriptions: string[];
  cdpEvents: unknown[];
  diagnostics: unknown[];
  lastEventAt: number | null;
  lastError: string | null;
  abortController: AbortController;
};

export type NetworkStringList = Array<string | number | boolean>;
export type NetworkFilterDecision = { match: boolean; reason: string };
export type NetworkBodyMimeDecision = NetworkFilterDecision & { availability?: string; mimeType?: string };
export type NetworkHeaders = JsonRecord;
export type NetworkRequestRecord = JsonRecord & {
  url?: string;
  method?: string;
  headers?: NetworkHeaders;
  hasPostData?: boolean;
  postData?: string;
  postDataTruncated?: boolean;
  postDataOriginalLength?: number;
};
export type NetworkResponseRecord = JsonRecord & {
  url?: string;
  status?: number;
  statusText?: string;
  headers?: NetworkHeaders;
  mimeType?: string;
  protocol?: string;
  fromServiceWorker?: boolean;
  remoteIPAddress?: string;
  connectionId?: string | number;
};
export type NetworkBodyStoreEntry = JsonRecord & {
  bodyRef: string;
  requestId: string;
  tabId: number;
  sessionId: string;
  base64Encoded: boolean;
  body: string;
  bodyTruncated: boolean;
  originalLength: number;
  bytes: number;
  mimeType: string;
  createdAt: number;
  bodyAvailability?: string;
  bodyUnavailableReason?: string | null;
};
export type NetworkDataStats = JsonRecord & { encodedDataLength?: number; dataLength?: number; chunks?: number };
export type NetworkFrameRecord = JsonRecord & { payloadData?: string; eventName?: string; eventId?: string; data?: string; method?: string; opcode?: number };
export type NetworkRecord = JsonRecord & {
  id: string;
  requestId: string;
  tabId: number;
  sessionId: string;
  seq: number;
  createdAt: number;
  updatedAt: number;
  wallTime?: number | null;
  timestamp?: number | null;
  type?: string;
  resourceType?: string;
  phase?: string;
  request: NetworkRequestRecord;
  response?: NetworkResponseRecord | null;
  requestExtraInfo?: JsonRecord & { headers?: NetworkHeaders };
  responseExtraInfo?: JsonRecord & { headers?: NetworkHeaders; statusCode?: number };
  redirects: unknown[];
  data: NetworkDataStats;
  timing: JsonRecord;
  fromCache: boolean;
  failed?: JsonRecord | null;
  errorText?: string | null;
  canceled?: boolean;
  blockedReason?: string | null;
  initiator?: unknown;
  wsFrames: NetworkFrameRecord[];
  sseEvents: NetworkFrameRecord[];
  bodyRef?: string | null;
  bodyPreview?: string | null;
  bodyTruncated?: boolean;
  bodyError?: string | null;
  bodyPending?: boolean;
  bodyAvailability?: string;
  bodyUnavailableReason?: string | null;
  bodySkipped?: string;
  bodyCaptureAttemptedAt?: number;
  bodyCapturedAt?: number;
  body?: unknown;
  loaderId?: unknown;
  documentURL?: unknown;
  frameId?: unknown;
  finishedAt?: number;
  encodedDataLength?: number;
  webSocketRequest?: unknown;
  webSocketResponse?: unknown;
  webSocketClosedAt?: number;
  webSocketError?: unknown;
  overflow?: number;
};
export type NetworkRecorderCounters = JsonRecord & Record<
  | "request" | "requestExtraInfo" | "response" | "responseExtraInfo" | "data" | "finished" | "failed" | "servedFromCache"
  | "webSocket" | "sse" | "page" | "bodyCaptured" | "bodyErrors" | "waitsResolved" | "waitsTimedOut" | "waitsCancelled",
  number
>;
export type NetworkRecorderConfig = JsonRecord & {
  sessionId: string;
  maxEntries: number;
  maxAgeMs: number;
  maxBodyBytes: number;
  maxPostDataBytes: number;
  maxFrames: number;
  maxFrameBytes: number;
  maxSseEvents: number;
  captureBodies: boolean;
  captureRequestPostData: boolean;
  includeWebSocketFrames: boolean;
  includeSse: boolean;
  bodyTimeoutMs: number;
  bodyMimeAllow: string[];
  includeUrls: NetworkStringList;
  excludeUrls: NetworkStringList;
  resourceTypes: NetworkStringList;
  methods: NetworkStringList;
  statuses: NetworkStringList;
  clearOnStart: boolean;
  storeHeaders: boolean;
  storePostData: boolean;
  createdFrom: unknown;
  filter: (rec: NetworkRecord, phase: string) => NetworkFilterDecision;
};
export type NetworkRecorderWait = JsonRecord & {
  waitId: string;
  condition: string;
  criteria: JsonRecord;
  createdAt: number;
  resolve: (value: PiBridgeResponse) => void;
  abortController: AbortController;
  done: boolean;
  idleMs: number;
  count: number;
  lastMatchSeq: number;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  intervalHandle?: ReturnType<typeof setInterval>;
  abortHandler?: () => void;
};
export type NetworkRecorder = JsonRecord & {
  tabId: number;
  sessionId: string;
  key: string;
  recorderId: string;
  active: boolean;
  createdAt: number;
  startedAt: number;
  stoppedAt: number;
  recoveredAt?: number;
  historyLost?: boolean;
  stateGeneration?: number;
  config: NetworkRecorderConfig;
  filter: NetworkRecorderConfig["filter"];
  cdpRecord: PiBrowserWaitRecord;
  entries: NetworkRecord[];
  byRequestId: Map<string, NetworkRecord>;
  bodyStore: Map<string, NetworkBodyStoreEntry>;
  bodyByRequestId: Map<string, string>;
  waits: Map<string, NetworkRecorderWait>;
  seqBase: number;
  counters: NetworkRecorderCounters;
  overflowCount: number;
  bodyOverflowCount: number;
  lastErrors: unknown[];
  diagnostics: unknown[];
  lifecycleEvents: unknown[];
  lastEventAt: number;
  pendingBodyCount: number;
};
export type NetworkWaitNotifier = (recorder: NetworkRecorder, eventType: string, rec: NetworkRecord | null) => void;

export type PiBrowserCdpSubscription = {
  subscriptionId: string;
  tabId: number;
  events: string[];
  createdAt: number;
  handler: (...args: unknown[]) => void;
  waitId: string | null;
  kind: string | null;
};

export type PiBrowserCdpDomainRef = {
  key: string;
  tabId: number;
  domain: string;
  count: number;
  holders: Map<string, { holderId: string; waitId: string | null; kind: string | null; acquiredAt: number }>;
  mode: string | null;
  createdAt: number;
  enabledAt: number;
  lastError: string | null;
  disablePending?: boolean;
  disableInFlight?: boolean;
  disablePromise?: Promise<unknown> | null;
  disableToken?: number;
};

export type PiBrowserLegacyCommandSurface = Partial<Record<
  | "cleanupNetworkRecorderTab"
  | "piBridgeInfo"
  | "ensurePiBrowserDispatcher"
  | "handlePiBrowserHookCommand"
  | "handlePiBrowserEvidenceCommand"
  | "handlePiBrowserFrameCommand"
  | "handlePiBrowserTransferCommand"
  | "handleNetworkRecorderCommand"
  | "handlePiBrowserHtml"
  | "captureScreenshotWithRetry",
  (...args: unknown[]) => unknown
>>;

export type PiChromeEvent<TListener extends (...args: never[]) => unknown = (...args: never[]) => unknown> = {
  addListener(listener: TListener): void;
  removeListener(listener: TListener): void;
};

export type PiChromeTab = {
  id?: number;
  tabId?: number;
  url?: string;
  title?: string;
  active?: boolean;
  windowId?: number;
  status?: string;
  pendingUrl?: string;
  favIconUrl?: string;
  [key: string]: unknown;
};

export type PiChromeDownloadItem = {
  id?: number;
  url?: string;
  finalUrl?: string;
  filename?: string;
  mime?: string;
  state?: string;
  bytesReceived?: number;
  totalBytes?: number;
  danger?: string;
  exists?: boolean;
  startTime?: string;
  endTime?: string;
  error?: string;
  [key: string]: unknown;
};

export type PiChromeCookie = {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  storeId?: string;
  partitionKey?: { topLevelSite?: string; hasCrossSiteAncestor?: boolean };
  [key: string]: unknown;
};

export type PiWebSocketLike = {
  readyState: number;
  send(data: string): void;
};

export type PiBridgeWebSocket = WebSocket & PiWebSocketLike;

export type PiChromeRuntime = {
  id?: string;
  lastError?: { message?: string };
  getManifest(): { name?: string; version?: string; version_name?: string; [key: string]: unknown };
  getURL(path: string): string;
  reload(): void;
  sendMessage(message: unknown): Promise<unknown>;
  onMessage: PiChromeEvent<(message: unknown, sender: PiBridgeSender, sendResponse: (response?: unknown) => void) => void | boolean | Promise<unknown>>;
  onInstalled: PiChromeEvent<() => void>;
  onStartup: PiChromeEvent<() => void>;
};

export type PiChromeTabs = {
  query(queryInfo: JsonRecord): Promise<PiChromeTab[]>;
  update(tabId: number, updateProperties: JsonRecord): Promise<PiChromeTab>;
  create(createProperties: JsonRecord): Promise<PiChromeTab>;
  get(tabId: number): Promise<PiChromeTab>;
  remove(tabId: number): Promise<void>;
  captureVisibleTab(windowId?: number, options?: JsonRecord): Promise<string>;
  onCreated: PiChromeEvent<(tab: PiChromeTab) => void>;
  onUpdated: PiChromeEvent<(tabId: number, changeInfo: JsonRecord, tab: PiChromeTab) => void>;
  onRemoved: PiChromeEvent<(tabId: number, removeInfo?: JsonRecord) => void>;
};

export type PiChromeDebugger = {
  attach(target: { tabId: number }, protocolVersion?: string): Promise<void>;
  detach(target: { tabId: number }): Promise<void>;
  sendCommand(target: { tabId: number }, method: string, params?: JsonRecord): Promise<unknown>;
  getTargets(): Promise<JsonRecord[]>;
  onDetach: PiChromeEvent<(source: { tabId?: number }, reason: string) => void>;
  onEvent: PiChromeEvent<(source: { tabId?: number }, method: string, params?: JsonRecord) => void>;
};

export type PiChromeDownloads = {
  download(options: JsonRecord, callback: (id?: number) => void): void;
  search(query: JsonRecord, callback: (items: PiChromeDownloadItem[]) => void): void;
  onChanged: PiChromeEvent<(delta: JsonRecord & { id?: number; state?: { current?: string }; filename?: unknown }) => void>;
  onCreated: PiChromeEvent<(item: PiChromeDownloadItem) => void>;
};

export type PiChromeApi = {
  runtime: PiChromeRuntime;
  debugger: PiChromeDebugger;
  tabs: PiChromeTabs;
  windows: { update(windowId: number, updateInfo: JsonRecord): Promise<unknown> };
  scripting: { executeScript(options: JsonRecord): Promise<unknown[]> };
  downloads: PiChromeDownloads;
  cookies: { getAll(details: JsonRecord): Promise<PiChromeCookie[]> };
  management: { getAll(): Promise<Array<JsonRecord & { id?: string; name?: string; enabled?: boolean; type?: string; version?: string }>>; setEnabled(id: string, enabled: boolean): Promise<void> };
  alarms: { create(name: string, alarmInfo: JsonRecord): void; clear?(name: string): Promise<boolean> | boolean; onAlarm: PiChromeEvent<(alarm: { name: string }) => void | Promise<void>> };
  storage?: { session?: { get(keys?: string | string[] | JsonRecord): Promise<JsonRecord>; set(items: JsonRecord): Promise<void>; remove(keys: string | string[]): Promise<void> } };
  contentSettings?: Record<string, { set(details: JsonRecord): Promise<void> }>;
  declarativeNetRequest: { updateDynamicRules(rules: JsonRecord): Promise<void>; updateSessionRules?: (rules: JsonRecord) => Promise<void> };
  webNavigation: Record<string, PiChromeEvent<(details: JsonRecord & { tabId?: number; frameId?: number; url?: string }) => void>>;
};

export type ChromeApi = PiChromeApi;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function errorDetails(error: unknown): JsonRecord {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) };
}
