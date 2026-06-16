import type { TemporalConfidence, TemporalDecision, TemporalFrontierNext, TemporalReason, TemporalSource, TemporalVerdict, TemporalVerdictStatus } from "./types.js";
import { TEMPORAL_REASON_MODEL_CAP } from "./types.js";

export type WaitTimeoutDiagnosis = {
	waitType: string;
	condition: string;
	observedState: string;
	suggestion: string;
};

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

export type DiagnoseWaitTimeoutInput = {
	command: string;
	reasons: TemporalReason[];
	selectorMissing?: boolean;
	selectorFound?: boolean;
	selectorState?: string;
	selector?: string;
	networkActive?: boolean;
	pendingRequests?: number;
	loadState?: string;
	loadStateTarget?: string;
	urlChanged?: boolean;
	urlBefore?: string;
	urlAfter?: string;
	historyLost?: boolean;
	workerRestarts?: number;
	backgroundThrottling?: boolean;
	clientDisconnected?: boolean;
	bridgeTimeout?: boolean;
};

export function diagnoseWaitTimeout(input: DiagnoseWaitTimeoutInput): WaitTimeoutDiagnosis {
	const command = input.command;
	const primaryReason = input.reasons[0];

	// selector waits
	if (command === "wait.selector" || command === "wait.any" || command === "wait.all") {
		const selectorLabel = input.selector ? `"${input.selector}"` : "target selector";
		if (input.selectorMissing || primaryReason === "selector_missing") {
			return {
				waitType: "selector",
				condition: `element matching ${selectorLabel} to appear`,
				observedState: "element not found in document",
				suggestion: `element not found — verify selector is correct, re-observe the page with browser_observe, or check if the element is inside an iframe`,
			};
		}
		if (primaryReason === "selector_unstable") {
			return {
				waitType: "selector",
				condition: `element matching ${selectorLabel} to stabilize`,
				observedState: "element found but condition not met — element is unstable or state did not reach target",
				suggestion: `element was found but its state is fluctuating — the page may still be rendering; try increasing timeout or waiting for a more specific selector`,
			};
		}
		const stateDesc = input.selectorState || "attached";
		if (input.selectorFound === true) {
			return {
				waitType: "selector",
				condition: `element matching ${selectorLabel} to reach state "${stateDesc}"`,
				observedState: `element found but condition "${stateDesc}" not met`,
				suggestion: `element exists but did not reach "${stateDesc}" state — check if the element is hidden, disabled, or obscured by an overlay`,
			};
		}
		return {
			waitType: "selector",
			condition: `element matching ${selectorLabel} to reach state "${stateDesc}"`,
			observedState: "element not found or condition not met before deadline",
			suggestion: `verify selector is correct — re-observe the page with browser_observe to find the current selectors`,
		};
	}

	// networkIdle waits
	if (command === "wait.networkIdle" || command === "network.wait") {
		const pending = input.pendingRequests;
		const pendingDesc = typeof pending === "number" ? `${pending} network request${pending !== 1 ? "s" : ""} still pending` : "network requests still in-flight";
		return {
			waitType: "networkIdle",
			condition: "network to become idle (no in-flight requests)",
			observedState: pendingDesc,
			suggestion: typeof pending === "number"
				? `${pending} network request${pending !== 1 ? "s" : ""} still pending — the page may have long-polling, SSE, or WebSocket connections; consider waiting for a specific selector instead`
				: "network did not reach idle state — the page may have persistent connections; consider waiting for a specific selector instead",
		};
	}

	// loadState waits
	if (command === "wait.loadState") {
		const targetState = input.loadStateTarget || "load";
		const currentState = input.loadState || "unknown";
		return {
			waitType: "loadState",
			condition: `page load state to reach "${targetState}"`,
			observedState: `page load state is "${currentState}"`,
			suggestion: currentState === "loading"
				? `page load state is "${currentState}" — increase timeout or wait for a specific selector instead`
				: `page did not reach "${targetState}" state (currently "${currentState}") — the page may have stalled resources; try waiting for a specific selector instead`,
		};
	}

	// navigation waits
	if (command === "wait.navigation" || command === "wait.navigate" || command === "wait.navigateAndWait") {
		if (input.urlChanged || primaryReason === "url_changed" || primaryReason === "url_mismatch") {
			const urlDesc = input.urlAfter ? ` (now at "${input.urlAfter}")` : "";
			return {
				waitType: "navigation",
				condition: "navigation to complete",
				observedState: `URL changed${urlDesc} but page did not finish loading`,
				suggestion: "navigation started but the page did not fully load — increase timeout or wait for a specific element on the target page",
			};
		}
		return {
			waitType: "navigation",
			condition: "navigation to occur",
			observedState: "no URL change detected",
			suggestion: "no navigation was detected — verify the URL is correct, or the navigation trigger (click/form submission) actually initiates a page navigation",
		};
	}

	// infrastructure-level issues
	if (input.historyLost || (input.workerRestarts ?? 0) > 0) {
		return {
			waitType: commandToWaitType(command),
			condition: "wait to complete",
			observedState: "browser extension worker restarted during wait — wait history was lost",
			suggestion: "the browser extension service worker restarted and lost wait state — retry the wait command",
		};
	}
	if (input.clientDisconnected) {
		return {
			waitType: commandToWaitType(command),
			condition: "wait to complete",
			observedState: "browser extension disconnected during wait",
			suggestion: "the browser extension disconnected — verify the extension is still loaded and the browser is still running",
		};
	}
	if (input.bridgeTimeout) {
		return {
			waitType: commandToWaitType(command),
			condition: "wait to complete",
			observedState: "bridge communication timed out — command was acknowledged but no result received",
			suggestion: "the bridge timed out after acknowledging the command — the page may be unresponsive; try reloading the page",
		};
	}
	if (input.backgroundThrottling) {
		return {
			waitType: commandToWaitType(command),
			condition: "wait to complete",
			observedState: "browser tab may be throttled (background tab or minimized window)",
			suggestion: "the browser may be throttling the background tab — ensure the tab is focused and the browser window is not minimized",
		};
	}

	// generic fallback
	return {
		waitType: commandToWaitType(command),
		condition: "wait condition to be satisfied",
		observedState: primaryReason ? `wait ended with reason: ${primaryReason}` : "wait deadline reached without condition being met",
		suggestion: "the wait timed out — try increasing the timeout, verify the page state, or use browser_observe to inspect current page content",
	};
}

function commandToWaitType(command: string): string {
	if (command.includes("selector")) return "selector";
	if (command.includes("networkIdle") || command.includes("network")) return "networkIdle";
	if (command.includes("loadState")) return "loadState";
	if (command.includes("navigat")) return "navigation";
	return "wait";
}
