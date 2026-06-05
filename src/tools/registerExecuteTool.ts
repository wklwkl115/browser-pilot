import { Type } from "typebox";
import type { BrowserBridgeExecutionResult } from "../driver/types.js";
import { BrowserBridgeError } from "../driver/errors.js";
import { buildScanScript } from "../scan/buildScanScript.js";
import { createBrowserAbmlIntegration } from "../abml/verbs/integration.js";
import { defaultRefPolicyForKind, DEFAULT_LIVE_REF_TTL_MS } from "../abml/refPolicy.js";
import type { RefDescriptor } from "../abml/types.js";
import { compactError } from "../utils/errors.js";
import { tryJson } from "../utils/json.js";
import { normalizeTabId } from "../utils/params.js";
import { isRecord } from "../utils/records.js";
import { summarizeGenericValue } from "./summaries/index.js";
import { artifactFallbackName, defineBrowserTool, jsonToolResult, runTool, sharedTabScopedToolParams, toolMaxChars, toolTimeoutMs, withTrackedOperation } from "./toolAdapter.js";
import { DEFAULT_TOOL_TIMEOUT_MS, TAB_SCOPED_TOOL_GUIDELINE, strictToolParameters } from "./toolShared.js";
import type { ToolRegistrarContext } from "./toolShared.js";

type MonitorScanResult = {
	ok: boolean;
	content?: string;
	error?: Record<string, unknown>;
	source?: "abml-read" | "legacy-scan";
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
	beforeSource?: "abml-read" | "legacy-scan";
	afterSource?: "abml-read" | "legacy-scan";
};

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
	const parsed = tryJson(trimmed);
	return isRecord(parsed) && typeof parsed.cmd === "string";
}

async function monitorScan(server: Awaited<ReturnType<ToolRegistrarContext["ensureStarted"]>>, scanScript: string, options: { browserSessionId?: string; tabId?: unknown; timeoutMs: number }): Promise<MonitorScanResult> {
	try {
		const runtime = createBrowserAbmlIntegration(server, { browserSessionId: options.browserSessionId, tabId: options.tabId as number | string | undefined, timeoutMs: options.timeoutMs, maxChars: 50_000 });
		const abml = await runtime.readStructure({ browserSessionId: options.browserSessionId, tabId: options.tabId as number | string | undefined, timeoutMs: options.timeoutMs, maxChars: 50_000 });
		if (abml?.ok && abml.data && typeof abml.data === "object") {
			const summary = (abml.data as Record<string, unknown>).summary as Record<string, unknown> | undefined;
			const content = typeof summary?.textPreview === "string" ? summary.textPreview : JSON.stringify(abml.entities ?? [], null, 2);
			return { ok: true, content, source: "abml-read" };
		}
		const result = await server.executeJavaScript(scanScript, { browserSessionId: options.browserSessionId, tabId: options.tabId as number | string | undefined, timeoutMs: options.timeoutMs });
		const content = (result.data as Record<string, unknown> | undefined)?.content;
		return { ok: true, content: typeof content === "string" ? content : undefined, source: "legacy-scan" };
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
			beforeSource: before.source,
			afterSource: after.source,
		},
	};
}

// B2 — resolve an `action` target to something the ABML ladder accepts. A pi-ref:// (from observe)
// resolves the real entity; a bare CSS selector synthesizes a minimal live-actionable control ref
// (defaultRefPolicyForKind("control") sets liveActionsAllowed) so a click can run without a prior scan.
function actionTargetRef(target: string, owner: { tabId?: number; browserSessionId?: string }): RefDescriptor | string {
	const trimmed = target.trim();
	if (trimmed.startsWith("pi-ref://") || trimmed.startsWith("browser-result://")) return trimmed;
	return {
		refId: "pi-ref://control/execute-action",
		kind: "control",
		locators: [{ by: "css", value: trimmed }],
		owner: {
			...(owner.browserSessionId ? { browserSessionId: owner.browserSessionId } : {}),
			...(owner.tabId !== undefined ? { tabId: owner.tabId } : {}),
		},
		policy: defaultRefPolicyForKind("control"),
		observationId: `execute-action:${owner.tabId ?? "tab"}`,
		createdAt: Date.now(),
		ttlMs: DEFAULT_LIVE_REF_TTL_MS,
	};
}

