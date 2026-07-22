import { Type } from "typebox";
import { type NativeErrorCode } from "../types/nativeErrorCodes.js";
import { BrowserBridgeError } from "../utils/errors.js";
import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";
import { jsonResult } from "../utils/toolResult.js";
import { defineBrowserCommand, resolveLocalTargetTabId, runCommandHandler, sharedTabScopedToolParams } from "./commandRuntime.js";
import { compactBridgeForTabsList, compactTabForList, publicSnapshot } from "./tabsProjection.js";
import { strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";
import { withBrowserOperation } from "./browserOperation.js";
import type { ValidationIssue } from "./commandDefinition.js";

const TAB_TARGET_ACTIONS = new Set(["switch", "close"]);

function tabsToolError(code: NativeErrorCode, message: string, details: Record<string, unknown> = {}): BrowserBridgeError {
	return new BrowserBridgeError(code, message, details);
}

function requireTabsActionTargetRef(action: string, value: unknown): string {
	if (typeof value === "string" && value.trim()) return value.trim();
	throw tabsToolError("TAB_ID_REQUIRED", `browser_tabs ${action} requires a valid targetRef`, { action, targetRef: value });
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
	if (protocol === "javascript:" || protocol === "data:") {
		throw tabsToolError("INVALID_TAB_URL", "browser_tabs create does not accept javascript: or data: URLs; use browser_execute for JavaScript in an existing tab", { url: raw, protocol });
	}
	return parsed.href;
}

const TAB_ACTIONS = ["list", "switch", "create", "close", "selectBrowser"] as const;

function validateCreateTabArgument(args: Record<string, unknown>): ValidationIssue[] {
	if (args.action !== "create") return [];
	try {
		normalizeCreateTabUrl(args.url);
		return [];
	} catch (error) {
		return [{ code: "INVALID_TAB_URL", path: "/url", message: error instanceof Error ? error.message : String(error) }];
	}
}

export function validateTabsArguments(args: Record<string, unknown>): ValidationIssue[] {
	const action = typeof args.action === "string" ? args.action : "";
	if (!TAB_ACTIONS.includes(action as typeof TAB_ACTIONS[number])) return [{ code: "TABS_ACTION_UNKNOWN", path: "/action", message: `Unsupported browser_tabs action "${action}"; expected one of ${TAB_ACTIONS.join(", ")}` }];
	const issues: ValidationIssue[] = [];
	if (["switch", "close"].includes(action) && args.targetRef === undefined) issues.push({ code: "TAB_ID_REQUIRED", path: "/targetRef", message: `browser_tabs ${action} requires targetRef` });
	issues.push(...validateCreateTabArgument(args));
	const allowedByAction: Record<string, Set<string>> = {
		create: new Set(["url", "active", "incognito"]),
		selectBrowser: new Set(["browserId"]),
	};
	const actionOnly = ["url", "active", "incognito", "browserId"];
	const allowed = allowedByAction[action] ?? new Set<string>();
	for (const key of actionOnly) if (args[key] !== undefined && !allowed.has(key)) issues.push({ code: "TABS_ARGUMENT_NOT_ALLOWED", path: `/${key}`, message: `Argument "${key}" is not valid for browser_tabs action ${action}` });
	if (action === "selectBrowser" && (typeof args.browserId !== "string" || !args.browserId.trim())) issues.push({ code: "TABS_BROWSER_ID_REQUIRED", path: "/browserId", message: "browser_tabs selectBrowser requires browserId" });
	return issues;
}

function publicTabsSnapshot(server: BrowserCommandRuntimePort): Record<string, unknown> {
	return publicSnapshot(server.snapshot() as unknown as Record<string, unknown>);
}

export function defineTabsCommand({ commands, ensureStarted }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_tabs",
		label: "Browser Tabs",
		description: "List, switch, create, close, or select the browser that owns a tab.",
		promptSnippet: "Control connected browser tabs and select among connected browser instances.",
		promptGuidelines: [
			"Omit browser_tabs when the selected active tab is already the intended target; use list only to inspect or disambiguate tabs, and switch only to intentionally change the browser active tab.",
			"Reuse the returned targetRef for later tab-scoped browser_* calls.",
			"Use selectBrowser only when multiple connected browser instances make tab ownership ambiguous.",
		],
		parameters: strictCommandParameters({
			action: Type.String({ enum: [...TAB_ACTIONS], description: "list | switch | create | close | selectBrowser" }),
			...sharedTabScopedToolParams("Stable tabHandle for switch or close."),
			browserId: Type.Optional(Type.String({ description: "Browser client id or extension id for selectBrowser" })),
			url: Type.Optional(Type.String({ description: "URL for create" })),
			active: Type.Optional(Type.Boolean({ description: "Whether created tab should be active" })),
			incognito: Type.Optional(Type.Boolean({ description: "create only: open in a fresh incognito window (isolated cookie jar = logged-out session). Requires the extension to be allowed in incognito at chrome://extensions; if not, returns a recovery hint." })),
		}),
		validateArguments: validateTabsArguments,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return await runCommandHandler(async () => {
				const action = String(params.action || "").trim().toLowerCase();
				const timeoutMs = 5_000;
				const tabRef = TAB_TARGET_ACTIONS.has(action) ? requireTabsActionTargetRef(action, params.targetRef) : undefined;
				const createUrl = action === "create" ? normalizeCreateTabUrl(params.url) : undefined;
				const server = await ensureStarted();
				const omitTransportDetails = (ctx as { omitTransportDetails?: boolean } | undefined)?.omitTransportDetails === true;
				const detailsForTransport = (build: () => Record<string, unknown>): Record<string, unknown> => omitTransportDetails ? {} : build();
				if (action === "list") {
					const tabs = await server.refreshTabs(timeoutMs);
					const snapshot = server.snapshot();
					const compactTabs = tabs.map((tab) => compactTabForList(tab as Record<string, unknown>));
					return jsonResult({ tabs: compactTabs, tabCount: tabs.length, bridge: compactBridgeForTabsList(snapshot as Record<string, unknown>) }, detailsForTransport(() => ({ action, snapshot, observationSnapshots: server.listObservationSnapshots().length })));
				}
				if (action === "selectbrowser") {
					const browserId = String(params.browserId || "");
					return jsonResult({ selected: server.selectBrowser(browserId), snapshot: publicTabsSnapshot(server) }, { action });
				}
				if (["switch", "create", "close"].includes(action)) {
					const trackedTabId = action === "create" ? undefined : resolveLocalTargetTabId(server, tabRef);
					const result = await withBrowserOperation({
						server,
						tabId: trackedTabId,
						timeoutMs,
						signal,
					}, async ({ signal: operationSignal }) => {
						if (action === "switch") return await server.switchTab(tabRef!, timeoutMs, { signal: operationSignal });
						if (action === "create") return await server.createTab(createUrl || "about:blank", params.active !== false, timeoutMs, { incognito: params.incognito === true, signal: operationSignal });
						return await server.closeTab(tabRef!, timeoutMs, { signal: operationSignal });
					});
					return jsonResult(result, { action });
				}
				throw tabsToolError("INVALID_RULE", `Unsupported browser_tabs action: ${params.action}`, { action: params.action });
			});
		},
	});
}
