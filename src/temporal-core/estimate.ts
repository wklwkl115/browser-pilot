import { classifyStateLoss, classifyStaleness } from "./classify.js";
import type { TemporalAnchor, TemporalDecision, TemporalReason, TemporalStamp, TemporalSource, TemporalVerdict } from "./types.js";

export type EstimateTargetContinuityInput = {
	anchor?: TemporalAnchor;
	current?: TemporalStamp;
	targetRegionDirty?: boolean;
	stableLocator?: boolean;
	cssOnlyLocator?: boolean;
};

export type EstimatePageFreshnessInput = {
	anchor?: TemporalAnchor;
	current?: TemporalStamp;
	targetRegionDirty?: boolean;
	stableLocator?: boolean;
	maxSameDomainAgeMs?: number;
};

export type EstimateWaitContinuityInput = {
	previousWorkerBootId?: string;
	currentWorkerBootId?: string;
	historyLost?: boolean;
	workerRestarts?: number;
	eventSource?: TemporalSource;
};

function temporalDecision(verdict: TemporalVerdict, next: TemporalDecision["frontier"]["next"], source: TemporalSource): TemporalDecision {
	return { verdict, frontier: { next }, source };
}

function compactReasons(reasons: TemporalReason[]): TemporalReason[] {
	return reasons.slice(0, 3);
}

function mechanical(status: "fresh" | "stale", reasons: TemporalReason[]): TemporalVerdict {
	return { status, confidence: "mechanical", reasons: compactReasons(reasons) } as TemporalVerdict;
}

function partialUnknown(reasons: TemporalReason[]): TemporalVerdict {
	return { status: "unknown", confidence: "partial", reasons: compactReasons(reasons) };
}

function sameStableIdentity(anchor: TemporalStamp, current: TemporalStamp): boolean {
	if (anchor.browserSessionId && current.browserSessionId && anchor.browserSessionId !== current.browserSessionId) return false;
	if (anchor.tabHandle && current.tabHandle) return anchor.tabHandle === current.tabHandle;
	if (anchor.targetRef && current.targetRef) return anchor.targetRef === current.targetRef;
	if (anchor.tabId !== undefined && current.tabId !== undefined) return anchor.tabId === current.tabId;
	return false;
}

function targetMismatch(anchor: TemporalStamp, current: TemporalStamp): TemporalReason | undefined {
	if (anchor.browserSessionId && current.browserSessionId && anchor.browserSessionId !== current.browserSessionId) return "tab_disconnected";
	if (anchor.tabHandle && current.tabHandle && anchor.tabHandle !== current.tabHandle) return "tab_replaced";
	if (anchor.targetRef && current.targetRef && anchor.targetRef !== current.targetRef) return "tab_replaced";
	if (anchor.tabId !== undefined && current.tabId !== undefined && anchor.tabId !== current.tabId) return "tab_replaced";
	if (anchor.selectionVersion !== undefined && current.selectionVersion !== undefined && anchor.selectionVersion !== current.selectionVersion) return "selection_version_changed";
	if (anchor.url && current.url && anchor.url !== current.url) return "url_changed";
	return undefined;
}

function hasComparableSequence(anchor: TemporalStamp, current: TemporalStamp): boolean {
	return (anchor.sequence !== undefined && current.sequence !== undefined)
		|| (anchor.changeSeq !== undefined && current.changeSeq !== undefined)
		|| (anchor.networkSeq !== undefined && current.networkSeq !== undefined)
		|| (anchor.hookSeq !== undefined && current.hookSeq !== undefined);
}

