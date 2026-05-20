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
