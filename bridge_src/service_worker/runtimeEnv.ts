import type { ChromeApi } from "./types";

export const serviceWorkerGlobal = globalThis as typeof globalThis & {
  chrome?: ChromeApi;
  PiNativeProtocol?: unknown;
  PiPersistentCdp?: unknown;
  piPersistentCdpBridge?: unknown;
  __PI_BROWSER_WORKER_STARTED_AT__?: number;
  __PI_BROWSER_WORKER_BOOT_ID__?: string;
};

export const chromeApi = serviceWorkerGlobal.chrome as ChromeApi;

export const PI_BROWSER_WORKER_STARTED_AT = serviceWorkerGlobal.__PI_BROWSER_WORKER_STARTED_AT__
  ?? Date.now();

export const PI_BROWSER_WORKER_BOOT_ID = serviceWorkerGlobal.__PI_BROWSER_WORKER_BOOT_ID__
  ?? [
    chromeApi?.runtime?.id || "pi-browser-bridge",
    PI_BROWSER_WORKER_STARTED_AT,
    Math.random().toString(36).slice(2, 10),
  ].join(":");

serviceWorkerGlobal.__PI_BROWSER_WORKER_STARTED_AT__ = PI_BROWSER_WORKER_STARTED_AT;
serviceWorkerGlobal.__PI_BROWSER_WORKER_BOOT_ID__ = PI_BROWSER_WORKER_BOOT_ID;
