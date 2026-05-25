import { responseDistance } from "./http";
import type { ResponseFingerprint } from "./http";

export const DEFAULT_BASELINE_CLUSTER_BODY_DELTA = 96;

export type BaselineStrategy = "exact" | "cluster" | "auto";
export type StatusBodyMatchOptions = { matchStatus: number[]; filterStatus: number[]; filterBodyBytes: number[] };

export function normalizeBaselineStrategy(value: unknown): BaselineStrategy {
	const normalized = String(value || "auto").trim().toLowerCase();
	if (normalized === "exact" || normalized === "cluster") return normalized;
	return "auto";
}

export function matchesStatusBodyResult(status: number, bodyBytes: number, options: StatusBodyMatchOptions): boolean {
	if (options.matchStatus.length && !options.matchStatus.includes(status)) return false;
	if (options.filterStatus.includes(status)) return false;
	if (options.filterBodyBytes.includes(bodyBytes)) return false;
	return true;
}

export function baselineClusterKey(fingerprint: ResponseFingerprint): string {
	return `${fingerprint.status}|${fingerprint.title || ""}|${fingerprint.location || ""}`;
}

export function sameBaselineCluster(left: ResponseFingerprint, right: ResponseFingerprint, bodyDelta = DEFAULT_BASELINE_CLUSTER_BODY_DELTA): boolean {
	return left.status === right.status && left.title === right.title && left.location === right.location && Math.abs(left.bodyBytes - right.bodyBytes) <= bodyDelta;
}

export function responseChangeDelta(left: ResponseFingerprint, right: ResponseFingerprint) {
	return {
		statusChanged: right.status !== left.status,
		titleChanged: right.title !== left.title,
		bodyBytesDelta: right.bodyBytes - left.bodyBytes,
		bodyHashChanged: right.bodySha256 !== left.bodySha256,
		locationChanged: right.location !== left.location,
	};
}

export function responseDeltaClassifier(left: ResponseFingerprint, right: ResponseFingerprint): string[] {
	return [
		right.status !== left.status ? "status" : "",
		right.title !== left.title ? "title" : "",
		right.bodyBytes !== left.bodyBytes ? "length" : "",
		right.bodySha256 !== left.bodySha256 ? "body-hash" : "",
		right.location !== left.location ? "location" : "",
	].filter(Boolean);
}

export function responseReplayDelta(left: ResponseFingerprint, right: ResponseFingerprint) {
	return {
		...responseChangeDelta(left, right),
		distance: responseDistance(left, right),
		classifier: responseDeltaClassifier(left, right),
	};
}

export function nearestBaselineByDistance<TBaseline extends ResponseFingerprint, TFingerprint extends ResponseFingerprint>(baselines: TBaseline[], fingerprint: TFingerprint, distance: (baseline: TBaseline, fingerprint: TFingerprint) => number = responseDistance as (baseline: TBaseline, fingerprint: TFingerprint) => number): { baseline: TBaseline; distance: number } | undefined {
	return baselines.length ? baselines.map((baseline) => ({ baseline, distance: distance(baseline, fingerprint) })).sort((a, b) => a.distance - b.distance)[0] : undefined;
}
