export type PiBridgeErrorPayload = {
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
};

export type PiBridgeResponse<T = unknown> = {
  ok: boolean;
  data?: T;
  result?: T;
  error?: PiBridgeErrorPayload | string | unknown;
  error_code?: string;
  message?: string;
  details?: Record<string, unknown>;
};

export type PiBridgeCommand = Record<string, unknown> & {
  cmd?: string;
  tabId?: number;
  timeoutMs?: number;
  timeout_ms?: number;
  waitId?: string;
  wait_id?: string;
  abortController?: AbortController;
};

export type PiNativeProtocolRuntime = {
  schema: Record<string, unknown>;
  aliases?: Record<string, string>;
  nativeCommandMap: Record<string, string>;
  canonicalCommand?: (cmd: unknown) => string;
};

export type PiPersistentCdpBridge = {
  send?: (tabId: number, method: string, params?: Record<string, unknown>, options?: Record<string, unknown>) => Promise<PiBridgeResponse<Record<string, unknown>>>;
  hasSessionForTab?: (tabId: number) => boolean;
};

export type PiBrowserWaitRecord = Record<string, unknown> & {
  key: string;
  waitId: string;
  wait_id: string;
  requestId: string;
  request_id: string;
  tabId: number;
  kind: string;
  criteria: Record<string, unknown>;
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
  mode: string;
  createdAt: number;
  enabledAt: number;
  lastError: string | null;
  disablePending?: boolean;
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

export type ChromeApi = Record<string, unknown> & {
  debugger?: Record<string, unknown>;
  tabs?: Record<string, unknown>;
  webNavigation?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
};
