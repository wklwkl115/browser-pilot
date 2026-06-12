export const BRIDGE_BUILD_PIPELINE_VERSION = "bridge-build-dist-v1";
export const BRIDGE_BUILD_ID = "__PI_BROWSER_BRIDGE_BUILD_ID_PLACEHOLDER__";

export type BridgeBuildRuntimeMode = "experimental" | "production";

export type BridgeBuildInfo = {
	version: string;
	buildId: string;
	mode: BridgeBuildRuntimeMode;
	runtimeSwitched: boolean;
};
