import path from "node:path";
import { classifyDeadlinePressure } from "../../kernels/temporal/budget.js";
import { estimatePageFreshness, estimateTargetContinuity, estimateWaitContinuity } from "../../kernels/temporal/estimate.js";
import { compactTemporalDecision, type CompactTemporalDecision, type TemporalAnchor, type TemporalReason, type TemporalStamp } from "../../kernels/temporal/types.js";
import type { BrowserBridgeSnapshot, BrowserBridgeTargetInfo, BrowserObservationSnapshotInfo } from "./types.js";
import type { CommandTemporalProfileSample, CommandTemporalProfileSampleInput } from "../../ports/BrowserCommandRuntimePort.js";
import { normalizeTemporalProfileRunId, writeTemporalProfileArtifacts, summarizeTemporalProfileSamples, type TemporalProfileArtifactPaths, type TemporalProfileSummary } from "./temporalProfileArtifacts.js";
import { isRecord } from "../../utils/records.js";

export type QueueTemporalProfileInput = {
	queueDepthAtEnqueue?: number;
	queueDepthAtStart?: number;
	queueDelayMs?: number;
	deadlineMs?: number;
};

export type BrowserTemporalCoordinatorOptions = {
	runtimeSampleCap?: number;
};

type RuntimeProfileBucket = {
	cwd: string;
	runId: string;
	samples: CommandTemporalProfileSample[];
	artifactTail: Promise<TemporalProfileArtifactPaths | undefined>;
};

const DEFAULT_RUNTIME_TEMPORAL_PROFILE_SAMPLE_CAP = 256;

function reasons(value: unknown): TemporalReason[] | undefined {
	return Array.isArray(value) ? value.filter((item): item is TemporalReason => typeof item === "string").slice(0, 3) : undefined;
}

function supervisorFromData(data: unknown): Record<string, unknown> | undefined {
	const record = isRecord(data) ? data : undefined;
	const direct = isRecord(record?.supervisor) ? record.supervisor : undefined;
	if (direct) return direct;
	const wait = isRecord(record?.wait) ? record.wait : undefined;
	return isRecord(wait?.supervisor) ? wait.supervisor : undefined;
}

function diagnosticsFrom(input: CommandTemporalProfileSampleInput): Record<string, unknown> | undefined {
	return input.diagnostics || (isRecord(input.result?.diagnostics) ? input.result.diagnostics : undefined);
}

function temporalProfileFromDiagnostics(diagnostics: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	return isRecord(diagnostics?.temporalProfile) ? diagnostics.temporalProfile : undefined;
}

function temporalFromDiagnostics(diagnostics: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	return isRecord(diagnostics?.temporal) ? diagnostics.temporal : undefined;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
	for (const value of values) if (isRecord(value)) return value;
	return undefined;
}

