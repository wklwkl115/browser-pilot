type PiBridgeDict = Record<string, any>;

type PiBridgeResponse = {
  ok?: boolean;
  data?: any;
  result?: any;
  results?: any;
  error?: any;
  error_code?: string;
  details?: PiBridgeDict;
  [key: string]: any;
};

type PiBridgeCommand = {
  cmd: string;
  tabId?: number | string;
  timeoutMs?: number;
  timeout_ms?: number;
  timeout?: number;
  method?: string;
  [key: string]: any;
};

type PiBridgeTab = {
  id?: number;
  tabId?: number;
  url?: string;
  title?: string;
  active?: boolean;
  status?: string;
  windowId?: number;
  [key: string]: any;
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
  timers?: any[];
  cdpDomains?: Set<string>;
  cdpSubscriptions?: string[];
  cdpEvents?: any[];
  diagnostics?: any[];
  lastError?: any;
  abortController?: AbortController;
  [key: string]: any;
};

type PiBridgeWebSocketLike = {
  readyState: number;
  send(data: string): void;
  close?(): void;
  onopen?: ((...args: any[]) => void) | null;
  onclose?: ((...args: any[]) => void) | null;
  onerror?: ((event: any) => void) | null;
  onmessage?: ((event: { data: any }) => void | Promise<void>) | null;
  [key: string]: any;
};

type PiNativeProtocolGlobal = {
  schema?: PiBridgeDict;
  aliases?: PiBridgeDict;
  nativeCommandMap?: PiBridgeDict;
  validateCommand?: (msg: any, options?: any) => { ok: boolean; command?: PiBridgeCommand; error?: string; details?: PiBridgeDict };
  canonicalCommand?: (cmd: string) => string;
};

declare const chrome: any;
declare function importScripts(...urls: string[]): void;

interface Window {
  PiNativeProtocol?: PiNativeProtocolGlobal;
  PiPersistentCdp?: any;
  piPersistentCdpBridge?: any;
  __piBrowserUnhandledRejectionCleanupInstalled?: boolean;
  __PI_BROWSER_HOOKS__?: any;
}
