import { Type } from "typebox";
import { suppressErrorStack } from "../utils/errors";
import { errorResult, jsonResult } from "../utils/toolResult";
import { asPositiveInt } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";

function tabsToolError(code: string, message: string, details: Record<string, unknown> = {}): Error {
	const error = new Error(message) as Error & { code?: string; details?: Record<string, unknown> };
	error.name = "BrowserTabsToolError";
	error.code = code;
	error.details = details;
	suppressErrorStack(error);
	return error;
}

function requireTabsActionTabId(action: string, value: unknown): number {
	const tabId = typeof value === "string" ? Number(value.trim()) : typeof value === "number" ? value : NaN;
	if (!Number.isInteger(tabId) || tabId <= 0) {
		throw tabsToolError("TAB_ID_REQUIRED", `browser_tabs ${action} requires a valid tabId`, { action, tabId: value });
	}
	return tabId;
}

function normalizeCreateTabUrl(value: unknown): string {
	const raw = typeof value === "string" ? value.trim() : "";
	if (!raw) return "about:blank";
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw tabsToolError("INVALID_TAB_URL", "browser_tabs create requires an absolute URL or about:blank", { url: value });
	}
	const protocol = parsed.protocol.toLowerCase();
	if (protocol === "javascript:") {
		throw tabsToolError("INVALID_TAB_URL", "browser_tabs create does not accept javascript: URLs; use browser_execute for JavaScript in an existing tab", { url: raw, protocol });
	}
	return parsed.href;
}

export function registerTabsTool({ pi, ensureStarted }: ToolRegistrarContext) {
	pi.registerTool({
		name: "browser_tabs",
		label: "Browser Tabs",
		description: "List, switch, create, close, or select a real browser connected through the Pi browser bridge.",
		promptSnippet: "Control connected browser tabs: list, switch, create, close, selectBrowser.",
		promptGuidelines: [
			"Start automation with browser_tabs list; use switch only when you intentionally change the browser active tab.",
			"Keep the target tabId and pass it explicitly to later tab-scoped browser_* calls.",
		],
		parameters: Type.Object({
			action: Type.String({ description: "One of: list, switch, create, close, selectBrowser" }),
			browserId: Type.Optional(Type.String({ description: "Browser client id or extension id for selectBrowser" })),
			tabId: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Target tab id for switch/close; use browser_tabs list to identify it first." })),
			url: Type.Optional(Type.String({ description: "URL for create" })),
			active: Type.Optional(Type.Boolean({ description: "Whether created tab should be active" })),
			timeoutMs: Type.Optional(Type.Number({ description: "Bridge timeout in milliseconds" })),
		}),
		async execute(_toolCallId, params) {
			try {
				const action = String(params.action || "").trim().toLowerCase();
				const timeoutMs = asPositiveInt(params.timeoutMs, 5_000);
				const tabId = action === "switch" || action === "close" ? requireTabsActionTabId(action, params.tabId) : undefined;
				const createUrl = action === "create" ? normalizeCreateTabUrl(params.url) : undefined;
				const server = await ensureStarted();
				if (action === "list") return jsonResult(await server.refreshTabs(timeoutMs), { action });
				if (action === "selectbrowser" || action === "browser" || action === "select") return jsonResult({ selected: server.selectBrowser(params.browserId || ""), snapshot: server.snapshot() }, { action });
				if (action === "switch") return jsonResult(await server.switchTab(tabId, timeoutMs), { action });
				if (action === "create") return jsonResult(await server.createTab(createUrl || "about:blank", params.active !== false, timeoutMs), { action });
				if (action === "close") return jsonResult(await server.closeTab(tabId, timeoutMs), { action });
				throw new Error(`Unsupported browser_tabs action: ${params.action}`);
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}
