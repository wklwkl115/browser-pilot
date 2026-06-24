import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import type { BrowserBridgeExecutionResult } from "../../ports/BrowserRuntimeTypes.js";
import { createBrowserAbmlIntegration } from "../../browser-command-runtime/abml/integration.js";
import type { ExecuteStdlibTargetRef } from "../../browser-command-runtime/executeStdlib.js";
import { buildScanScript } from "../../scan/buildScanScript.js";
import { compactError } from "../../utils/errors.js";
import { resolveLocalTargetTabId } from "../commandRuntime.js";
import { withExecutionEffect } from "../executionEffect.js";
import type { ExecuteEffect } from "../executionJournal.js";

export const EXECUTE_MONITOR_NAV_WARNING = "page navigated — changed count is unreliable; use browser_wait + baseline observe for post-navigation change detection";

export type ExecuteMonitorSource = "abml-read" | "legacy-scan";

export type ExecuteMonitorScanResult = {
	ok: boolean;
	content?: string;
	url?: string;
	error?: Record<string, unknown>;
	source?: ExecuteMonitorSource;
};

export type ExecuteMonitorMetadata = {
	url?: string;
	beforeOk: boolean;
	afterOk: boolean;
	beforeChars: number;
	afterChars: number;
	changed: number;
	top_change?: string;
	navigated?: boolean;
	changedReliable?: boolean;
	warning?: string;
	afterUnreliable?: boolean;
	urlBefore?: string;
	urlAfter?: string;
	beforeError?: Record<string, unknown>;
	afterError?: Record<string, unknown>;
	beforeSource?: ExecuteMonitorSource;
	afterSource?: ExecuteMonitorSource;
};

type ExecuteMonitorAdapterOptions = {
	browserSessionId?: string;
	tabId?: unknown;
	timeoutMs: number;
};

type ExecuteMonitorRunOptions = ExecuteMonitorAdapterOptions & {
	targetRefs?: ExecuteStdlibTargetRef[];
};

export type ExecuteResultWithMonitorFeedback = BrowserBridgeExecutionResult & {
	effect?: ExecuteEffect;
	monitor?: ExecuteMonitorMetadata;
};

function textLines(value: unknown): string[] {
	return String(value || "").split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}

export function diffExecuteMonitorContent(before: unknown, after: unknown): { changed: number; top_change?: string } {
	const beforeSet = new Set(textLines(before));
	const added = textLines(after).filter((line) => !beforeSet.has(line));
	return { changed: added.length, top_change: added[0]?.slice(0, 2_000) };
}

export async function readExecuteMonitorScan(server: BrowserCommandRuntimePort, options: ExecuteMonitorAdapterOptions): Promise<ExecuteMonitorScanResult> {
	try {
		const runtime = createBrowserAbmlIntegration(server, { browserSessionId: options.browserSessionId, tabId: options.tabId as number | string | undefined, timeoutMs: options.timeoutMs, maxChars: 50_000 });
		const abml = await runtime.readStructure({ browserSessionId: options.browserSessionId, tabId: options.tabId as number | string | undefined, timeoutMs: options.timeoutMs, maxChars: 50_000 });
		if (abml?.ok && abml.data && typeof abml.data === "object") {
			const summary = (abml.data as Record<string, unknown>).summary as Record<string, unknown> | undefined;
			const content = typeof summary?.textPreview === "string" ? summary.textPreview : JSON.stringify(abml.entities ?? [], null, 2);
			const url = typeof summary?.url === "string" ? summary.url : undefined;
			return { ok: true, content, url, source: "abml-read" };
		}
		const scanScript = buildScanScript({ textOnly: false, maxChars: 50_000, maxNodes: 3_000 });
		const result = await server.executeJavaScript(scanScript, { browserSessionId: options.browserSessionId, tabId: options.tabId as number | string | undefined, timeoutMs: options.timeoutMs });
		const content = (result.data as Record<string, unknown> | undefined)?.content;
		return { ok: true, content: typeof content === "string" ? content : undefined, source: "legacy-scan" };
	} catch (error) {
		return { ok: false, error: compactError(error, "MONITOR_SCAN_FAILED") };
	}
}

export function buildExecuteMonitorMetadata(before: ExecuteMonitorScanResult, after: ExecuteMonitorScanResult, options: { navigationWarning?: string; includeAfterUnreliable?: boolean } = {}): ExecuteMonitorMetadata {
	const diff = before.ok && after.ok ? diffExecuteMonitorContent(before.content, after.content) : { changed: 0, top_change: undefined };
	const navigated = !!(before.url && after.url && before.url !== after.url);
	const afterUnreliable = options.includeAfterUnreliable === true && before.ok && !after.ok;
	return {
		...(after.url || before.url ? { url: after.url ?? before.url } : {}),
		beforeOk: before.ok,
		afterOk: after.ok,
		beforeChars: typeof before.content === "string" ? before.content.length : 0,
		afterChars: typeof after.content === "string" ? after.content.length : 0,
		...diff,
		...(navigated ? { navigated: true, changedReliable: false, warning: options.navigationWarning ?? EXECUTE_MONITOR_NAV_WARNING, urlBefore: before.url, urlAfter: after.url } : {}),
		...(afterUnreliable ? { afterUnreliable: true } : {}),
		beforeError: before.error,
		afterError: after.error,
		beforeSource: before.source,
		afterSource: after.source,
	};
}

export function monitorTimeoutMs(timeoutMs: number): number {
	return Math.min(Math.max(500, timeoutMs), 5_000);
}

export async function executeJavaScriptWithMonitor(server: BrowserCommandRuntimePort, script: string, options: ExecuteMonitorRunOptions): Promise<ExecuteResultWithMonitorFeedback> {
	const scanTimeoutMs = monitorTimeoutMs(options.timeoutMs);
	const before = await readExecuteMonitorScan(server, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: scanTimeoutMs });
	const effectTabId = resolveLocalTargetTabId(server, options.tabId, options.browserSessionId);
	const executed = await withExecutionEffect(server, { browserSessionId: options.browserSessionId, tabId: effectTabId, timeoutMs: options.timeoutMs, targetRefs: options.targetRefs }, () => server.executeJavaScript(script, { browserSessionId: options.browserSessionId, tabId: options.tabId as number | string | undefined, timeoutMs: options.timeoutMs }));
	const after = await readExecuteMonitorScan(server, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: scanTimeoutMs });
	return {
		...executed.result,
		effect: executed.effect,
		monitor: buildExecuteMonitorMetadata(before, after, { includeAfterUnreliable: true }),
	};
}
