import { Type } from "typebox";
import { type NativeErrorCode } from "../types/nativeErrorCodes.js";
import { BrowserBridgeError } from "../utils/errors.js";
import { jsonResult } from "../utils/toolResult.js";
import {
	defineBrowserCommand,
	pinTabExecutionTarget,
	resolveLocalTargetTabId,
	runCommandHandler,
	sharedTabScopedToolParams,
} from "./commandRuntime.js";
import { compactTabForList } from "./tabsProjection.js";
import { DEFAULT_TOOL_TIMEOUT_MS, strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";
import { withBrowserOperation } from "./browserOperation.js";
import { withCommandEffect } from "./commandEffect.js";
import type { ValidationIssue } from "./commandDefinition.js";
import { isRecord } from "../utils/records.js";
import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";

const TAB_TARGET_ACTIONS = new Set(["switch", "close"]);
const NAVIGATE_WAIT_STATES = ["domcontentloaded", "load", "complete", "networkidle"] as const;
/** Leave the extension-side wait a margin so a slow load reports NAVIGATION_TIMEOUT instead of a bridge timeout. */
const NAVIGATE_WAIT_MARGIN_MS = 1_500;

function tabsToolError(
	code: NativeErrorCode,
	message: string,
	details: Record<string, unknown> = {},
): BrowserBridgeError {
	return new BrowserBridgeError(code, message, details);
}

function requireTabsActionTargetRef(action: string, value: unknown): string {
	if (typeof value === "string" && value.trim()) return value.trim();
	throw tabsToolError("TAB_ID_REQUIRED", `browser_tabs ${action} requires a valid targetRef`, {
		action,
		targetRef: value,
	});
}

function normalizeTabUrl(action: "create" | "navigate", value: unknown): string {
	const raw = typeof value === "string" ? value.trim() : "";
	if (!raw) {
		if (action === "create") return "about:blank";
		throw tabsToolError("INVALID_TAB_URL", "browser_tabs navigate requires an absolute URL", { url: value });
	}
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw tabsToolError("INVALID_TAB_URL", `browser_tabs ${action} requires an absolute URL or about:blank`, {
			url: value,
		});
	}
	const protocol = parsed.protocol.toLowerCase();
	if (protocol === "javascript:" || protocol === "data:") {
		throw tabsToolError(
			"INVALID_TAB_URL",
			`browser_tabs ${action} does not accept javascript: or data: URLs; use browser_execute for JavaScript in an existing tab`,
			{ url: raw, protocol },
		);
	}
	return parsed.href;
}

async function navigateTab(
	server: BrowserCommandRuntimePort,
	params: { targetRef?: string; url: string; waitUntil?: string },
	signal: AbortSignal | undefined,
): Promise<{ tabs: Record<string, unknown>[]; effect: unknown }> {
	const timeoutMs = DEFAULT_TOOL_TIMEOUT_MS;
	const explicitTabId = resolveLocalTargetTabId(server, params.targetRef);
	const target = pinTabExecutionTarget(server, {
		rawTarget: params.targetRef,
		tabId: explicitTabId,
	});
	if (target.tabId === undefined)
		throw tabsToolError(
			"NO_TAB",
			"browser_tabs navigate needs a connected tab; pass targetRef or open one first",
			{},
		);
	const tabId = target.tabId;
	const outcome = await withBrowserOperation(
		{ server, browserSessionId: target.browserSessionId, tabId, targetRef: target.rawTarget, timeoutMs, signal },
		async ({ signal: operationSignal, deadlineAt }) =>
			await withCommandEffect(
				server,
				{ browserSessionId: target.browserSessionId, tabId, timeoutMs, deadlineAt, signal: operationSignal },
				() =>
					server.sendCommand(
						{
							cmd: "wait.navigateAndWait",
							url: params.url,
							waitUntil: params.waitUntil ?? "load",
							timeoutMs: Math.max(500, timeoutMs - NAVIGATE_WAIT_MARGIN_MS),
						},
						{
							browserSessionId: target.browserSessionId,
							tabId: target.rawTarget,
							timeoutMs,
							accessMode: "write",
							internal: true,
							signal: operationSignal,
						},
					),
			),
	);
	const refreshed = await server
		.refreshTabs(5_000, { browserSessionId: target.browserSessionId, signal })
		.catch(() => server.getTabs());
	const live = refreshed.find((tab) => tab.tabId === tabId) as Record<string, unknown> | undefined;
	const tab = compactTabForList({
		...(live ?? {}),
		...(params.targetRef ? { targetRef: params.targetRef } : {}),
		...(typeof live?.url !== "string" ? { url: params.url } : {}),
	});
	return { tabs: [tab], effect: outcome.effect };
}

function changedTab(result: unknown, targetRef?: string): Record<string, unknown> | undefined {
	if (!isRecord(result)) return targetRef ? { targetRef } : undefined;
	const data = isRecord(result.data) ? result.data : {};
	const createdTarget = isRecord(result.createdTarget) ? result.createdTarget : {};
	const created = isRecord(result.createdTab) ? result.createdTab : {};
	const tab = compactTabForList({ ...data, ...createdTarget, ...created, ...(targetRef ? { targetRef } : {}) });
	return Object.keys(tab).length ? tab : undefined;
}

const TAB_ACTIONS = ["list", "switch", "create", "close", "navigate"] as const;

