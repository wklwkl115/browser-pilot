import type { TemporalConfidence, TemporalDecision, TemporalFrontierNext, TemporalReason, TemporalSource, TemporalVerdict, TemporalVerdictStatus } from "./types.js";
import { TEMPORAL_REASON_MODEL_CAP } from "./types.js";

export type ClassifyTimeoutInput = {
	acknowledged?: boolean;
	ackedBridgeTimeout?: boolean;
	leaseTimedOut?: boolean;
	clientDisconnected?: boolean;
	historyLost?: boolean;
	workerRestarts?: number;
	urlMismatch?: boolean;
	loadStateUnreached?: boolean;
	selectorMissing?: boolean;
	selectorUnstable?: boolean;
	backgroundThrottlingSuspected?: boolean;
	networkActive?: boolean;
	signalUnavailable?: boolean;
	underconstrained?: boolean;
	lateSuccessAfterDeadline?: boolean;
};

export type ClassifyStateLossInput = {
	historyLost?: boolean;
	workerRestarts?: number;
	tabDisconnected?: boolean;
	extensionUnavailable?: boolean;
	clientDisconnected?: boolean;
};

export type ClassifyStalenessInput = {
	anchorPresent?: boolean;
	targetRegionDirty?: boolean;
	dirtyRootsOverflow?: boolean;
	stableLocator?: boolean;
	cssOnlyLocator?: boolean;
	urlChanged?: boolean;
	selectionVersionChanged?: boolean;
	tabReplaced?: boolean;
	tabDisconnected?: boolean;
	signalUnavailable?: boolean;
};

function capReasons(reasons: TemporalReason[]): TemporalReason[] {
	return reasons.slice(0, TEMPORAL_REASON_MODEL_CAP);
}

function verdict(status: "fresh", confidence: "mechanical", reasons: TemporalReason[]): TemporalVerdict;
function verdict(status: "possibly_stale", confidence: "bounded", reasons: TemporalReason[]): TemporalVerdict;
function verdict(status: "stale", confidence: "mechanical", reasons: TemporalReason[]): TemporalVerdict;
function verdict(status: "unknown", confidence: "lost" | "partial", reasons: TemporalReason[]): TemporalVerdict;
function verdict(status: TemporalVerdictStatus, confidence: TemporalConfidence, reasons: TemporalReason[]): TemporalVerdict {
	return { status, confidence, reasons: capReasons(reasons) } as TemporalVerdict;
}

function decision(verdictValue: TemporalVerdict, frontierNext: TemporalFrontierNext, source: TemporalSource): TemporalDecision {
	return { verdict: verdictValue, frontier: { next: frontierNext }, source };
}

export function classifyStateLoss(input: ClassifyStateLossInput): TemporalDecision {
	if (input.extensionUnavailable) return decision(verdict("unknown", "lost", ["extension_unavailable"]), "fail_closed", "driver_snapshot");
	if (input.tabDisconnected) return decision(verdict("stale", "mechanical", ["tab_disconnected"]), "fail_closed", "driver_snapshot");
	if (input.clientDisconnected) return decision(verdict("unknown", "lost", ["client_disconnected"]), "fail_closed", "wait_supervisor");
	if (input.historyLost || (input.workerRestarts ?? 0) > 0) {
		return decision(verdict("unknown", "lost", ["worker_restarted_history_lost", "unknown_due_to_history_loss"]), "diagnose", "wait_supervisor");
	}
	return decision(verdict("fresh", "mechanical", ["same_wait_history"]), "retry_same_wait", "wait_supervisor");
}

export function classifyTimeout(input: ClassifyTimeoutInput): TemporalDecision {
	if (input.historyLost || (input.workerRestarts ?? 0) > 0 || input.clientDisconnected) {
		return classifyStateLoss({
			historyLost: input.historyLost,
			workerRestarts: input.workerRestarts,
			clientDisconnected: input.clientDisconnected,
		});
	}
	if (input.lateSuccessAfterDeadline) return decision(verdict("unknown", "partial", ["late_success_after_deadline"]), "reobserve", "wait_supervisor");
	if (input.acknowledged === false) return decision(verdict("unknown", "partial", ["no_ack"]), "retry_same_wait", "wait_supervisor");
	if (input.ackedBridgeTimeout) return decision(verdict("unknown", "partial", ["acked_bridge_timeout"]), "diagnose", "wait_supervisor");
	if (input.leaseTimedOut) return decision(verdict("possibly_stale", "bounded", ["lease_timeout"]), "retry_same_wait", "wait_supervisor");
	if (input.urlMismatch) return decision(verdict("stale", "mechanical", ["url_mismatch"]), "reobserve", "wait_supervisor");
	if (input.loadStateUnreached) return decision(verdict("possibly_stale", "bounded", ["load_state_unreached"]), "retry_same_wait", "wait_supervisor");
	if (input.selectorMissing) return decision(verdict("possibly_stale", "bounded", ["selector_missing"]), "reobserve", "wait_supervisor");
	if (input.selectorUnstable) return decision(verdict("possibly_stale", "bounded", ["selector_unstable"]), "retry_same_wait", "wait_supervisor");
	if (input.networkActive) return decision(verdict("possibly_stale", "bounded", ["network_active"]), "retry_same_wait", "wait_supervisor");
	if (input.backgroundThrottlingSuspected) return decision(verdict("unknown", "partial", ["background_throttling_suspected"]), "retry_same_wait", "wait_supervisor");
	if (input.underconstrained) return decision(verdict("unknown", "partial", ["underconstrained_wait"]), "diagnose", "wait_supervisor");
	if (input.signalUnavailable) return decision(verdict("unknown", "partial", ["signal_unavailable"]), "diagnose", "wait_supervisor");
	return decision(verdict("unknown", "partial", ["underconstrained_wait"]), "diagnose", "wait_supervisor");
}

export function classifyStaleness(input: ClassifyStalenessInput): TemporalDecision {
	if (input.tabDisconnected) return decision(verdict("stale", "mechanical", ["tab_disconnected"]), "fail_closed", "execute_effect");
	if (input.tabReplaced) return decision(verdict("stale", "mechanical", ["tab_replaced"]), "reobserve", "execute_effect");
	if (input.anchorPresent === false) return decision(verdict("unknown", "partial", ["unknown_due_to_missing_anchor"]), "reobserve", "execute_effect");
	if (input.signalUnavailable) return decision(verdict("unknown", "partial", ["signal_unavailable"]), "diagnose", "execute_effect");
	if (input.selectionVersionChanged) return decision(verdict("stale", "mechanical", ["selection_version_changed"]), "reobserve", "execute_effect");
	if (input.urlChanged) return decision(verdict("stale", "mechanical", ["url_changed"]), "reobserve", "execute_effect");
	if (input.targetRegionDirty) {
		const reasons: TemporalReason[] = ["target_stale_before_dispatch", "target_region_dirty"];
		if (input.stableLocator && !input.cssOnlyLocator) return decision(verdict("stale", "mechanical", reasons), "reobserve", "execute_effect");
		return decision(verdict("possibly_stale", "bounded", reasons), "reobserve", "execute_effect");
	}
	if (input.dirtyRootsOverflow) return decision(verdict("possibly_stale", "bounded", ["target_possibly_stale"]), "reobserve", "execute_effect");
	return decision(verdict("fresh", "mechanical", ["same_target"]), "reuse_target", "execute_effect");
}
