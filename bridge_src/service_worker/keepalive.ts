import { chromeApi as chrome } from "./runtimeEnv";
import type { PiChromePort } from "./types";

const KEEPALIVE_PORT_NAME = "pi-keepalive";

let keepalivePortConnected = false;
let keepalivePortDisconnects = 0;
let keepaliveInstalled = false;

function installPiBrowserKeepalivePort(): boolean {
  if (keepaliveInstalled) return false;
  chrome.runtime.onConnect?.addListener((port: PiChromePort) => {
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

export { installPiBrowserKeepalivePort, keepalivePortConnected, keepalivePortDisconnects };
export const __piBridgeModule_keepalive = { name: "keepalive", symbols: { installPiBrowserKeepalivePort, keepalivePortConnected, keepalivePortDisconnects } };
