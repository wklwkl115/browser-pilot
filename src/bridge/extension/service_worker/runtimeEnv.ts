import type { ChromeApi } from "./types";

export const serviceWorkerGlobal = globalThis as typeof globalThis & {
  chrome?: ChromeApi;
  BrowserPilotPersistentCdp?: unknown;
  browserPilotPersistentCdpBridge?: unknown;
  __BROWSER_PILOT_WORKER_STARTED_AT__?: number;
  __BROWSER_PILOT_WORKER_BOOT_ID__?: string;
};

export const chromeApi = serviceWorkerGlobal.chrome as ChromeApi;

export const BROWSER_PILOT_WORKER_STARTED_AT = serviceWorkerGlobal.__BROWSER_PILOT_WORKER_STARTED_AT__
  ?? Date.now();

export const BROWSER_PILOT_WORKER_BOOT_ID = serviceWorkerGlobal.__BROWSER_PILOT_WORKER_BOOT_ID__
  ?? [
    chromeApi?.runtime?.id || "browser-pilot-bridge",
    BROWSER_PILOT_WORKER_STARTED_AT,
    Math.random().toString(36).slice(2, 10),
  ].join(":");

serviceWorkerGlobal.__BROWSER_PILOT_WORKER_STARTED_AT__ = BROWSER_PILOT_WORKER_STARTED_AT;
serviceWorkerGlobal.__BROWSER_PILOT_WORKER_BOOT_ID__ = BROWSER_PILOT_WORKER_BOOT_ID;
