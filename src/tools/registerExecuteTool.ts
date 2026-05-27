import { Type } from "typebox";
import type { BrowserBridgeExecutionResult } from "../driver/types";
import { BrowserBridgeError } from "../driver/errors";
import { buildScanScript } from "../scan/buildScanScript";
import { compactError } from "../utils/errors";
import { artifactFallbackName, jsonToolResult, runTool, sharedTabScopedToolParams, toolMaxChars, toolTimeoutMs, withTrackedOperation } from "./toolAdapter";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";

type MonitorScanResult = {
	ok: boolean;
	content?: string;
	error?: Record<string, unknown>;
};

type MonitorMetadata = {
	beforeOk: boolean;
	afterOk: boolean;
	beforeChars: number;
	afterChars: number;
	changed: number;
	top_change?: string;
	beforeError?: Record<string, unknown>;
	afterError?: Record<string, unknown>;
};

function normalizeTabId(value: unknown): number | undefined {
	const tabId = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
	return Number.isInteger(tabId) && tabId > 0 ? tabId : undefined;
}

function textLines(value: unknown): string[] {
	return String(value || "").split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function diffScanContent(before: unknown, after: unknown): { changed: number; top_change?: string } {
	const beforeSet = new Set(textLines(before));
	const added = textLines(after).filter((line) => !beforeSet.has(line));
	return { changed: added.length, top_change: added[0]?.slice(0, 2_000) };
}

function detectCommandLikeScript(script: string): boolean {
	const trimmed = script.trim();
	if (!trimmed.startsWith("{")) return false;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		return !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>).cmd === "string";
	} catch {
		return false;
	}
}

async function monitorScan(server: Awaited<ReturnType<ToolRegistrarContext["ensureStarted"]>>, scanScript: string, options: { browserSessionId?: string; tabId?: unknown; timeoutMs: number }): Promise<MonitorScanResult> {
	try {
		const result = await server.executeJavaScript(scanScript, { browserSessionId: options.browserSessionId, tabId: options.tabId as number | string | undefined, timeoutMs: options.timeoutMs });
		const content = (result.data as Record<string, unknown> | undefined)?.content;
		return { ok: true, content: typeof content === "string" ? content : undefined };
	} catch (error) {
		return { ok: false, error: compactError(error, "MONITOR_SCAN_FAILED") };
	}
}

async function executeJavaScriptWithMonitor(server: Awaited<ReturnType<ToolRegistrarContext["ensureStarted"]>>, script: string, options: { browserSessionId?: string; tabId?: unknown; timeoutMs: number }): Promise<BrowserBridgeExecutionResult & { monitor: MonitorMetadata }> {
	const monitorTimeoutMs = Math.min(Math.max(500, options.timeoutMs), 5_000);
	const scanScript = buildScanScript({ textOnly: false, maxChars: 50_000, maxNodes: 3_000 });
	const before = await monitorScan(server, scanScript, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: monitorTimeoutMs });
	const executed = await server.executeJavaScript(script, { browserSessionId: options.browserSessionId, tabId: options.tabId as number | string | undefined, timeoutMs: options.timeoutMs });
	const after = await monitorScan(server, scanScript, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: monitorTimeoutMs });
	const diff = before.ok && after.ok ? diffScanContent(before.content, after.content) : { changed: 0, top_change: undefined };
	return {
		...executed,
		monitor: {
			beforeOk: before.ok,
			afterOk: after.ok,
			beforeChars: typeof before.content === "string" ? before.content.length : 0,
			afterChars: typeof after.content === "string" ? after.content.length : 0,
			...diff,
			beforeError: before.error,
			afterError: after.error,
		},
	};
}

export function registerExecuteTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_execute",
		label: "Browser Execute",
		description: "Execute JavaScript in a connected real browser tab.",
		promptSnippet: "Execute JavaScript in a real browser tab.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_execute for precise browser actions; return explicit values from async JavaScript."],
		parameters: Type.Object({
			script: Type.String({ description: "JavaScript source." }),
			...sharedTabScopedToolParams(),
			monitor: Type.Optional(Type.Boolean({ description: "Capture compact before/after scan diff for JavaScript mode. Default false to avoid token and latency overhead." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runTool(async () => {
				if (!params.script) throw new Error("browser_execute requires script");
				if (detectCommandLikeScript(params.script)) {
					throw new BrowserBridgeError("INVALID_RULE", "browser_execute only accepts JavaScript; use browser_command for bridge commands", { toolName: "browser_execute", recovery: { useTool: "browser_command" } });
				}
				const server = await ensureStarted();
				const timeoutMs = toolTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const maxChars = toolMaxChars(params, "browser_execute");
				const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
				const tabId = normalizeTabId(params.tabId);
				const { result: jsResult, operation } = await withTrackedOperation(server, {
					toolName: "browser_execute",
					command: "javascript",
					browserSessionId,
					tabId,
					phase: "running",
					progress: 5,
					queueDepth: server.queueDepth(browserSessionId, tabId),
					leaseOwnerHash: server.leaseOwnerHash(browserSessionId, tabId),
				}, _onUpdate, async (handle) => {
					await handle.update({ progress: params.monitor === true ? 15 : 35 });
					const result = params.monitor === true
						? await executeJavaScriptWithMonitor(server, params.script, { browserSessionId, tabId: params.tabId, timeoutMs })
						: await server.executeJavaScript(params.script, { browserSessionId, tabId: params.tabId, timeoutMs });
					await handle.update({ progress: 85, details: { acknowledged: result.acknowledged, target: result.target } });
					return result;
				});
				return await jsonToolResult(jsResult, params, ctx, {
					toolName: "browser_execute",
					command: "javascript",
					defaultDetailLevel: "preview",
					maxChars,
					fallbackName: artifactFallbackName("execute"),
					details: { mode: "javascript", monitor: params.monitor === true },
					operation,
					artifactValue: jsResult,
				});
			});
		},
	});
}
