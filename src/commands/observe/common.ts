import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { createCodedError } from "../../utils/codedError.js";
import { resolveLocalTargetTabId, targetTabId } from "../commandRuntime.js";
import type { PageIdentity } from "../../kernels/session/pageIdentity.js";
import { currentPageIdentity } from "./pageIdentity.js";

export const DEFAULT_CONTENT_TIMEOUT_MS = 35_000;
export const MIN_CONTENT_TIMEOUT_MS = 100;
export type ObserveMode = "scan" | "content" | "html" | "text" | "tabs";

export type ObserveToolParams = {
	mode?: string;
	modeExplicit?: boolean;
	browserSessionId?: string;
	tabId?: number | string;
	targetRef?: string;
	detailLevel?: string;
	outputPath?: string;
	timeoutMs?: number;
	maxChars?: number;
	selector?: string;
	content?: string;
	readability?: boolean;
	url?: string;
	includeLinks?: boolean;
	maxNodes?: number;
	includeIframes?: boolean;
	htmlMode?: string;
	params?: unknown;
	intent?: string;
	baseline?: unknown;
	baselineSnapshotId?: string;
	baselinePath?: string;
	actionRef?: string;
	fresh?: boolean;
	diff?: boolean;
	diagnostics?: string | boolean;
	debug?: string | boolean;
	axe?: boolean;
	axeDiagnostics?: boolean;
	modeInferred?: { mode: ObserveMode; reason: string } | null;
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

export function withObservationMeta(summary: Record<string, unknown>, mode: ObserveMode, sourceMode: "scan" | "content" | "html"): Record<string, unknown> {
	return { mode, sourceMode, ...summary };
}

export function currentObserveSnapshotMeta(server: BrowserCommandRuntimePort, params: ObserveToolParams, sourceMode: "scan" | "content" | "html", savedPath: string | undefined, url: string | undefined, networkSeq?: number, hookSeq?: number, identityOverride?: PageIdentity) {
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
		sourceMode,
		capturedAt: Date.now(),
		networkSeq,
		hookSeq,
		saved: savedPath ? { path: savedPath } : undefined,
	});
}
