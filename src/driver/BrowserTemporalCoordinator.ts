import { classifyDeadlinePressure } from "../temporal-core/budget.js";
import { estimatePageFreshness, estimateTargetContinuity, estimateWaitContinuity } from "../temporal-core/estimate.js";
import type { TemporalAnchor, TemporalDecision, TemporalFrontierNext, TemporalProfileSample, TemporalReason, TemporalStamp, TemporalVerdict } from "../temporal-core/types.js";
import type { BrowserBridgeExecutionResult, BrowserBridgeSnapshot, BrowserBridgeTargetInfo, BrowserObservationSnapshotInfo } from "./types.js";
import { writeTemporalProfileArtifacts, summarizeTemporalProfileSamples, type TemporalProfileArtifactPaths, type TemporalProfileSummary } from "./temporalProfileArtifacts.js";
import { isRecord } from "../utils/records.js";

export type CompactTemporalDecision = {
	verdict: {
		status: TemporalVerdict["status"];
		confidence: TemporalVerdict["confidence"];
		reasons: TemporalReason[];
	};
	frontier: {
		next: TemporalFrontierNext;
		handle?: string;
	};
};

export type QueueTemporalProfileInput = {
	queueDepthAtEnqueue?: number;
	queueDepthAtStart?: number;
	queueDelayMs?: number;
	deadlineMs?: number;
};

export type TemporalProfileSampleInput = {
	operationId?: string;
	tool: string;
	command?: string;
	target?: { browserSessionId?: string; tabId?: number; targetRef?: string };
	deadlineMs?: number;
	elapsedMs: number;
	result?: BrowserBridgeExecutionResult;
	diagnostics?: Record<string, unknown>;
};

function reasons(value: unknown): TemporalReason[] | undefined {
	return Array.isArray(value) ? value.filter((item): item is TemporalReason => typeof item === "string").slice(0, 3) : undefined;
}

function compact(decision: TemporalDecision, handle?: string): CompactTemporalDecision {
	return {
		verdict: {
			status: decision.verdict.status,
			confidence: decision.verdict.confidence,
			reasons: decision.verdict.reasons.slice(0, 3),
		},
		frontier: { next: decision.frontier.next, ...(handle ? { handle } : {}) },
	};
}

function supervisorFromData(data: unknown): Record<string, unknown> | undefined {
	const record = isRecord(data) ? data : undefined;
	const direct = isRecord(record?.supervisor) ? record.supervisor : undefined;
	if (direct) return direct;
	const wait = isRecord(record?.wait) ? record.wait : undefined;
	return isRecord(wait?.supervisor) ? wait.supervisor : undefined;
}

function diagnosticsFrom(input: TemporalProfileSampleInput): Record<string, unknown> | undefined {
	return input.diagnostics || (isRecord(input.result?.diagnostics) ? input.result.diagnostics : undefined);
}

function temporalProfileFromDiagnostics(diagnostics: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	return isRecord(diagnostics?.temporalProfile) ? diagnostics.temporalProfile : undefined;
}

function temporalFromDiagnostics(diagnostics: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	return isRecord(diagnostics?.temporal) ? diagnostics.temporal : undefined;
}

function numeric(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

export function compactTemporalDecision(decision: TemporalDecision, handle?: string): CompactTemporalDecision {
	return compact(decision, handle);
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
		temporal: pressure.verdict.status === "fresh" ? undefined : compact(pressure),
		temporalProfile,
	};
}

