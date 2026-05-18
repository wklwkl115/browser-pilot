import { Type } from "typebox";
import { buildScanScript } from "../scan/buildScanScript";
import type { BridgeCommand } from "../protocol/nativeProtocol";
import { compactError } from "../utils/errors";
import { errorResult } from "../utils/toolResult";
import { defaultResultBudget } from "./budgets";
import { distilledJsonResult } from "./resultMiddleware";
import { rejectUnsafeExecuteCommand } from "./transferValidation";
import { asPositiveInt, DEFAULT_TOOL_TIMEOUT_MS, DETAIL_LEVEL_DESCRIPTION, MAX_CHARS_DESCRIPTION, optionalTargetTabId, OUTPUT_PATH_DESCRIPTION, parseMaybeCommand, TAB_SCOPED_TOOL_GUIDELINE } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";

type MonitorScanResult = {
	ok: boolean;
	content?: string;
	error?: Record<string, unknown>;
};

type MonitorData = {
	execution: unknown;
	monitor: {
		beforeOk: boolean;
		afterOk: boolean;
		beforeChars: number;
		afterChars: number;
		changed: number;
		top_change?: string;
		beforeError?: Record<string, unknown>;
		afterError?: Record<string, unknown>;
		newTabs: unknown[];
	};
};

function textLines(value: unknown): string[] {
	return String(value || "").split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function diffScanContent(before: unknown, after: unknown): { changed: number; top_change?: string } {
	const beforeSet = new Set(textLines(before));
	const added = textLines(after).filter((line) => !beforeSet.has(line));
	return { changed: added.length, top_change: added[0]?.slice(0, 2_000) };
}

async function monitorScan(server: Awaited<ReturnType<ToolRegistrarContext["ensureStarted"]>>, scanScript: string, options: { tabId?: unknown; timeoutMs: number }): Promise<MonitorScanResult> {
	try {
		const result = await server.executeJavaScript(scanScript, { tabId: options.tabId as number | string | undefined, timeoutMs: options.timeoutMs });
		const content = (result.data as Record<string, unknown> | undefined)?.content;
		return { ok: true, content: typeof content === "string" ? content : undefined };
	} catch (error) {
		return { ok: false, error: compactError(error, "MONITOR_SCAN_FAILED") };
	}
}

async function executeJavaScriptWithMonitor(server: Awaited<ReturnType<ToolRegistrarContext["ensureStarted"]>>, script: string, options: { tabId?: unknown; timeoutMs: number }): Promise<MonitorData> {
	const monitorTimeoutMs = Math.min(Math.max(500, options.timeoutMs), 5_000);
	const scanScript = buildScanScript({ textOnly: false, maxChars: 50_000, maxNodes: 3_000 });
	const before = await monitorScan(server, scanScript, { tabId: options.tabId, timeoutMs: monitorTimeoutMs });
	const executed = await server.executeJavaScript(script, { tabId: options.tabId as number | string | undefined, timeoutMs: options.timeoutMs });
	const after = await monitorScan(server, scanScript, { tabId: options.tabId, timeoutMs: monitorTimeoutMs });
	const diff = before.ok && after.ok ? diffScanContent(before.content, after.content) : { changed: 0, top_change: undefined };
	return {
		execution: executed.data,
		monitor: {
			beforeOk: before.ok,
			afterOk: after.ok,
			beforeChars: typeof before.content === "string" ? before.content.length : 0,
			afterChars: typeof after.content === "string" ? after.content.length : 0,
			...diff,
			beforeError: before.error,
			afterError: after.error,
			newTabs: executed.newTabs || [],
		},
	};
}

export function registerExecuteTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_execute",
		label: "Browser Execute",
		description: "Execute JavaScript or a bridge command object in a connected real browser tab.",
		promptSnippet: "Execute JS in a real browser tab or send a bridge command object.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_execute for precise browser actions; return explicit values from async JavaScript."],
		parameters: Type.Object({
			script: Type.Optional(Type.String({ description: "JavaScript source. If it is a JSON object string with cmd, it is sent as a bridge command." })),
			command: Type.Optional(Type.Any({ description: "Bridge command object, e.g. {cmd:'tabs',method:'list'} or {cmd:'cdp',...}" })),
			tabId: optionalTargetTabId(),
			timeoutMs: Type.Optional(Type.Number({ description: "Bridge timeout in milliseconds" })),
			detailLevel: Type.Optional(Type.String({ description: DETAIL_LEVEL_DESCRIPTION })),
			outputPath: Type.Optional(Type.String({ description: OUTPUT_PATH_DESCRIPTION })),
			maxChars: Type.Optional(Type.Number({ description: MAX_CHARS_DESCRIPTION })),
			monitor: Type.Optional(Type.Boolean({ description: "For JavaScript mode only: capture compact before/after scan diff. Default false to avoid token and latency overhead." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const server = await ensureStarted();
				const timeoutMs = asPositiveInt(params.timeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
				const maxChars = asPositiveInt(params.maxChars, defaultResultBudget("browser_execute"));
				if (params.command && typeof params.command === "object") {
					const command = params.command as BridgeCommand;
					rejectUnsafeExecuteCommand(command);
					return await distilledJsonResult(await server.sendCommand(command, { tabId: params.tabId, timeoutMs }), {
						toolName: "browser_execute",
						command: String(command.cmd || "command"),
						detailLevel: params.detailLevel ?? "preview",
						maxChars,
						ctx,
						outputPath: params.outputPath,
						fallbackName: `execute-${Date.now()}.json`,
						details: { mode: "command" },
					});
				}
				if (!params.script) throw new Error("browser_execute requires script or command");
				const command = parseMaybeCommand(params.script);
				if (command?.cmd) {
					rejectUnsafeExecuteCommand(command);
					return await distilledJsonResult(await server.sendCommand(command, { tabId: params.tabId, timeoutMs }), {
					toolName: "browser_execute",
					command: String(command.cmd),
					detailLevel: params.detailLevel ?? "preview",
					maxChars,
					ctx,
					outputPath: params.outputPath,
					fallbackName: `execute-${Date.now()}.json`,
					details: { mode: "command" },
				});
				}
				const jsResult = params.monitor === true
					? await executeJavaScriptWithMonitor(server, params.script, { tabId: params.tabId, timeoutMs })
					: await server.executeJavaScript(params.script, { tabId: params.tabId, timeoutMs });
				return await distilledJsonResult(jsResult, {
					toolName: "browser_execute",
					command: "javascript",
					detailLevel: params.detailLevel ?? "preview",
					maxChars,
					ctx,
					outputPath: params.outputPath,
					fallbackName: `execute-${Date.now()}.json`,
					details: { mode: "javascript", monitor: params.monitor === true },
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}
