export type JsonRecord = Record<string, unknown>;

export type BrowserPilotBridgeErrorPayload = {
  code?: string;
  message?: string;
  details?: JsonRecord;
};

export type BrowserPilotBridgeErrorRecord = BrowserPilotBridgeErrorPayload & {
  name?: string;
  stack?: string;
  error?: string;
  error_code?: string;
};

export type BrowserPilotBridgeResponseError = string | BrowserPilotBridgeErrorRecord;

export type BrowserPilotBridgeResponse<T = unknown> = {
  ok: boolean;
  data?: T;
  result?: T;
  results?: unknown;
  error?: BrowserPilotBridgeResponseError;
  error_code?: string;
  message?: string;
  details?: JsonRecord;
};


export type BrowserPilotChromeMessageSender = BrowserPilotBridgeSender;
export type BrowserPilotBridgeWebSocketLike = BrowserPilotWebSocketLike;
export type BrowserPilotChromeAlarm = { name?: string };
export type BrowserPilotTabSyncTransport = {
  getSocket: () => BrowserPilotBridgeWebSocketLike | null;
  getSockets?: () => BrowserPilotBridgeWebSocketLike[];
  probe: (resetDelay: boolean) => Promise<void> | void;
};

export type BrowserPilotBridgeWsEnvelope = JsonRecord & {
  id?: string | number | null;
  code?: unknown;
  tabId?: number;
};

export type BrowserPilotBridgeCommand = JsonRecord & {
  cmd?: string;
  method?: string;
  tabId?: number;
  timeoutMs?: number;
  timeout_ms?: number;
  waitId?: string;
  wait_id?: string;
  abortController?: AbortController;
};

export type BrowserPilotBridgeSender = {
  tab?: BrowserPilotChromeTab;
  [key: string]: unknown;
};

export type BrowserPilotNativeProtocolRuntime = {
  schema: JsonRecord;
  aliases?: Record<string, string>;
  nativeCommandMap: Record<string, string>;
  canonicalCommand?: (cmd: unknown) => string;
};

export type BrowserPilotPersistentCdpBridge = {
  send?: (tabId: number, method: string, params?: JsonRecord, options?: JsonRecord) => Promise<BrowserPilotBridgeResponse<JsonRecord>>;
  attachTarget?: (tabId: number, targetId: string, options?: JsonRecord) => Promise<BrowserPilotBridgeResponse<JsonRecord>>;
  detachTarget?: (tabId: number, targetIdOrSessionId: string, options?: JsonRecord) => Promise<BrowserPilotBridgeResponse<JsonRecord>>;
  targets?: (tabId?: number) => Promise<BrowserPilotBridgeResponse<JsonRecord>>;
  frameTree?: (tabId: number, options?: JsonRecord) => Promise<BrowserPilotBridgeResponse<JsonRecord>>;
  evaluateInFrame?: (tabId: number, expression: string, options?: JsonRecord) => Promise<BrowserPilotBridgeResponse<JsonRecord>>;
  addNewDocumentScript?: (tabId: number, source: string, options?: JsonRecord) => Promise<BrowserPilotBridgeResponse<JsonRecord>>;
  removeNewDocumentScript?: (tabId: number, identifier: string, options?: JsonRecord) => Promise<BrowserPilotBridgeResponse<JsonRecord>>;
  releaseIdle?: (maxIdleMs?: unknown) => Promise<BrowserPilotBridgeResponse<JsonRecord>>;
  handleCommand?: (msg: BrowserPilotBridgeCommand, sender: BrowserPilotBridgeSender) => Promise<BrowserPilotBridgeResponse<JsonRecord>>;
  hasSessionForTab?: (tabId: number) => boolean;
};