function validateTabUrlArgument(args: Record<string, unknown>): ValidationIssue[] {
	if (args.action !== "create" && args.action !== "navigate") return [];
	try {
		normalizeTabUrl(args.action, args.url);
		return [];
	} catch (error) {
		return [
			{ code: "INVALID_TAB_URL", path: "/url", message: error instanceof Error ? error.message : String(error) },
		];
	}
}

export function validateTabsArguments(args: Record<string, unknown>): ValidationIssue[] {
	const action = typeof args.action === "string" ? args.action : "";
	if (!TAB_ACTIONS.includes(action as (typeof TAB_ACTIONS)[number]))
		return [
			{
				code: "TABS_ACTION_UNKNOWN",
				path: "/action",
				message: `Unsupported browser_tabs action "${action}"; expected one of ${TAB_ACTIONS.join(", ")}`,
			},
		];
	const issues: ValidationIssue[] = [];
	if (["switch", "close"].includes(action) && args.targetRef === undefined)
		issues.push({
			code: "TAB_ID_REQUIRED",
			path: "/targetRef",
			message: `browser_tabs ${action} requires targetRef`,
		});
	issues.push(...validateTabUrlArgument(args));
	const allowedByAction: Record<string, Set<string>> = {
		create: new Set(["url", "active", "incognito"]),
		navigate: new Set(["url", "waitUntil"]),
	};
	const actionOnly = ["url", "active", "incognito", "waitUntil"];
	const allowed = allowedByAction[action] ?? new Set<string>();
	for (const key of actionOnly)
		if (args[key] !== undefined && !allowed.has(key))
			issues.push({
				code: "TABS_ARGUMENT_NOT_ALLOWED",
				path: `/${key}`,
				message: `Argument "${key}" is not valid for browser_tabs action ${action}`,
			});
	return issues;
}

export function defineTabsCommand({ commands, ensureStarted }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_tabs",
		label: "Browser Tabs",
		description: "List, switch, create, close, or navigate connected browser tabs.",
		promptGuidelines: [
			"Omit browser_tabs when the selected active tab is already the intended target; use list only to inspect or disambiguate tabs, and switch only to intentionally change the browser active tab.",
			"Use navigate to load a URL in the selected (or targetRef) tab; it waits for waitUntil (default load) and returns the navigation effect. Prefer it over location.href in browser_execute.",
			"Reuse the returned targetRef for later tab-scoped browser_* calls.",
		],
		parameters: strictCommandParameters({
			action: Type.Enum(TAB_ACTIONS, { description: "list | switch | create | close | navigate" }),
			...sharedTabScopedToolParams("targetRef returned by list; required for switch or close."),
			url: Type.Optional(Type.String({ description: "URL for create or navigate" })),
			waitUntil: Type.Optional(
				Type.Enum(NAVIGATE_WAIT_STATES, {
					description: "navigate only: load state to wait for (default load).",
				}),
			),
			active: Type.Optional(Type.Boolean({ description: "Whether created tab should be active" })),
			incognito: Type.Optional(
				Type.Boolean({
					description:
						"create only: open in a fresh incognito window (isolated cookie jar = logged-out session). Requires the extension to be allowed in incognito at chrome://extensions; if not, returns a recovery hint.",
				}),
			),
		}),
		validateArguments: validateTabsArguments,
		async execute(params, signal) {
			return await runCommandHandler(async () => {
				const action = String(params.action || "")
					.trim()
					.toLowerCase();
				const timeoutMs = 5_000;
				const tabRef = TAB_TARGET_ACTIONS.has(action)
					? requireTabsActionTargetRef(action, params.targetRef)
					: undefined;
				const createUrl = action === "create" ? normalizeTabUrl("create", params.url) : undefined;
				const server = await ensureStarted();
				if (action === "navigate") {
					const navigated = await navigateTab(
						server,
						{
							targetRef: params.targetRef,
							url: normalizeTabUrl("navigate", params.url),
							waitUntil: params.waitUntil,
						},
						signal,
					);
					return jsonResult(navigated, { action });
				}
				if (action === "list") {
					const tabs = await server.refreshTabs(timeoutMs, { signal });
					const compactTabs = tabs.map((tab) => compactTabForList(tab as Record<string, unknown>));
					return jsonResult({ tabs: compactTabs });
				}
				if (["switch", "create", "close"].includes(action)) {
					const trackedTabId = action === "create" ? undefined : resolveLocalTargetTabId(server, tabRef);
					const result = await withBrowserOperation(
						{
							server,
							tabId: trackedTabId,
							targetRef: tabRef,
							timeoutMs,
							signal,
						},
						async ({ signal: operationSignal }) => {
							if (action === "switch")
								return await server.switchTab(tabRef!, timeoutMs, { signal: operationSignal });
							if (action === "create")
								return await server.createTab(
									createUrl || "about:blank",
									params.active !== false,
									timeoutMs,
									{ incognito: params.incognito === true, signal: operationSignal },
								);
							return await server.closeTab(tabRef!, timeoutMs, { signal: operationSignal });
						},
					);
					const tab =
						action === "close" ? undefined : changedTab(result, action === "switch" ? tabRef : undefined);
					return jsonResult({ tabs: tab ? [tab] : [] }, { action });
				}
				throw tabsToolError("INVALID_RULE", `Unsupported browser_tabs action: ${params.action}`, {
					action: params.action,
				});
			});
		},
	});
}
