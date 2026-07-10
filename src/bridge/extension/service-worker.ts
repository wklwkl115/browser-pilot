import { __browserPilotBridgeModule_config } from "./service_worker/config";
import { __browserPilotBridgeModule_protocol } from "./service_worker/protocol";
import { __browserPilotBridgeModule_patterns } from "./service_worker/patterns";
import { __browserPilotBridgeModule_cdp } from "./service_worker/cdp";
import { __browserPilotBridgeModule_state_store } from "./service_worker/state_store";
import { __browserPilotBridgeModule_runtimeSupport } from "./service_worker/runtimeSupport.js";
import { __browserPilotBridgeModule_runtime } from "./service_worker/runtime";
import { __browserPilotBridgeModule_wait_cdp } from "./service_worker/wait_cdp";
import { __browserPilotBridgeModule_wait_coordinator } from "./service_worker/wait_coordinator";
import { __browserPilotBridgeModule_wait_navigation } from "./service_worker/wait_navigation";
import { __browserPilotBridgeModule_wait_network_idle } from "./service_worker/wait_network_idle";
import { __browserPilotBridgeModule_wait_selector } from "./service_worker/wait_selector";
import { __browserPilotBridgeModule_wait } from "./service_worker/wait";
import { __browserPilotBridgeModule_network_model } from "./service_worker/network_model";
import { __browserPilotBridgeModule_network_events } from "./service_worker/network_events";
import { __browserPilotBridgeModule_network } from "./service_worker/network";
import { __browserPilotBridgeModule_intercept } from "./service_worker/intercept";
import { __browserPilotBridgeModule_hook } from "./service_worker/hook";
import { __browserPilotBridgeModule_evidence } from "./service_worker/evidence";
import { __browserPilotBridgeModule_frame } from "./service_worker/frame";
import { __browserPilotBridgeModule_layer } from "./service_worker/layer";
import { __browserPilotBridgeModule_html } from "./service_worker/html";
import { __browserPilotBridgeModule_screenshot } from "./service_worker/screenshot";
import { __browserPilotBridgeModule_transfer } from "./service_worker/transfer";
import { __browserPilotBridgeModule_bridge_info } from "./service_worker/bridge_info";
import { __browserPilotBridgeModule_core_commands } from "./service_worker/core_commands";
import { __browserPilotBridgeModule_exec } from "./service_worker/exec";
import { __browserPilotBridgeModule_input } from "./service_worker/input";
import { __browserPilotBridgeModule_ws_model } from "./service_worker/ws_model";
import { __browserPilotBridgeModule_ws } from "./service_worker/ws";
import { __browserPilotBridgeModule_router, installBrowserPilotBridgeRouter } from "./service_worker/router";
import { __browserPilotBridgeModule_tab_sync } from "./service_worker/tab_sync";
import { __browserPilotBridgeModule_keepalive, installBrowserPilotKeepalivePort } from "./service_worker/keepalive";
import { __browserPilotBridgeModule_transport, installBrowserPilotTransport } from "./service_worker/transport";
import { BRIDGE_BUILD_ID, BRIDGE_BUILD_PIPELINE_VERSION, type BridgeBuildInfo } from "./shared/buildInfo";

export const serviceWorkerFoundationModuleGraph = [
	__browserPilotBridgeModule_config,
	__browserPilotBridgeModule_protocol,
	__browserPilotBridgeModule_patterns,
	__browserPilotBridgeModule_cdp,
	__browserPilotBridgeModule_state_store,
	__browserPilotBridgeModule_runtimeSupport,
	__browserPilotBridgeModule_runtime,
	__browserPilotBridgeModule_wait_cdp,
	__browserPilotBridgeModule_wait_coordinator,
	__browserPilotBridgeModule_wait_navigation,
	__browserPilotBridgeModule_wait_network_idle,
	__browserPilotBridgeModule_wait_selector,
	__browserPilotBridgeModule_wait,
] as const;

export const serviceWorkerCommandModuleGraph = [
	__browserPilotBridgeModule_network_model,
	__browserPilotBridgeModule_network_events,
	__browserPilotBridgeModule_network,
	__browserPilotBridgeModule_intercept,
	__browserPilotBridgeModule_hook,
	__browserPilotBridgeModule_evidence,
	__browserPilotBridgeModule_frame,
	__browserPilotBridgeModule_layer,
	__browserPilotBridgeModule_html,
	__browserPilotBridgeModule_screenshot,
	__browserPilotBridgeModule_transfer,
	__browserPilotBridgeModule_bridge_info,
	__browserPilotBridgeModule_core_commands,
	__browserPilotBridgeModule_exec,
	__browserPilotBridgeModule_input,
	__browserPilotBridgeModule_ws_model,
	__browserPilotBridgeModule_ws,
] as const;

export const serviceWorkerStartupModuleGraph = [
	__browserPilotBridgeModule_router,
	__browserPilotBridgeModule_tab_sync,
	__browserPilotBridgeModule_keepalive,
	__browserPilotBridgeModule_transport,
] as const;

function installBrowserPilotServiceWorker() {
	installBrowserPilotKeepalivePort();
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
