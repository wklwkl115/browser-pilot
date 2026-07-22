import { installBrowserPilotBridgeRouter } from "./service_worker/router";
import { installBrowserPilotTransport } from "./service_worker/transport";
import { BRIDGE_BUILD_ID, BRIDGE_BUILD_PIPELINE_VERSION, type BridgeBuildInfo } from "./shared/buildInfo";

function installBrowserPilotServiceWorker() {
	installBrowserPilotBridgeRouter();
	installBrowserPilotTransport();
}

installBrowserPilotServiceWorker();

const buildInfo: BridgeBuildInfo = {
	version: BRIDGE_BUILD_PIPELINE_VERSION,
	buildId: BRIDGE_BUILD_ID,
	mode: "production",
	runtimeSwitched: true,
};

Object.defineProperty(globalThis, "__BROWSER_PILOT_EXPERIMENTAL_BUILD__", {
	value: Object.freeze(buildInfo),
	configurable: false,
	enumerable: false,
	writable: false,
});

export { buildInfo, installBrowserPilotServiceWorker };