export class BrowserTemporalCoordinator {
	private readonly samples: TemporalProfileSample[] = [];
	private artifactTail: Promise<TemporalProfileArtifactPaths | undefined> = Promise.resolve(undefined);

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
		return compact(estimateTargetContinuity({ anchor, current, ...input }));
	}

	estimatePageFreshness(anchor: TemporalAnchor | undefined, current: TemporalStamp | undefined, input: { targetRegionDirty?: boolean; stableLocator?: boolean; maxSameDomainAgeMs?: number } = {}): CompactTemporalDecision {
		return compact(estimatePageFreshness({ anchor, current, ...input }));
	}

	estimateWaitContinuity(input: { previousWorkerBootId?: string; currentWorkerBootId?: string; historyLost?: boolean; workerRestarts?: number }): CompactTemporalDecision {
		return compact(estimateWaitContinuity(input));
	}

	buildProfileSample(input: TemporalProfileSampleInput): TemporalProfileSample {
		const diagnostics = diagnosticsFrom(input);
		const temporalProfile = temporalProfileFromDiagnostics(diagnostics);
		const temporal = temporalFromDiagnostics(diagnostics);
		const verdict = isRecord(temporal?.verdict) ? temporal.verdict : undefined;
		const frontier = isRecord(temporal?.frontier) ? temporal.frontier : undefined;
		const supervisor = supervisorFromData(input.result?.data);
		const target = input.target ?? (input.result?.target ? {
			browserSessionId: input.result.target.browserSessionId,
			tabId: input.result.target.tabId,
			targetRef: input.result.target.targetRef,
		} : undefined);
		return {
			...(input.operationId ? { operationId: input.operationId } : {}),
			tool: input.tool,
			command: input.command ?? (typeof temporalProfile?.command === "string" ? temporalProfile.command : undefined),
			...(target ? { target } : {}),
			...((input.deadlineMs ?? numeric(temporalProfile?.deadlineMs)) !== undefined ? { deadlineMs: input.deadlineMs ?? numeric(temporalProfile?.deadlineMs) } : {}),
			elapsedMs: input.elapsedMs,
			...(numeric(temporalProfile?.bridgeRoundTrips) !== undefined ? { bridgeRoundTrips: numeric(temporalProfile?.bridgeRoundTrips) } : {}),
			...(numeric(temporalProfile?.queueDepthAtEnqueue) !== undefined ? { queueDepthAtEnqueue: numeric(temporalProfile?.queueDepthAtEnqueue) } : {}),
			...(numeric(temporalProfile?.queueDepthAtStart) !== undefined ? { queueDepthAtStart: numeric(temporalProfile?.queueDepthAtStart) } : {}),
			...(numeric(temporalProfile?.queueDelayMs) !== undefined ? { queueDelayMs: numeric(temporalProfile?.queueDelayMs) } : {}),
			...((numeric(supervisor?.attempts) ?? numeric(temporalProfile?.waitAttempts)) !== undefined ? { waitAttempts: numeric(supervisor?.attempts) ?? numeric(temporalProfile?.waitAttempts) } : {}),
			...((numeric(supervisor?.workerRestarts) ?? numeric(temporalProfile?.workerRestarts)) !== undefined ? { workerRestarts: numeric(supervisor?.workerRestarts) ?? numeric(temporalProfile?.workerRestarts) } : {}),
			...((bool(supervisor?.historyLost) ?? bool(temporalProfile?.historyLost)) !== undefined ? { historyLost: bool(supervisor?.historyLost) ?? bool(temporalProfile?.historyLost) } : {}),
			...(Array.isArray(temporalProfile?.rawSignals) ? { rawSignals: temporalProfile.rawSignals.filter((item): item is string => typeof item === "string").slice(0, 8) } : {}),
			...(typeof verdict?.status === "string" ? { verdict: verdict.status as TemporalProfileSample["verdict"] } : {}),
			...(reasons(verdict?.reasons) ? { reasons: reasons(verdict?.reasons) } : {}),
			...(typeof frontier?.next === "string" ? { recovery: frontier.next as TemporalProfileSample["recovery"] } : {}),
		};
	}

	recordProfileSample(sample: TemporalProfileSample, options: { cwd?: string; runId?: string; evalRunDir?: string; runnerSummaryPath?: string } = {}): Promise<TemporalProfileArtifactPaths | undefined> {
		this.samples.push(sample);
		const runId = options.runId ?? "runtime";
		const samples = this.samples.slice();
		this.artifactTail = this.artifactTail
			.then(() => writeTemporalProfileArtifacts({ cwd: options.cwd, runId, samples, evalRunDir: options.evalRunDir, runnerSummaryPath: options.runnerSummaryPath }))
			.catch(() => undefined);
		return this.artifactTail;
	}

	profileSummary(runId = "runtime"): TemporalProfileSummary {
		return summarizeTemporalProfileSamples(this.samples, { runId });
	}
}