export function registerExecuteTool({ pi, ensureStarted }: ToolRegistrarContext) {
	defineBrowserTool(pi, {
		name: "browser_execute",
		label: "Browser Execute",
		description: "Execute JavaScript in a connected real browser tab.",
		promptSnippet: "Execute JavaScript in a real browser tab.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_execute for precise browser actions; return explicit values from async JavaScript."],
		parameters: strictToolParameters({
			script: Type.Optional(Type.String({ description: "JavaScript source. Omit when using `action`." })),
				action: Type.Optional(Type.Object({
					click: Type.Optional(Type.String({ description: "Click a control reliably via the ABML ladder (actionability wait + auto CDP trusted-event fallback + effect verification). Value: a pi-ref:// from observe, or a CSS selector. Prefer over a hand-written el.click() when the click must actually take effect." })),
					type: Type.Optional(Type.Object({ target: Type.String({ description: "pi-ref:// or CSS selector of the field to type into." }), text: Type.String({ description: "Text to insert." }), clear: Type.Optional(Type.Boolean({ description: "Clear the field first (default false)." })) }, { description: "Type into a field reliably via the ladder (focus + CDP Input.insertText trusted events + verify)." })),
					scroll: Type.Optional(Type.Object({ target: Type.Optional(Type.String({ description: "pi-ref:// or CSS selector of the scroll container. Omit to scroll the window." })), to: Type.Optional(Type.String({ description: "top | bottom | next | previous (default next)." })), steps: Type.Optional(Type.Number({ description: "Viewport steps for next/previous (default 1)." })) }, { description: "Scroll the window or a container reliably via the ladder (actionability + verify + virtualized-list collection)." })),
				}, { description: "Structured page action routed through the ABML degradation ladder instead of raw JS. Mutually exclusive with script. Provide exactly one of click/type/scroll. Use when an action must reliably take effect (e.g. sites that ignore synthetic events)." })),
			...sharedTabScopedToolParams(),
			monitor: Type.Optional(Type.Boolean({ description: "Capture compact before/after scan diff for JavaScript mode. Default false to avoid token and latency overhead." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runTool(async () => {
				const action = isRecord(params.action) ? params.action : undefined;
					const actionClick = action && typeof action.click === "string" ? action.click.trim() : "";
					const actionType = action && isRecord(action.type) ? action.type : undefined;
					const actionTypeTarget = actionType && typeof actionType.target === "string" ? actionType.target.trim() : "";
					const hasClick = actionClick.length > 0;
					const hasType = actionTypeTarget.length > 0 && typeof actionType?.text === "string";
					const actionScroll = action && isRecord(action.scroll) ? action.scroll : undefined;
						const hasScroll = !!actionScroll;
						const hasAction = hasClick || hasType || hasScroll;
					if ([hasClick, hasType, hasScroll].filter(Boolean).length > 1) throw new BrowserBridgeError("INVALID_RULE", "browser_execute action takes exactly one of click/type/scroll", { toolName: "browser_execute" });
					const hasScript = typeof params.script === "string" && params.script.trim().length > 0;
					if (hasScript && hasAction) throw new BrowserBridgeError("INVALID_RULE", "browser_execute takes either script or action, not both", { toolName: "browser_execute" });
					if (!hasScript && !hasAction) throw new BrowserBridgeError("INVALID_RULE", "browser_execute requires script (JavaScript) or action (structured page action)", { toolName: "browser_execute" });
				if (!hasAction && detectCommandLikeScript(params.script as string)) {
					throw new BrowserBridgeError("INVALID_RULE", "browser_execute only accepts JavaScript; use browser_command for bridge commands", { toolName: "browser_execute", recovery: { useTool: "browser_command" } });
				}
				const server = await ensureStarted();
				const timeoutMs = toolTimeoutMs(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const maxChars = toolMaxChars(params, "browser_execute");
				const browserSessionId = typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
				const tabId = normalizeTabId(params.tabId);
					if (hasAction) {
						const verb = hasClick ? "click" : hasType ? "type" : "scroll";
						const target = hasClick ? actionClick : hasType ? actionTypeTarget : (actionScroll && typeof actionScroll.target === "string" ? actionScroll.target.trim() : "");
						const ref = target ? actionTargetRef(target, { tabId, browserSessionId }) : undefined;
						const { result: actionResult, operation } = await withTrackedOperation(server, {
							toolName: "browser_execute",
							command: `action.${verb}`,
							browserSessionId,
							tabId,
							phase: "running",
							progress: 10,
							queueDepth: server.queueDepth(browserSessionId, tabId),
							leaseOwnerHash: server.leaseOwnerHash(browserSessionId, tabId),
						}, _onUpdate, async (handle) => {
							const abml = createBrowserAbmlIntegration(server, { browserSessionId, tabId, timeoutMs, maxChars });
							await handle.update({ progress: 55 });
							const res = hasClick ? await abml.runtime.click?.({ ref: ref as RefDescriptor | string }) : hasType ? await abml.runtime.type?.({ ref: ref as RefDescriptor | string, text: String(actionType?.text ?? ""), clear: actionType?.clear === true }) : await abml.runtime.scroll?.({ ref, to: (typeof actionScroll?.to === "string" ? actionScroll.to : undefined) as "top" | "bottom" | "next" | "previous" | undefined, steps: typeof actionScroll?.steps === "number" ? actionScroll.steps : undefined });
							if (!res) throw new BrowserBridgeError("BACKEND_UNAVAILABLE", `ABML ${verb} runtime unavailable`, { toolName: "browser_execute" });
							return res;
						});
						const transport = actionResult.ok ? (actionResult.data as Record<string, unknown> | undefined)?.transport : undefined;
						const verification = actionResult.ok ? actionResult.verification?.status : actionResult.error?.code;
						return await jsonToolResult(actionResult, params, ctx, {
							toolName: "browser_execute",
							command: `action.${verb}`,
							defaultDetailLevel: "summary",
							maxChars,
							fallbackName: artifactFallbackName("execute-action"),
							details: { mode: "action", action: verb, target, transport, verification },
							operation,
							artifactValue: { ...actionResult, operation },
						});
					}
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
						? await executeJavaScriptWithMonitor(server, params.script as string, { browserSessionId, tabId: params.tabId, timeoutMs })
						: await server.executeJavaScript(params.script as string, { browserSessionId, tabId: params.tabId, timeoutMs });
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
					artifactValue: { ...jsResult, operation },
					distill: (value) => {
						const base = { ...summarizeGenericValue(value), operationId: operation.operationId, sourceMode: operation.sourceMode } as Record<string, unknown>;
						const monitor = isRecord(value) && isRecord(value.monitor) ? value.monitor : undefined;
						if (monitor) {
							base.monitorSource = {
								before: monitor.beforeSource,
								after: monitor.afterSource,
								changed: monitor.changed,
								top_change: monitor.top_change,
								abmlIntegrated: monitor.beforeSource === "abml-read" || monitor.afterSource === "abml-read",
							};
						}
						return base;
					},
				});
			});
		},
	});
}
