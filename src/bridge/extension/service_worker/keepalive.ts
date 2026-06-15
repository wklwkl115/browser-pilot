import { chromeApi as chrome } from "./runtimeEnv";
import type { BrowserPilotChromePort } from "./types";

const KEEPALIVE_PORT_NAME = "browser-pilot-keepalive";

let keepalivePortConnected = false;
let keepalivePortDisconnects = 0;
let keepaliveInstalled = false;

function installBrowserPilotKeepalivePort(): boolean {
  if (keepaliveInstalled) return false;
  chrome.runtime.onConnect?.addListener((port: BrowserPilotChromePort) => {
    if (port.name !== KEEPALIVE_PORT_NAME) return;
    keepalivePortConnected = true;
    port.onDisconnect?.addListener(() => {
      keepalivePortConnected = false;
      keepalivePortDisconnects += 1;
    });
  });
  keepaliveInstalled = true;
  return true;
}

export { installBrowserPilotKeepalivePort, keepalivePortConnected, keepalivePortDisconnects };
export const __browserPilotBridgeModule_keepalive = { name: "keepalive", symbols: { installBrowserPilotKeepalivePort, keepalivePortConnected, keepalivePortDisconnects } };