export type BrowserPilotWaitRecord = JsonRecord & {
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
export type NetworkRequestRecord = {
  url?: string;
  method?: string;
  headers?: NetworkHeaders;
  hasPostData?: boolean;
  postData?: string;
  postDataTruncated?: boolean;
  postDataOriginalLength?: number;
  mixedContentType?: unknown;
  initialPriority?: unknown;
  referrerPolicy?: unknown;
  [key: string]: unknown;
};
export type NetworkResponseRecord = {
  url?: string;
  status?: number;
  statusText?: string;
  headers?: NetworkHeaders;
  mimeType?: string;
  protocol?: string;
  fromServiceWorker?: boolean;
  remoteIPAddress?: string;
  connectionId?: string | number;
  charset?: string;
  connectionReused?: boolean;
  remotePort?: unknown;
  fromDiskCache?: boolean;
  fromPrefetchCache?: boolean;
  encodedDataLength?: unknown;
  securityState?: string;
  securityDetails?: unknown;
  timing?: unknown;
  [key: string]: unknown;
};
export type NetworkBodyStoreEntry = {
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
  status?: number;
  url?: string;
  [key: string]: unknown;
};
export type NetworkDataStats = { encodedDataLength?: number; dataLength?: number; chunks?: number; [key: string]: unknown };
export type NetworkFrameRecord = { payloadData?: string; eventName?: string; eventId?: string; data?: string; method?: string; opcode?: number; t?: number; payloadTruncated?: boolean; dataTruncated?: boolean; originalLength?: number; [key: string]: unknown };
export type NetworkRecord = {
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
  [key: string]: unknown;
};
export type NetworkRecorderCounters = Record<
  | "request" | "requestExtraInfo" | "response" | "responseExtraInfo" | "data" | "finished" | "failed" | "servedFromCache"
  | "webSocket" | "sse" | "page" | "bodyCaptured" | "bodyErrors" | "waitsResolved" | "waitsTimedOut" | "waitsCancelled",
  number
>;
export type NetworkRecorderActiveWaitSummary = {
  waitId: string;
  condition: string;
  age_ms: number;
  criteria: JsonRecord;
  lastMatchSeq: number;
};
export type NetworkRecorderSummary = {
  tabId: number;
  sessionId: string;
  recorderId: string;
  active: boolean;
  createdAt: number;
  startedAt: number;
  stoppedAt: number;
  age_ms: number;
  entries: number;
  requestCount: number;
  bodyCount: number;
  pendingBodyCount: number;
  // Highest network entry seq currently held (or seqBase when empty). The ABML causal plane
  // records this as a baseline high-water mark so a later observe can window seq>lastSeq.
  lastSeq: number;
  maxEntries: number;
  maxAgeMs: number;
  maxBodyBytes: number;
  overflowCount: number;
  bodyOverflowCount: number;
  counters: NetworkRecorderCounters;
  lastErrors: unknown[];
  lifecycleEvents: unknown[];
  activeWaits: NetworkRecorderActiveWaitSummary[];
  activeWaitCount: number;
  cdp: { subscriptions: string[]; domains: string[]; attached: boolean; refs: JsonRecord[] };
  config: unknown;
  diagnostics: unknown[];
  recoveredAt?: number;
  historyLost?: true;
  generation?: number;
};
export type NetworkClearResult = { entries: number; bodies: number };
export type NetworkRecordSummary = {
  id: string;
  requestId: string;
  seq: number;
  tabId: number;
  sessionId: string;
  request: NetworkRequestRecord;
  response?: NetworkResponseRecord | null;
  createdAt: number;
  updatedAt: number;
  wallTime?: number | null;
  timestamp?: number | null;
  fromCache: boolean;
  bodyRef?: string | null;
  bodyPreview?: string | null;
  bodyTruncated?: boolean;
  bodyError?: string | null;
  bodyPending?: boolean;
  bodyAvailability?: string;
  bodyUnavailableReason?: string | null;
  [key: string]: unknown;
};
export type NetworkRecordSnapshot = NetworkRecordSummary;
export type NetworkHarContent = {
  size: number;
  mimeType: string;
  compression: number;
  text?: string;
  encoding?: string;
  _bodyRef?: string;
  _bodyTruncated?: boolean;
  _bodyAvailability?: string;
  _bodyUnavailableReason?: string | null;
};
export type NetworkHarEntry = {
  startedDateTime: string;
  time: number;
  request: JsonRecord;
  response: JsonRecord & { content: NetworkHarContent };
  cache: JsonRecord;
  timings: JsonRecord;
  serverIPAddress?: string;
  connection?: string;
  _requestId: string;
  _seq: number;
  _type: string;
  _initiator: unknown;
  _redirects: unknown[];
  _wsFrames: NetworkFrameRecord[];
  _sseEvents: NetworkFrameRecord[];
  _bodyRef: string | null;
  _bodyError: string | null;
  _bodyAvailability: string;
  _bodyUnavailableReason: string | null;
};
export type NetworkRecorderConfig = {
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
  [key: string]: unknown;
};
export type NetworkRecorderWait = {
  waitId: string;
  condition: string;
  criteria: JsonRecord;
  createdAt: number;
  resolve: (value: BrowserPilotBridgeResponse) => void;
  abortController: AbortController;
  done: boolean;
  idleMs: number;
  count: number;
  lastMatchSeq: number;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  intervalHandle?: ReturnType<typeof setInterval>;
  abortHandler?: () => void;
  [key: string]: unknown;
};
export type NetworkRecorder = {
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
  cdpRecord: BrowserPilotWaitRecord;
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
  [key: string]: unknown;
};
export type NetworkWaitNotifier = (recorder: NetworkRecorder, eventType: string, rec: NetworkRecord | null) => void;

export type BrowserPilotCdpSubscription = {
  subscriptionId: string;
  tabId: number;
  events: string[];
  createdAt: number;
  handler: (...args: unknown[]) => void;
  waitId: string | null;
  kind: string | null;
};

export type BrowserPilotCdpDomainRef = {
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

export type BrowserPilotChromeEvent<TListener extends (...args: never[]) => unknown = (...args: never[]) => unknown> = {
  addListener(listener: TListener): void;
  removeListener(listener: TListener): void;
};

export type BrowserPilotChromeTab = {
  id?: number;
  tabId?: number;
  url?: string;
  title?: string;
  active?: boolean;
  windowId?: number;
  openerTabId?: number;
  incognito?: boolean;
  status?: string;
  pendingUrl?: string;
  favIconUrl?: string;
  [key: string]: unknown;
};

export type BrowserPilotChromeDownloadItem = {
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

export type BrowserPilotWebSocketLike = {
  readyState: number;
  send(data: string): void;
};

export type BrowserPilotChromePort = {
  name?: string;
  onDisconnect?: BrowserPilotChromeEvent<(port?: BrowserPilotChromePort) => void>;
  disconnect?(): void;
};

export type BrowserPilotChromeRuntime = {
  id?: string;
  lastError?: { message?: string };
  getManifest(): { name?: string; version?: string; version_name?: string; [key: string]: unknown };
  getURL(path: string): string;
  reload(): void;
  sendMessage(message: unknown): Promise<unknown>;
  onMessage: BrowserPilotChromeEvent<(message: unknown, sender: BrowserPilotBridgeSender, sendResponse: (response?: unknown) => void) => void | boolean | Promise<unknown>>;
  onConnect?: BrowserPilotChromeEvent<(port: BrowserPilotChromePort) => void>;
  onInstalled: BrowserPilotChromeEvent<() => void>;
  onStartup: BrowserPilotChromeEvent<() => void>;
};

export type BrowserPilotChromeOffscreen = {
  createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void>;
  closeDocument?(): Promise<void>;
  hasDocument?(): Promise<boolean>;
};

export type BrowserPilotChromeTabs = {
  query(queryInfo: JsonRecord): Promise<BrowserPilotChromeTab[]>;
  update(tabId: number, updateProperties: JsonRecord): Promise<BrowserPilotChromeTab>;
  create(createProperties: JsonRecord): Promise<BrowserPilotChromeTab>;
  get(tabId: number): Promise<BrowserPilotChromeTab>;
  remove(tabId: number): Promise<void>;
  captureVisibleTab(windowId?: number, options?: JsonRecord): Promise<string>;
  sendMessage(tabId: number, message: unknown, options?: JsonRecord): Promise<unknown>;
  onCreated: BrowserPilotChromeEvent<(tab: BrowserPilotChromeTab) => void>;
  onUpdated: BrowserPilotChromeEvent<(tabId: number, changeInfo: JsonRecord, tab: BrowserPilotChromeTab) => void>;
  onRemoved: BrowserPilotChromeEvent<(tabId: number, removeInfo?: JsonRecord) => void>;
  onReplaced?: BrowserPilotChromeEvent<(addedTabId: number, removedTabId: number) => void>;
  onActivated?: BrowserPilotChromeEvent<(activeInfo: { tabId: number; windowId: number }) => void>;
};

export type BrowserPilotChromeDebugger = {
  attach(target: { tabId?: number; targetId?: string }, protocolVersion?: string): Promise<void>;
  detach(target: { tabId?: number; targetId?: string; sessionId?: string }): Promise<void>;
  sendCommand(target: { tabId?: number; targetId?: string; sessionId?: string }, method: string, params?: JsonRecord): Promise<unknown>;
  getTargets(): Promise<JsonRecord[]>;
  onDetach: BrowserPilotChromeEvent<(source: { tabId?: number; targetId?: string; sessionId?: string }, reason: string) => void>;
  onEvent: BrowserPilotChromeEvent<(source: { tabId?: number; targetId?: string; sessionId?: string }, method: string, params?: JsonRecord) => void>;
};

export type BrowserPilotChromeDownloads = {
  download(options: JsonRecord, callback: (id?: number) => void): void;
  search(query: JsonRecord, callback: (items: BrowserPilotChromeDownloadItem[]) => void): void;
  onChanged: BrowserPilotChromeEvent<(delta: JsonRecord & { id?: number; state?: { current?: string }; filename?: unknown }) => void>;
  onCreated: BrowserPilotChromeEvent<(item: BrowserPilotChromeDownloadItem) => void>;
};

export type BrowserPilotChromeApi = {
  runtime: BrowserPilotChromeRuntime;
  debugger: BrowserPilotChromeDebugger;
  tabs: BrowserPilotChromeTabs;
  windows: { update(windowId: number, updateInfo: JsonRecord): Promise<unknown>; create(createData: JsonRecord): Promise<{ id?: number; tabs?: BrowserPilotChromeTab[] } | undefined> };
  extension?: { isAllowedIncognitoAccess(callback: (allowed: boolean) => void): void };
  scripting: { executeScript(options: JsonRecord): Promise<unknown[]> };
  downloads: BrowserPilotChromeDownloads;
  offscreen?: BrowserPilotChromeOffscreen;
  alarms: { create(name: string, alarmInfo: JsonRecord): void; clear?(name: string): Promise<boolean> | boolean; onAlarm: BrowserPilotChromeEvent<(alarm: { name: string }) => void | Promise<void>> };
  storage?: {
    session?: { get(keys?: string | string[] | JsonRecord): Promise<JsonRecord>; set(items: JsonRecord): Promise<void>; remove(keys: string | string[]): Promise<void> };
    local?: { get(keys?: string | string[] | JsonRecord): Promise<JsonRecord>; set(items: JsonRecord): Promise<void>; remove(keys: string | string[]): Promise<void> };
  };
  webNavigation: Record<string, BrowserPilotChromeEvent<(details: JsonRecord & { tabId?: number; frameId?: number; url?: string }) => void>>;
};

export type ChromeApi = BrowserPilotChromeApi;
