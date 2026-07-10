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

function waitDiagnosis(waitType: string, condition: string, observedState: string, suggestion: string): WaitTimeoutDiagnosis {
	return { waitType, condition, observedState, suggestion };
}

function selectorTimeoutDiagnosis(input: DiagnoseWaitTimeoutInput, primaryReason?: TemporalReason): WaitTimeoutDiagnosis {
	const selectorLabel = input.selector ? `"${input.selector}"` : "target selector";
	if (input.selectorMissing || primaryReason === "selector_missing") {
		return waitDiagnosis("selector", `element matching ${selectorLabel} to appear`, "element not found in document", "element not found — verify selector is correct, re-observe the page with browser_observe, or check if the element is inside an iframe");
	}
	if (primaryReason === "selector_unstable") {
		return waitDiagnosis("selector", `element matching ${selectorLabel} to stabilize`, "element found but condition not met — element is unstable or state did not reach target", "element was found but its state is fluctuating — the page may still be rendering; try increasing timeout or waiting for a more specific selector");
	}
	const state = input.selectorState || "attached";
	return input.selectorFound === true
		? waitDiagnosis("selector", `element matching ${selectorLabel} to reach state "${state}"`, `element found but condition "${state}" not met`, `element exists but did not reach "${state}" state — check if the element is hidden, disabled, or obscured by an overlay`)
		: waitDiagnosis("selector", `element matching ${selectorLabel} to reach state "${state}"`, "element not found or condition not met before deadline", "verify selector is correct — re-observe the page with browser_observe to find the current selectors");
}

function networkIdleTimeoutDiagnosis(input: DiagnoseWaitTimeoutInput): WaitTimeoutDiagnosis {
	const count = input.pendingRequests;
	const pending = typeof count === "number" ? `${count} network request${count !== 1 ? "s" : ""} still pending` : undefined;
	return waitDiagnosis(
		"networkIdle",
		"network to become idle (no in-flight requests)",
		pending || "network requests still in-flight",
		pending ? `${pending} — the page may have long-polling, SSE, or WebSocket connections; consider waiting for a specific selector instead` : "network did not reach idle state — the page may have persistent connections; consider waiting for a specific selector instead",
	);
}

function loadStateTimeoutDiagnosis(input: DiagnoseWaitTimeoutInput): WaitTimeoutDiagnosis {
	const target = input.loadStateTarget || "load";
	const current = input.loadState || "unknown";
	const suggestion = current === "loading"
		? `page load state is "${current}" — increase timeout or wait for a specific selector instead`
		: `page did not reach "${target}" state (currently "${current}") — the page may have stalled resources; try waiting for a specific selector instead`;
	return waitDiagnosis("loadState", `page load state to reach "${target}"`, `page load state is "${current}"`, suggestion);
}

function navigationTimeoutDiagnosis(input: DiagnoseWaitTimeoutInput, primaryReason?: TemporalReason): WaitTimeoutDiagnosis {
	if (input.urlChanged || primaryReason === "url_changed" || primaryReason === "url_mismatch") {
		const url = input.urlAfter ? ` (now at "${input.urlAfter}")` : "";
		return waitDiagnosis("navigation", "navigation to complete", `URL changed${url} but page did not finish loading`, "navigation started but the page did not fully load — increase timeout or wait for a specific element on the target page");
	}
	return waitDiagnosis("navigation", "navigation to occur", "no URL change detected", "no navigation was detected — verify the URL is correct, or the navigation trigger (click/form submission) actually initiates a page navigation");
}

function infrastructureTimeoutDiagnosis(input: DiagnoseWaitTimeoutInput): WaitTimeoutDiagnosis | undefined {
	const waitType = commandToWaitType(input.command);
	if (input.historyLost || (input.workerRestarts ?? 0) > 0) {
		return waitDiagnosis(waitType, "wait to complete", "browser extension worker restarted during wait — wait history was lost", "the browser extension service worker restarted and lost wait state — retry the wait command");
	}
	if (input.clientDisconnected) return waitDiagnosis(waitType, "wait to complete", "browser extension disconnected during wait", "the browser extension disconnected — verify the extension is still loaded and the browser is still running");
	if (input.bridgeTimeout) return waitDiagnosis(waitType, "wait to complete", "bridge communication timed out — command was acknowledged but no result received", "the bridge timed out after acknowledging the command — the page may be unresponsive; try reloading the page");
	if (input.backgroundThrottling) return waitDiagnosis(waitType, "wait to complete", "browser tab may be throttled (background tab or minimized window)", "the browser may be throttling the background tab — ensure the tab is focused and the browser window is not minimized");
	return undefined;
}

const SELECTOR_WAIT_COMMANDS = new Set(["wait.selector", "wait.any", "wait.all"]);
const NETWORK_WAIT_COMMANDS = new Set(["wait.networkIdle", "network.wait"]);
const NAVIGATION_WAIT_COMMANDS = new Set(["wait.navigation", "wait.navigate", "wait.navigateAndWait"]);

export function diagnoseWaitTimeout(input: DiagnoseWaitTimeoutInput): WaitTimeoutDiagnosis {
	const primaryReason = input.reasons[0];
	if (SELECTOR_WAIT_COMMANDS.has(input.command)) return selectorTimeoutDiagnosis(input, primaryReason);
	if (NETWORK_WAIT_COMMANDS.has(input.command)) return networkIdleTimeoutDiagnosis(input);
	if (input.command === "wait.loadState") return loadStateTimeoutDiagnosis(input);
	if (NAVIGATION_WAIT_COMMANDS.has(input.command)) return navigationTimeoutDiagnosis(input, primaryReason);
	return infrastructureTimeoutDiagnosis(input) ?? waitDiagnosis(
		commandToWaitType(input.command),
		"wait condition to be satisfied",
		primaryReason ? `wait ended with reason: ${primaryReason}` : "wait deadline reached without condition being met",
		"the wait timed out — try increasing the timeout, verify the page state, or use browser_observe to inspect current page content",
	);
}

function commandToWaitType(command: string): string {
	if (command.includes("selector")) return "selector";
	if (command.includes("networkIdle") || command.includes("network")) return "networkIdle";
	if (command.includes("loadState")) return "loadState";
	if (command.includes("navigat")) return "navigation";
	return "wait";
}
