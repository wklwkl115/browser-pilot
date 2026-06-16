import {
	DEFAULT_BASELINE_CLUSTER_BODY_DELTA,
	baselineClusterKey as kernelBaselineClusterKey,
	matchesStatusBodyResult as kernelMatchesStatusBodyResult,
	nearestBaselineByDistance as kernelNearestBaselineByDistance,
	normalizeBaselineStrategy as kernelNormalizeBaselineStrategy,
	responseChangeDelta as kernelResponseChangeDelta,
	responseDeltaClassifier as kernelResponseDeltaClassifier,
	responseDistance as kernelResponseDistance,
	responseReplayDelta as kernelResponseReplayDelta,
	responsesDiffer as kernelResponsesDiffer,
	sameBaselineCluster as kernelSameBaselineCluster,
} from "../../../kernels/security/replayDiff.js";

export { DEFAULT_BASELINE_CLUSTER_BODY_DELTA };

export type ResponseFingerprint = {
	status: number;
	title?: string;
	bodyBytes: number;
	bodySha256: string;
	location?: string;
};

export type BaselineStrategy = "exact" | "cluster" | "auto";
export type StatusBodyMatchOptions = { matchStatus: number[]; filterStatus: number[]; filterBodyBytes: number[] };
export type ResponseChangeDelta = {
	statusChanged: boolean;
	titleChanged: boolean;
	bodyBytesDelta: number;
	bodyHashChanged: boolean;
	locationChanged: boolean;
};
export type ResponseReplayDelta = ResponseChangeDelta & {
	distance: number;
	classifier: string[];
};

export function normalizeBaselineStrategy(value: unknown): BaselineStrategy {
	return kernelNormalizeBaselineStrategy(value);
}

export function matchesStatusBodyResult(status: number, bodyBytes: number, options: StatusBodyMatchOptions): boolean {
	return kernelMatchesStatusBodyResult(status, bodyBytes, options);
}

export function responseDistance(left: ResponseFingerprint, right: ResponseFingerprint): number {
	return kernelResponseDistance(left, right);
}

export function responsesDiffer(left: ResponseFingerprint, right: ResponseFingerprint): boolean {
	return kernelResponsesDiffer(left, right);
}

export function baselineClusterKey(fingerprint: ResponseFingerprint): string {
	return kernelBaselineClusterKey(fingerprint);
}

export function sameBaselineCluster(left: ResponseFingerprint, right: ResponseFingerprint, bodyDelta = DEFAULT_BASELINE_CLUSTER_BODY_DELTA): boolean {
	return kernelSameBaselineCluster(left, right, bodyDelta);
}

export function responseChangeDelta(left: ResponseFingerprint, right: ResponseFingerprint): ResponseChangeDelta {
	return kernelResponseChangeDelta(left, right);
}

export function responseDeltaClassifier(left: ResponseFingerprint, right: ResponseFingerprint): string[] {
	return kernelResponseDeltaClassifier(left, right);
}

export function responseReplayDelta(left: ResponseFingerprint, right: ResponseFingerprint): ResponseReplayDelta {
	return kernelResponseReplayDelta(left, right);
}

export function nearestBaselineByDistance<TBaseline extends ResponseFingerprint, TFingerprint extends ResponseFingerprint>(
	baselines: TBaseline[],
	fingerprint: TFingerprint,
	distance: (baseline: TBaseline, fingerprint: TFingerprint) => number = responseDistance as (baseline: TBaseline, fingerprint: TFingerprint) => number,
): { baseline: TBaseline; distance: number } | undefined {
	return kernelNearestBaselineByDistance(baselines, fingerprint, distance);
}