function numeric(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function firstNormalized<T>(normalize: (value: unknown) => T | undefined, ...values: unknown[]): T | undefined {
	for (const value of values) {
		const normalized = normalize(value);
		if (normalized !== undefined) return normalized;
	}
	return undefined;
}

function boundedStrings(value: unknown, limit: number): string[] | undefined {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, limit) : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function profileTarget(input: CommandTemporalProfileSampleInput): CommandTemporalProfileSample["target"] {
	const resultTarget = input.result?.target;
	const target = input.target ?? (resultTarget ? {
		...(resultTarget.browserSessionId ? { browserSessionId: resultTarget.browserSessionId } : {}),
		...(resultTarget.tabId !== undefined ? { tabId: resultTarget.tabId } : {}),
		...(resultTarget.targetRef ? { targetRef: resultTarget.targetRef } : {}),
	} : undefined);
	return target;
}

function setSampleValue<K extends keyof CommandTemporalProfileSample>(sample: CommandTemporalProfileSample, key: K, value: CommandTemporalProfileSample[K] | undefined): void {
	if (value !== undefined) Object.assign(sample, { [key]: value });
}

function sampleCap(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return DEFAULT_RUNTIME_TEMPORAL_PROFILE_SAMPLE_CAP;
	return value;
}

function runtimeCwd(cwd: string | undefined): string {
	return path.resolve(cwd || process.cwd());
}

function bucketKey(cwd: string, runId: string): string {
	return `${cwd}\u0000${runId}`;
}

export function queueTemporalDiagnostics(input: QueueTemporalProfileInput): { temporal?: CompactTemporalDecision; temporalProfile: Record<string, unknown> } {
	const temporalProfile = {
		...(input.queueDepthAtEnqueue !== undefined ? { queueDepthAtEnqueue: input.queueDepthAtEnqueue } : {}),
		...(input.queueDepthAtStart !== undefined ? { queueDepthAtStart: input.queueDepthAtStart } : {}),
		...(input.queueDelayMs !== undefined ? { queueDelayMs: input.queueDelayMs } : {}),
		...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
	};
	const deadlineMs = input.deadlineMs ?? 0;
	const pressure = classifyDeadlinePressure({
		remainingMs: deadlineMs,
		requiredMs: 0,
		queueDelayMs: input.queueDelayMs,
		queueDepthAtEnqueue: input.queueDepthAtEnqueue,
	});
	return {
		temporal: pressure.verdict.status === "fresh" ? undefined : compactTemporalDecision(pressure),
		temporalProfile,
	};
}

export class BrowserTemporalCoordinator {
	private readonly runtimeSampleCap: number;
	private readonly runtimeBuckets = new Map<string, RuntimeProfileBucket>();

	constructor(options: BrowserTemporalCoordinatorOptions = {}) {
		this.runtimeSampleCap = sampleCap(options.runtimeSampleCap);
	}

	anchorFromObservationSnapshot(snapshot: BrowserObservationSnapshotInfo): TemporalAnchor {
		return {
			version: "temporal-anchor/v1",
			source: "observe",
			snapshotId: snapshot.snapshotId,
			observationId: snapshot.snapshotId,
			stamp: {
				version: "temporal-stamp/v1",
				browserSessionId: snapshot.browserSessionId,
				tabId: snapshot.tabId,
				selectionVersion: snapshot.selectionVersion,
				url: snapshot.url,
				networkSeq: snapshot.networkSeq,
				hookSeq: snapshot.hookSeq,
				capturedAtMs: snapshot.capturedAt,
				clockDomain: "driver_wall",
			},
		};
	}

	stampFromSnapshot(snapshot: BrowserBridgeSnapshot, capturedAtMs: number): TemporalStamp {
		return {
			version: "temporal-stamp/v1",
			browserSessionId: snapshot.browserSessionId,
			tabId: snapshot.defaultTabId,
			tabHandle: snapshot.defaultTabHandle,
			browserId: snapshot.extension?.id,
			selectionVersion: snapshot.selectionVersion,
			workerBootId: snapshot.extension?.workerBootId,
			capturedAtMs,
			clockDomain: "driver_wall",
		};
	}

	stampFromTarget(target: BrowserBridgeTargetInfo | undefined, snapshot: BrowserBridgeSnapshot, capturedAtMs: number): TemporalStamp {
		return {
			...this.stampFromSnapshot(snapshot, capturedAtMs),
			browserSessionId: target?.browserSessionId ?? snapshot.browserSessionId,
			tabId: target?.tabId ?? snapshot.defaultTabId,
			tabHandle: target?.tabHandle ?? snapshot.defaultTabHandle,
			targetRef: target?.targetRef,
			browserId: target?.browserId ?? snapshot.extension?.id,
			url: target?.url,
			selectionVersion: target?.selectionVersionAtResolve ?? target?.selectionVersionAtDispatch ?? snapshot.selectionVersion,
		};
	}

	estimateTargetContinuity(anchor: TemporalAnchor | undefined, current: TemporalStamp | undefined, input: { targetRegionDirty?: boolean; stableLocator?: boolean; cssOnlyLocator?: boolean } = {}): CompactTemporalDecision {
		return compactTemporalDecision(estimateTargetContinuity({ anchor, current, ...input }));
	}

	estimatePageFreshness(anchor: TemporalAnchor | undefined, current: TemporalStamp | undefined, input: { targetRegionDirty?: boolean; stableLocator?: boolean; maxSameDomainAgeMs?: number } = {}): CompactTemporalDecision {
		return compactTemporalDecision(estimatePageFreshness({ anchor, current, ...input }));
	}

	estimateWaitContinuity(input: { previousWorkerBootId?: string; currentWorkerBootId?: string; historyLost?: boolean; workerRestarts?: number }): CompactTemporalDecision {
		return compactTemporalDecision(estimateWaitContinuity(input));
	}

	buildProfileSample(input: CommandTemporalProfileSampleInput): CommandTemporalProfileSample {
		const diagnostics = diagnosticsFrom(input);
		const temporalProfile = temporalProfileFromDiagnostics(diagnostics) ?? {};
		const supervisor = supervisorFromData(input.result?.data) ?? {};
		const diagnosticsTemporal = temporalFromDiagnostics(diagnostics);
		const temporal = firstRecord(diagnosticsTemporal, supervisor.temporal);
		const temporalRecord = temporal ?? {};
		const verdict = isRecord(temporalRecord.verdict) ? temporalRecord.verdict : {};
		const frontier = isRecord(temporalRecord.frontier) ? temporalRecord.frontier : {};
		const sample: CommandTemporalProfileSample = {
			tool: input.tool,
			command: input.command ?? stringValue(temporalProfile.command),
			elapsedMs: input.elapsedMs,
		};
		if (input.operationId) sample.operationId = input.operationId;
		setSampleValue(sample, "target", profileTarget(input));
		setSampleValue(sample, "deadlineMs", input.deadlineMs ?? numeric(temporalProfile.deadlineMs));
		setSampleValue(sample, "bridgeRoundTrips", numeric(temporalProfile.bridgeRoundTrips));
		setSampleValue(sample, "queueDepthAtEnqueue", numeric(temporalProfile.queueDepthAtEnqueue));
		setSampleValue(sample, "queueDepthAtStart", numeric(temporalProfile.queueDepthAtStart));
		setSampleValue(sample, "queueDelayMs", numeric(temporalProfile.queueDelayMs));
		setSampleValue(sample, "waitAttempts", firstNormalized(numeric, supervisor.attempts, temporalProfile.waitAttempts));
		setSampleValue(sample, "workerRestarts", firstNormalized(numeric, supervisor.workerRestarts, temporalProfile.workerRestarts));
		setSampleValue(sample, "historyLost", firstNormalized(bool, supervisor.historyLost, temporalProfile.historyLost));
		setSampleValue(sample, "rawSignals", boundedStrings(temporalProfile.rawSignals, 8));
		setSampleValue(sample, "verdict", stringValue(verdict.status) as CommandTemporalProfileSample["verdict"]);
		setSampleValue(sample, "reasons", reasons(verdict.reasons));
		setSampleValue(sample, "recovery", stringValue(frontier.next) as CommandTemporalProfileSample["recovery"]);
		return sample;
	}

	recordProfileSample(sample: CommandTemporalProfileSample, options: { cwd?: string; runId?: string; evalRunDir?: string; runnerSummaryPath?: string } = {}): Promise<TemporalProfileArtifactPaths | undefined> {
		const bucket = this.runtimeBucket(options);
		bucket.samples.push(sample);
		if (bucket.samples.length > this.runtimeSampleCap) bucket.samples.splice(0, bucket.samples.length - this.runtimeSampleCap);
		const samples = bucket.samples.slice();
		bucket.artifactTail = bucket.artifactTail
			.then(() => writeTemporalProfileArtifacts({ cwd: bucket.cwd, runId: bucket.runId, samples, evalRunDir: options.evalRunDir, runnerSummaryPath: options.runnerSummaryPath }))
			.catch(() => undefined);
		return bucket.artifactTail;
	}

	profileSummary(input: string | { cwd?: string; runId?: string } = "runtime"): TemporalProfileSummary {
		const options = typeof input === "string" ? { runId: input } : input;
		const bucket = this.runtimeBucket(options);
		return summarizeTemporalProfileSamples(bucket.samples, { cwd: bucket.cwd, runId: bucket.runId });
	}

	private runtimeBucket(options: { cwd?: string; runId?: string }): RuntimeProfileBucket {
		const cwd = runtimeCwd(options.cwd);
		const runId = normalizeTemporalProfileRunId(options.runId ?? "runtime");
		const key = bucketKey(cwd, runId);
		const existing = this.runtimeBuckets.get(key);
		if (existing) return existing;
		const bucket: RuntimeProfileBucket = {
			cwd,
			runId,
			samples: [],
			artifactTail: Promise.resolve(undefined),
		};
		this.runtimeBuckets.set(key, bucket);
		return bucket;
	}
}
