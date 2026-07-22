import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { createCodedError } from "../../utils/codedError.js";
import { resolveLocalTargetTabId, targetTabId } from "../commandRuntime.js";
import type { PageIdentity } from "../../kernels/session/pageIdentity.js";
import { currentPageIdentity } from "./pageIdentity.js";

export const DEFAULT_CONTENT_TIMEOUT_MS = 35_000;
export const MIN_CONTENT_TIMEOUT_MS = 100;

export type ObserveToolParams = {
	browserSessionId?: string;
	targetRef?: string;
	outputPath?: string;
	timeoutMs?: number;
	maxChars?: number;
	maxNodes?: number;
	includeIframes?: boolean;
	intent?: string;
	baseline?: unknown;
	baselineSnapshotId?: string;
	baselinePath?: string;
	actionRef?: string;
	fresh?: boolean;
	diff?: boolean;
};

type ObserveRunnerError = Error & { code: "INVALID_TIMEOUT"; details: Record<string, unknown> };

function contentTimeoutError(message: string, value: unknown): ObserveRunnerError {
	return createCodedError({
		name: "ObserveRunnerError",
		code: "INVALID_TIMEOUT",
		message,
		details: { timeoutMs: value, minTimeoutMs: MIN_CONTENT_TIMEOUT_MS },
	}) as ObserveRunnerError;
}

export function normalizeContentTimeoutMs(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_CONTENT_TIMEOUT_MS;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) throw contentTimeoutError("browser_observe content timeoutMs must be a positive number", value);
	const timeoutMs = Math.ceil(n);
	if (timeoutMs < MIN_CONTENT_TIMEOUT_MS) throw contentTimeoutError(`browser_observe content timeoutMs must be at least ${MIN_CONTENT_TIMEOUT_MS}ms`, value);
	return timeoutMs;
}

export function currentObserveSnapshotMeta(server: BrowserCommandRuntimePort, params: ObserveToolParams, savedPath: string | undefined, url: string | undefined, networkSeq?: number, hookSeq?: number, identityOverride?: PageIdentity) {
	const bridge = server.snapshot({ browserSessionId: params.browserSessionId });
	const rawTargetRef = targetTabId(params);
	const tabId = resolveLocalTargetTabId(server, rawTargetRef, params.browserSessionId) ?? bridge.defaultTabId;
	const pageIdentity = identityOverride ?? currentPageIdentity(server, { browserSessionId: params.browserSessionId, tabId });
	return server.createObservationSnapshot({
		browserSessionId: bridge.browserSessionId,
		tabId,
		url,
		...(pageIdentity ? {
			targetGeneration: pageIdentity.targetGeneration,
			pageEpoch: pageIdentity.pageEpoch,
		} : {}),
		frameScope: "tab",
		selectionVersion: bridge.selectionVersion,
		sourceMode: "scan",
		capturedAt: Date.now(),
		networkSeq,
		hookSeq,
		saved: savedPath ? { path: savedPath } : undefined,
	});
}
