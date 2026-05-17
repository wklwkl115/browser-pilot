import { Type } from "typebox";
import { errorResult, jsonResult } from "../utils/toolResult";
import { asPositiveInt } from "./toolShared";
import type { ToolRegistrarContext } from "./toolShared";

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
				const server = await ensureStarted();
				const action = params.action.trim().toLowerCase();
				const timeoutMs = asPositiveInt(params.timeoutMs, 5_000);
				if (action === "list") return jsonResult(await server.refreshTabs(timeoutMs), { action });
				if (action === "selectbrowser" || action === "browser" || action === "select") return jsonResult({ selected: server.selectBrowser(params.browserId || ""), snapshot: server.snapshot() }, { action });
				if (action === "switch") return jsonResult(await server.switchTab(params.tabId ?? "", timeoutMs), { action });
				if (action === "create") return jsonResult(await server.createTab(params.url || "about:blank", params.active !== false, timeoutMs), { action });
				if (action === "close") return jsonResult(await server.closeTab(params.tabId ?? "", timeoutMs), { action });
				throw new Error(`Unsupported browser_tabs action: ${params.action}`);
			} catch (error) {
				return errorResult(error);
			}
		},
	});
}
