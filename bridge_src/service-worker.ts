import "./service_worker/config";
import "./service_worker/protocol";
import "./service_worker/patterns";
import "./service_worker/cdp";
import "./service_worker/runtime";
import "./service_worker/wait_cdp";
import "./service_worker/wait_coordinator";
import "./service_worker/wait_navigation";
import "./service_worker/wait_network_idle";
import "./service_worker/wait_selector";
import "./service_worker/wait";
import "./service_worker/network_model";
import "./service_worker/network";
import "./service_worker/hook";
import "./service_worker/evidence";
import "./service_worker/frame";
import "./service_worker/html";
import "./service_worker/screenshot";
import "./service_worker/transfer";
import "./service_worker/bridge_info";
import "./service_worker/core_commands";
import "./service_worker/exec";
import "./service_worker/router";
import "./service_worker/tab_sync";
import "./service_worker/transport";
import { BRIDGE_BUILD_PIPELINE_VERSION, type BridgeBuildInfo } from "./shared/buildInfo";

const buildInfo: BridgeBuildInfo = {
	version: BRIDGE_BUILD_PIPELINE_VERSION,
	mode: "experimental",
	runtimeSwitched: false,
};

Object.defineProperty(globalThis, "__PI_BROWSER_EXPERIMENTAL_BUILD__", {
	value: Object.freeze(buildInfo),
	configurable: false,
	enumerable: false,
	writable: false,
});

export { buildInfo };