export function estimateTargetContinuity(input: EstimateTargetContinuityInput): TemporalDecision {
	if (!input.anchor || !input.current) {
		return temporalDecision(partialUnknown(["unknown_due_to_missing_anchor"]), "reobserve", "ref_descriptor");
	}
	const anchorStamp = input.anchor.stamp;
	const current = input.current;
	const mismatch = targetMismatch(anchorStamp, current);
	if (mismatch) return temporalDecision(mechanical("stale", [mismatch]), mismatch === "tab_disconnected" ? "fail_closed" : "reobserve", "driver_snapshot");
	if (input.targetRegionDirty) {
		return classifyStaleness({
			anchorPresent: true,
			targetRegionDirty: true,
			stableLocator: input.stableLocator,
			cssOnlyLocator: input.cssOnlyLocator,
		});
	}
	if (!sameStableIdentity(anchorStamp, current) && anchorStamp.clockDomain !== current.clockDomain && !hasComparableSequence(anchorStamp, current)) {
		return temporalDecision(partialUnknown(["unknown_due_to_clock_domain"]), "reobserve", "driver_snapshot");
	}
	if (anchorStamp.pageEpoch && current.pageEpoch && anchorStamp.pageEpoch === current.pageEpoch) {
		return temporalDecision(mechanical("fresh", ["same_page_epoch"]), "reuse_target", "driver_snapshot");
	}
	return temporalDecision(mechanical("fresh", ["same_target"]), "reuse_target", "driver_snapshot");
}

export function estimatePageFreshness(input: EstimatePageFreshnessInput): TemporalDecision {
	if (!input.anchor || !input.current) return temporalDecision(partialUnknown(["unknown_due_to_missing_anchor"]), "reobserve", "page_signal");
	const anchorStamp = input.anchor.stamp;
	const current = input.current;
	if (anchorStamp.url && current.url && anchorStamp.url !== current.url) return temporalDecision(mechanical("stale", ["url_changed"]), "reobserve", "page_signal");
	if (input.targetRegionDirty) {
		return classifyStaleness({
			anchorPresent: true,
			targetRegionDirty: true,
			stableLocator: input.stableLocator,
			cssOnlyLocator: !input.stableLocator,
		});
	}
	if (current.dirtySinceSeq !== undefined && anchorStamp.changeSeq !== undefined && current.dirtySinceSeq <= anchorStamp.changeSeq) {
		return classifyStaleness({ anchorPresent: true, dirtyRootsOverflow: true });
	}
	if (anchorStamp.clockDomain !== current.clockDomain && !hasComparableSequence(anchorStamp, current)) {
		return temporalDecision(partialUnknown(["unknown_due_to_clock_domain"]), "reobserve", "page_signal");
	}
	if (input.maxSameDomainAgeMs !== undefined && anchorStamp.clockDomain === current.clockDomain && current.capturedAtMs - anchorStamp.capturedAtMs > input.maxSameDomainAgeMs) {
		return temporalDecision({ status: "possibly_stale", confidence: "bounded", reasons: ["target_possibly_stale"] }, "reobserve", "page_signal");
	}
	if (anchorStamp.changeSeq !== undefined && current.changeSeq !== undefined && anchorStamp.changeSeq === current.changeSeq) {
		return temporalDecision(mechanical("fresh", ["same_page_epoch"]), "reuse_target", "page_signal");
	}
	return temporalDecision(mechanical("fresh", ["same_target"]), "reuse_target", "page_signal");
}

export function estimateWaitContinuity(input: EstimateWaitContinuityInput): TemporalDecision {
	if (input.historyLost || (input.workerRestarts ?? 0) > 0) {
		return classifyStateLoss({ historyLost: input.historyLost, workerRestarts: input.workerRestarts });
	}
	if (input.previousWorkerBootId && input.currentWorkerBootId && input.previousWorkerBootId !== input.currentWorkerBootId) {
		return classifyStateLoss({ historyLost: true, workerRestarts: 1 });
	}
	if (input.eventSource === "poll_fallback") {
		return temporalDecision({ status: "possibly_stale", confidence: "bounded", reasons: ["selector_unstable"] }, "retry_same_wait", "poll_fallback");
	}
	return temporalDecision(mechanical("fresh", ["same_wait_history"]), "retry_same_wait", input.eventSource ?? "wait_supervisor");
}
