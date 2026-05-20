export const BRIDGE_BUILD_PIPELINE_VERSION = "bridge-build-skeleton-v1";

export type BridgeBuildRuntimeMode = "experimental" | "production";

export type BridgeBuildInfo = {
	version: string;
	mode: BridgeBuildRuntimeMode;
	runtimeSwitched: boolean;
};
