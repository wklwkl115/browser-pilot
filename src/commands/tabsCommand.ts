import { Type } from "typebox";
import { type NativeErrorCode } from "../types/nativeErrorCodes.js";
import { BrowserBridgeError } from "../utils/errors.js";
import { defaultLeaseIdRedactor } from "../kernels/session/leaseRegistry.js";
import type { BrowserCommandRuntimePort, CommandTabLeaseInfo as BrowserTabLeaseInfo } from "../ports/BrowserCommandRuntimePort.js";
import { jsonResult } from "../utils/toolResult.js";
import { defineBrowserCommand, resolveLocalTargetTabId, runCommandHandler, sharedTabScopedToolParams, commandTimeoutMs } from "./commandRuntime.js";
import { compactBridgeForTabsList, compactTabForList, publicSnapshot } from "./tabsProjection.js";
import { asPositiveInt, strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";
import { withBrowserOperation } from "./browserOperation.js";
import { browserOperationCommandResult } from "./browserOperationResult.js";
import type { ValidationIssue } from "./commandDefinition.js";

const TAB_TARGET_ACTIONS = new Set(["switch", "close", "attachtab", "detachtab", "leasetab", "releasetab"]);
const SNAPSHOT_NOT_FOUND_RECOVERY = { nextActions: ["browser-pilot observe --json", "browser-pilot tabs --action snapshot --json"] };
const SNAPSHOT_EXPIRED_RECOVERY = { nextActions: ["browser-pilot tabs --action snapshot --allow-expired --snapshot-id <snapshotId> --json", "browser-pilot artifact inspect --path <saved.path> --json", "browser-pilot observe --json"] };

type BrowserSessionOptions = { browserSessionId: string | undefined };
type TabsDetails = (build: () => Record<string, unknown>) => Record<string, unknown>;

function tabsToolError(code: NativeErrorCode, message: string, details: Record<string, unknown> = {}): BrowserBridgeError {
	return new BrowserBridgeError(code, message, details);
}

function requireTabsActionTargetRef(action: string, value: unknown): number | string {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
	if (typeof value === "string" && value.trim()) return value.trim();
	throw tabsToolError("TAB_ID_REQUIRED", `browser_tabs ${action} requires a valid targetRef or tabId`, { action, targetRef: value });
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

const TAB_ACTIONS = ["list", "snapshot", "switch", "create", "close", "selectBrowser", "listSessions", "createSession", "selectSession", "closeSession", "attachTab", "detachTab", "leaseTab", "releaseTab"] as const;

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
	const targetProvided = args.targetRef !== undefined || args.tabId !== undefined;
	if (args.targetRef !== undefined && args.tabId !== undefined) issues.push({ code: "TARGET_ARGUMENT_CONFLICT", path: "/", message: "browser_tabs accepts targetRef or tabId, not both" });
	if (["switch", "close", "attachTab", "detachTab", "leaseTab", "releaseTab"].includes(action) && !targetProvided) issues.push({ code: "TAB_ID_REQUIRED", path: "/", message: `browser_tabs ${action} requires targetRef or tabId` });
	issues.push(...validateCreateTabArgument(args));
	if (action === "snapshot" && args.allowExpired !== undefined && args.snapshotId === undefined) issues.push({ code: "TABS_SNAPSHOT_OPTION_CONFLICT", path: "/allowExpired", message: "browser_tabs allowExpired requires snapshotId" });
	const allowedByAction: Record<string, Set<string>> = {
		list: new Set(["includeBridgePerTab"]),
		snapshot: new Set(["snapshotId", "allowExpired"]),
		create: new Set(["url", "active", "incognito"]),
		createSession: new Set(["name"]),
		selectBrowser: new Set(["browserId"]),
		attachTab: new Set(["browserId"]),
	};
	const actionOnly = ["includeBridgePerTab", "snapshotId", "allowExpired", "url", "active", "incognito", "name", "browserId"];
	const allowed = allowedByAction[action] ?? new Set<string>();
	for (const key of actionOnly) if (args[key] !== undefined && !allowed.has(key)) issues.push({ code: "TABS_ARGUMENT_NOT_ALLOWED", path: `/${key}`, message: `Argument "${key}" is not valid for browser_tabs action ${action}` });
	if (action === "selectBrowser" && (typeof args.browserId !== "string" || !args.browserId.trim())) issues.push({ code: "TABS_BROWSER_ID_REQUIRED", path: "/browserId", message: "browser_tabs selectBrowser requires browserId" });
	return issues;
}

function stringParam(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }

function publicTabsSnapshot(server: BrowserCommandRuntimePort, browserSession: BrowserSessionOptions): Record<string, unknown> {
	return publicSnapshot(server.snapshot(browserSession) as unknown as Record<string, unknown>);
}

function tabsSnapshotResult(server: BrowserCommandRuntimePort, params: Record<string, unknown>, browserSession: BrowserSessionOptions, detailsForTransport: TabsDetails, maxChars: number) {
	const snapshotId = typeof params.snapshotId === "string" && params.snapshotId.trim() ? params.snapshotId : undefined;
	if (!snapshotId) return jsonResult({ bridge: publicTabsSnapshot(server, browserSession), observationSnapshots: server.listObservationSnapshots() }, detailsForTransport(() => ({ action: "snapshot" })), maxChars);
	const snapshot = server.getObservationSnapshot(snapshotId);
	if (!snapshot) throw tabsToolError("INVALID_RULE", "browser_tabs snapshotId was not found", { snapshotId, reason: "snapshot_not_found", recovery: SNAPSHOT_NOT_FOUND_RECOVERY });
	if (snapshot.expired && params.allowExpired !== true) throw tabsToolError("INVALID_RULE", "browser_tabs snapshotId is stale; read the saved artifact explicitly or pass allowExpired:true", {
		snapshotId: snapshot.snapshotId,
		invalidatedReason: snapshot.invalidatedReason,
		saved: snapshot.saved,
		reason: "snapshot_expired",
		recovery: SNAPSHOT_EXPIRED_RECOVERY,
	});
	return jsonResult({ snapshot, bridge: publicTabsSnapshot(server, browserSession) }, detailsForTransport(() => ({ action: "snapshot" })), maxChars);
}

function advancedTabsResult(server: BrowserCommandRuntimePort, action: string, params: Record<string, unknown>, tabRef: number | string | undefined, browserSession: BrowserSessionOptions) {
	switch (action) {
		case "listsessions": return jsonResult({ sessions: server.listBrowserSessions() }, { action });
		case "createsession": return jsonResult({ session: server.createBrowserSession(stringParam(params.name)) }, { action });
		case "selectsession": return jsonResult({ session: server.selectBrowserSession(stringParam(params.browserSessionId) || ""), snapshot: publicTabsSnapshot(server, browserSession) }, { action });
		case "closesession": return jsonResult({ closed: server.closeBrowserSession(stringParam(params.browserSessionId) || ""), sessions: server.listBrowserSessions() }, { action });
		case "attachtab": return jsonResult({ tab: server.attachTabToBrowserSession(tabRef!, { ...browserSession, browserId: stringParam(params.browserId) }), session: publicTabsSnapshot(server, browserSession) }, { action });
		case "detachtab": return jsonResult({ session: server.detachTabFromBrowserSession(tabRef!, browserSession) }, { action });
		case "leasetab": return jsonResult({ lease: defaultLeaseIdRedactor.tabLease(server.leaseTab(tabRef!, browserSession) as BrowserTabLeaseInfo), session: publicTabsSnapshot(server, browserSession) }, { action });
		case "releasetab": {
			const released = server.releaseTab(tabRef!, browserSession);
			return jsonResult({ released: released ? defaultLeaseIdRedactor.tabLease(released as BrowserTabLeaseInfo) : undefined, session: publicTabsSnapshot(server, browserSession) }, { action });
		}
		case "selectbrowser":
		case "browser":
		case "select":
			return jsonResult({ selected: server.selectBrowser(stringParam(params.browserId) || "", browserSession), snapshot: publicTabsSnapshot(server, browserSession) }, { action });
		default: return undefined;
	}
}

export function defineTabsCommand({ commands, ensureStarted }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_tabs",
		label: "Browser Tabs",
		description: "List, switch, create, close, or snapshot browser tabs; advanced actions manage scoped browser sessions and tab leases through the Browser Pilot bridge.",
		promptSnippet: "Control connected browser tabs. Common: list, snapshot, switch, create, close. Advanced (browser session & lease lifecycle — rarely needed): selectBrowser, listSessions, createSession, selectSession, closeSession, attachTab, detachTab, leaseTab, releaseTab.",
		promptGuidelines: [
			"Start automation with browser_tabs list unless browser_tabs create just returned id/targetRef; use switch only when you intentionally change the browser active tab.",
			"Prefer the returned id/targetRef/tabHandle for later tab-scoped browser_* calls; numeric tabId remains compatibility input.",
			"Everyday tab control is list/switch/create/close/snapshot; the session & lease actions (selectBrowser/listSessions/createSession/selectSession/closeSession/attachTab/detachTab/leaseTab/releaseTab) are advanced multi-agent isolation/coordination — skip them unless you are managing browser sessions or tab leases.",
		],
		cliSubcommands: [{ token: "list", parameter: "action", value: "list" }],
		parameters: strictCommandParameters({
			action: Type.String({ description: "Common: list, snapshot, switch, create, close. Advanced (session & lease lifecycle): selectBrowser, listSessions, createSession, selectSession, closeSession, attachTab, detachTab, leaseTab, releaseTab" }),
			...sharedTabScopedToolParams({ tabIdDescription: "Compatibility target for switch/close: numeric tabId or tabHandle string.", targetRefDescription: "Preferred stable tabHandle for switch/close/attach/detach/lease/release." }),
			name: Type.Optional(Type.String({ description: "Browser session display name for createSession." })),
			browserId: Type.Optional(Type.String({ description: "Browser client id or extension id for selectBrowser" })),
			snapshotId: Type.Optional(Type.String({ description: "Optional observation snapshot id for browser_tabs action=snapshot." })),
			allowExpired: Type.Optional(Type.Boolean({ description: "browser_tabs action=snapshot only: allow returning expired observation snapshot metadata." })),
			includeBridgePerTab: Type.Optional(Type.Boolean({ description: "browser_tabs action=list only: advanced compatibility; include the repeated per-tab bridge block. Default false keeps tabs compact and hoists bridge to top-level." })),
			url: Type.Optional(Type.String({ description: "URL for create" })),
			active: Type.Optional(Type.Boolean({ description: "Whether created tab should be active" })),
				incognito: Type.Optional(Type.Boolean({ description: "create only: open in a fresh incognito window (isolated cookie jar = logged-out session). Requires the extension to be allowed in incognito at chrome://extensions; if not, returns a recovery hint." })),
		}),
		validateArguments: validateTabsArguments,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runCommandHandler(async () => {
				const action = String(params.action || "").trim().toLowerCase();
				const timeoutMs = commandTimeoutMs(params.timeoutMs, 5_000);
				const maxChars = asPositiveInt(params.maxChars, 50_000);
				const tabRef = TAB_TARGET_ACTIONS.has(action) ? requireTabsActionTargetRef(action, params.targetRef ?? params.tabId) : undefined;
				const createUrl = action === "create" ? normalizeCreateTabUrl(params.url) : undefined;
				const server = await ensureStarted();
				const browserSession = { browserSessionId: stringParam(params.browserSessionId) };
				const omitTransportDetails = (ctx as { omitTransportDetails?: boolean } | undefined)?.omitTransportDetails === true;
				const detailsForTransport = (build: () => Record<string, unknown>): Record<string, unknown> => omitTransportDetails ? {} : build();
				if (action === "list") {
					const tabs = await server.refreshTabs(timeoutMs, browserSession);
					const snapshot = server.snapshot(browserSession);
					const compactTabs = params.includeBridgePerTab === true ? tabs : tabs.map((tab) => compactTabForList(tab as Record<string, unknown>));
					return jsonResult({ tabs: compactTabs, tabCount: tabs.length, bridge: compactBridgeForTabsList(snapshot as Record<string, unknown>) }, detailsForTransport(() => ({ action, snapshot, observationSnapshots: server.listObservationSnapshots().length })), maxChars);
				}
				if (action === "snapshot") return tabsSnapshotResult(server, params, browserSession, detailsForTransport, maxChars);
				const advanced = advancedTabsResult(server, action, params, tabRef, browserSession);
				if (advanced) return advanced;
				if (["switch", "create", "close"].includes(action)) {
					const trackedTabId = action === "create" ? undefined : resolveLocalTargetTabId(server, tabRef, browserSession.browserSessionId);
					const outcome = await withBrowserOperation({
						server,
						commandName: "browser_tabs",
						command: action,
						action,
						browserSessionId: browserSession.browserSessionId,
						tabId: trackedTabId,
						targetRef: typeof tabRef === "string" ? tabRef : undefined,
						timeoutMs,
						ctx,
						onUpdate: _onUpdate,
					}, async () => {
						if (action === "switch") return await server.switchTab(tabRef!, timeoutMs, browserSession);
						if (action === "create") return await server.createTab(createUrl || "about:blank", params.active !== false, timeoutMs, { ...browserSession, incognito: params.incognito === true });
						return await server.closeTab(tabRef!, timeoutMs, browserSession);
					});
					return await browserOperationCommandResult(outcome, {
						budgetName: "browser_tabs",
						maxChars,
						ctx,
						details: { action, operationId: outcome.operationId, status: outcome.status },
					});
				}
				throw tabsToolError("INVALID_RULE", `Unsupported browser_tabs action: ${params.action}`, { action: params.action });
			});
		},
	});
}
