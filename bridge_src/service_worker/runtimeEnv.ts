import type { ChromeApi } from "./types";

export const serviceWorkerGlobal = globalThis as typeof globalThis & {
  chrome?: ChromeApi;
  PiNativeProtocol?: unknown;
  PiPersistentCdp?: unknown;
  piPersistentCdpBridge?: unknown;
};

export const chromeApi = serviceWorkerGlobal.chrome as ChromeApi;
