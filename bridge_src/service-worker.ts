import { __piBridgeModule_config } from "./service_worker/config";
import { __piBridgeModule_protocol } from "./service_worker/protocol";
import { __piBridgeModule_patterns } from "./service_worker/patterns";
import { __piBridgeModule_cdp } from "./service_worker/cdp";
import { __piBridgeModule_state_store } from "./service_worker/state_store";
import { __piBridgeModule_runtime } from "./service_worker/runtime";
import { __piBridgeModule_wait_cdp } from "./service_worker/wait_cdp";
import { __piBridgeModule_wait_coordinator } from "./service_worker/wait_coordinator";
import { __piBridgeModule_wait_navigation } from "./service_worker/wait_navigation";
import { __piBridgeModule_wait_network_idle } from "./service_worker/wait_network_idle";
import { __piBridgeModule_wait_selector } from "./service_worker/wait_selector";
import { __piBridgeModule_wait } from "./service_worker/wait";
import { __piBridgeModule_network_model } from "./service_worker/network_model";
import { __piBridgeModule_network_events } from "./service_worker/network_events";
import { __piBridgeModule_network } from "./service_worker/network";
import { __piBridgeModule_intercept } from "./service_worker/intercept";
import { __piBridgeModule_hook } from "./service_worker/hook";
import { __piBridgeModule_evidence } from "./service_worker/evidence";
import { __piBridgeModule_frame } from "./service_worker/frame";
import { __piBridgeModule_html } from "./service_worker/html";
import { __piBridgeModule_screenshot } from "./service_worker/screenshot";
import { __piBridgeModule_transfer } from "./service_worker/transfer";
import { __piBridgeModule_bridge_info } from "./service_worker/bridge_info";
import { __piBridgeModule_core_commands } from "./service_worker/core_commands";
import { __piBridgeModule_exec } from "./service_worker/exec";
import { __piBridgeModule_input } from "./service_worker/input";
import { __piBridgeModule_ws_model } from "./service_worker/ws_model";
import { __piBridgeModule_ws } from "./service_worker/ws";
import { __piBridgeModule_router, installPiBridgeRouter } from "./service_worker/router";
import { __piBridgeModule_tab_sync } from "./service_worker/tab_sync";
import { __piBridgeModule_keepalive, installPiBrowserKeepalivePort } from "./service_worker/keepalive";
import { __piBridgeModule_transport, installPiBrowserTransport } from "./service_worker/transport";
import { BRIDGE_BUILD_PIPELINE_VERSION, type BridgeBuildInfo } from "./shared/buildInfo";

export const serviceWorkerFoundationModuleGraph = [
	__piBridgeModule_config,
	__piBridgeModule_protocol,
	__piBridgeModule_patterns,
	__piBridgeModule_cdp,
	__piBridgeModule_state_store,
	__piBridgeModule_runtime,
	__piBridgeModule_wait_cdp,
	__piBridgeModule_wait_coordinator,
	__piBridgeModule_wait_navigation,
	__piBridgeModule_wait_network_idle,
	__piBridgeModule_wait_selector,
	__piBridgeModule_wait,
] as const;

export const serviceWorkerCommandModuleGraph = [
	__piBridgeModule_network_model,
	__piBridgeModule_network_events,
	__piBridgeModule_network,
	__piBridgeModule_intercept,
	__piBridgeModule_hook,
	__piBridgeModule_evidence,
	__piBridgeModule_frame,
	__piBridgeModule_html,
	__piBridgeModule_screenshot,
	__piBridgeModule_transfer,
	__piBridgeModule_bridge_info,
	__piBridgeModule_core_commands,
	__piBridgeModule_exec,
	__piBridgeModule_input,
	__piBridgeModule_ws_model,
	__piBridgeModule_ws,
] as const;

export const serviceWorkerStartupModuleGraph = [
	__piBridgeModule_router,
	__piBridgeModule_tab_sync,
	__piBridgeModule_keepalive,
	__piBridgeModule_transport,
] as const;

export const serviceWorkerModuleGraph = [
	...serviceWorkerFoundationModuleGraph,
	...serviceWorkerCommandModuleGraph,
	...serviceWorkerStartupModuleGraph,
] as const;

function installPiBrowserServiceWorker() {
	installPiBrowserKeepalivePort();
	installPiBridgeRouter();
	installPiBrowserTransport();
}

installPiBrowserServiceWorker();

const buildInfo: BridgeBuildInfo = {
	version: BRIDGE_BUILD_PIPELINE_VERSION,
	mode: "production",
	runtimeSwitched: true,
};

Object.defineProperty(globalThis, "__PI_BROWSER_EXPERIMENTAL_BUILD__", {
	value: Object.freeze(buildInfo),
	configurable: false,
	enumerable: false,
	writable: false,
});

export { buildInfo, installPiBrowserServiceWorker };
