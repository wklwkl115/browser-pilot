import { Type } from "typebox";
import { type NativeErrorCode } from "../protocol/nativeErrorCodes.js";
import { BrowserBridgeError } from "../driver/errors.js";
import { defaultLeaseIdRedactor } from "../driver/leaseDiagnostics.js";
import type { BrowserTabLeaseInfo, BrowserUiLockInfo } from "../driver/types.js";
import { jsonResult } from "../utils/toolResult.js";
import { defineBrowserTool, runTool, sharedTabScopedToolParams, toolTimeoutMs } from "./toolAdapter.js";
import { asPositiveInt, strictToolParameters } from "./toolShared.js";
import type { ToolRegistrarContext } from "./toolShared.js";

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

function compactTabForList(tab: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of ["id", "browserId", "browserSessionId", "tabId", "tabHandle", "targetRef", "logicalTabId", "generation", "url", "title", "active", "windowId", "openerTabId", "incognito", "type", "connectedAt", "replacedFromTabId", "replacedAt", "activatedAt"]) {
		if (tab[key] !== undefined) out[key] = tab[key];
	}
	return out;
}

function compactBridgeForTabsList(snapshot: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of ["browserSessionId", "host", "port", "running", "connectedClients", "extensionConnected", "extension", "defaultTabId", "defaultTabHandle", "latestTabId", "latestTabHandle", "selectionVersion"]) {
		if (snapshot[key] !== undefined) out[key] = snapshot[key];
	}
	return out;
}

function publicSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
	const now = Date.now();
	const leases = Array.isArray(snapshot.leases) ? snapshot.leases.map((lease) => defaultLeaseIdRedactor.tabLease(lease as BrowserTabLeaseInfo, undefined, now)) : undefined;
	const uiLock = snapshot.uiLock && typeof snapshot.uiLock === "object" ? defaultLeaseIdRedactor.uiLock(snapshot.uiLock as BrowserUiLockInfo, undefined, now) : undefined;
	return {
		...snapshot,
		...(leases ? { leases } : {}),
		...(uiLock ? { uiLock } : {}),
	};
}

export function registerTabsTool({ pi, ensureStarted }: ToolRegistrarContext) {
	defineBrowserTool(pi, {
		name: "browser_tabs",
		label: "Browser Tabs",
		description: "List, switch, create, close, select a real browser, or manage browser sessions connected through the Pi browser bridge.",
		promptSnippet: "Control connected browser tabs and scoped browser sessions: list, snapshot, switch, create, close, selectBrowser, listSessions, createSession, selectSession, closeSession, attachTab, detachTab, leaseTab, releaseTab.",
		promptGuidelines: [
			"Start automation with browser_tabs list; use switch only when you intentionally change the browser active tab.",
			"Prefer the returned tabHandle as targetRef for later tab-scoped browser_* calls; numeric tabId remains compatibility input.",
		],
		parameters: strictToolParameters({
			action: Type.String({ description: "One of: list, snapshot, switch, create, close, selectBrowser, listSessions, createSession, selectSession, closeSession, attachTab, detachTab, leaseTab, releaseTab" }),
			...sharedTabScopedToolParams({ includeBrowserSessionId: true, tabIdDescription: "Compatibility target for switch/close: numeric tabId or tabHandle string.", targetRefDescription: "Preferred stable tabHandle for switch/close/attach/detach/lease/release." }),
			name: Type.Optional(Type.String({ description: "Browser session display name for createSession." })),
			browserId: Type.Optional(Type.String({ description: "Browser client id or extension id for selectBrowser" })),
			snapshotId: Type.Optional(Type.String({ description: "Optional observation snapshot id for browser_tabs action=snapshot." })),
			allowExpired: Type.Optional(Type.Boolean({ description: "browser_tabs action=snapshot only: allow returning expired observation snapshot metadata." })),
			includeBridgePerTab: Type.Optional(Type.Boolean({ description: "browser_tabs action=list only: advanced compatibility; include the repeated per-tab bridge block. Default false keeps tabs compact and hoists bridge to top-level." })),
			url: Type.Optional(Type.String({ description: "URL for create" })),
			active: Type.Optional(Type.Boolean({ description: "Whether created tab should be active" })),
				incognito: Type.Optional(Type.Boolean({ description: "create only: open in a fresh incognito window (isolated cookie jar = logged-out session). Requires the extension to be allowed in incognito at chrome://extensions; if not, returns a recovery hint." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runTool(async () => {
				const action = String(params.action || "").trim().toLowerCase();
				const timeoutMs = toolTimeoutMs(params.timeoutMs, 5_000);
				// Honor maxChars on the sizable outputs (tab list / observation snapshots); detailLevel and
				// redact are accepted for cross-tool consistency but are no-ops here (tab metadata is a small,
				// non-secret JSON list, not a distilled/redacted summary).
				const maxChars = asPositiveInt(params.maxChars, 50_000);
				const tabRef = action === "switch" || action === "close" || action === "attachtab" || action === "detachtab" || action === "leasetab" || action === "releasetab" ? requireTabsActionTargetRef(action, params.targetRef ?? params.tabId) : undefined;
				const createUrl = action === "create" ? normalizeCreateTabUrl(params.url) : undefined;
				const server = await ensureStarted();
				const browserSession = { browserSessionId: typeof params.browserSessionId === "string" ? params.browserSessionId : undefined };
				const omitTransportDetails = (ctx as { omitTransportDetails?: boolean } | undefined)?.omitTransportDetails === true;
				const detailsForTransport = (build: () => Record<string, unknown>): Record<string, unknown> => omitTransportDetails ? {} : build();
				if (action === "list") {
					const tabs = await server.refreshTabs(timeoutMs, browserSession);
					const snapshot = server.snapshot(browserSession);
					const compactTabs = params.includeBridgePerTab === true ? tabs : tabs.map((tab) => compactTabForList(tab as Record<string, unknown>));
					return jsonResult({ tabs: compactTabs, tabCount: tabs.length, bridge: compactBridgeForTabsList(snapshot as Record<string, unknown>) }, detailsForTransport(() => ({ action, snapshot, observationSnapshots: server.listObservationSnapshots().length })), maxChars);
				}
				if (action === "snapshot") {
					if (typeof params.snapshotId === "string" && params.snapshotId.trim()) {
						const snapshot = server.getObservationSnapshot(params.snapshotId);
						if (!snapshot) throw tabsToolError("INVALID_RULE", "browser_tabs snapshotId was not found", {
							snapshotId: params.snapshotId,
							reason: "snapshot_not_found",
							recovery: {
								nextActions: [
									"pi-browser observe --mode scan --json",
									"pi-browser tabs --action snapshot --json",
								],
							},
						});
						if (snapshot.expired && params.allowExpired !== true) throw tabsToolError("INVALID_RULE", "browser_tabs snapshotId is stale; read the saved artifact explicitly or pass allowExpired:true", {
							snapshotId: snapshot.snapshotId,
							invalidatedReason: snapshot.invalidatedReason,
							saved: snapshot.saved,
							reason: "snapshot_expired",
							recovery: {
								nextActions: [
									"pi-browser tabs --action snapshot --allow-expired --snapshot-id <snapshotId> --json",
									"pi-browser artifact --path <saved.path> --mode json --json-path data --json",
									"pi-browser observe --mode scan --json",
								],
							},
						});
						return jsonResult({ snapshot, bridge: publicSnapshot(server.snapshot(browserSession) as Record<string, unknown>) }, detailsForTransport(() => ({ action })), maxChars);
					}
					return jsonResult({ bridge: publicSnapshot(server.snapshot(browserSession) as Record<string, unknown>), observationSnapshots: server.listObservationSnapshots() }, detailsForTransport(() => ({ action })), maxChars);
				}
				if (action === "listsessions") return jsonResult({ sessions: server.listBrowserSessions() }, { action });
				if (action === "createsession") return jsonResult({ session: server.createBrowserSession(params.name) }, { action });
				if (action === "selectsession") return jsonResult({ session: server.selectBrowserSession(params.browserSessionId || ""), snapshot: publicSnapshot(server.snapshot(browserSession) as Record<string, unknown>) }, { action });
				if (action === "closesession") return jsonResult({ closed: server.closeBrowserSession(params.browserSessionId || ""), sessions: server.listBrowserSessions() }, { action });
				if (action === "attachtab" && tabRef !== undefined) return jsonResult({ tab: server.attachTabToBrowserSession(tabRef, { ...browserSession, browserId: typeof params.browserId === "string" ? params.browserId : undefined }), session: publicSnapshot(server.snapshot(browserSession) as Record<string, unknown>) }, { action });
				if (action === "detachtab" && tabRef !== undefined) return jsonResult({ session: server.detachTabFromBrowserSession(tabRef, browserSession) }, { action });
				if (action === "leasetab" && tabRef !== undefined) return jsonResult({ lease: defaultLeaseIdRedactor.tabLease(server.leaseTab(tabRef, browserSession) as BrowserTabLeaseInfo), session: publicSnapshot(server.snapshot(browserSession) as Record<string, unknown>) }, { action });
				if (action === "releasetab" && tabRef !== undefined) {
					const released = server.releaseTab(tabRef, browserSession);
					return jsonResult({ released: released ? defaultLeaseIdRedactor.tabLease(released as BrowserTabLeaseInfo) : undefined, session: publicSnapshot(server.snapshot(browserSession) as Record<string, unknown>) }, { action });
				}
				if (action === "selectbrowser" || action === "browser" || action === "select") return jsonResult({ selected: server.selectBrowser(params.browserId || "", browserSession), snapshot: publicSnapshot(server.snapshot(browserSession) as Record<string, unknown>) }, { action });
				if (action === "switch" && tabRef !== undefined) return jsonResult(await server.switchTab(tabRef, timeoutMs, browserSession), { action });
				if (action === "create") return jsonResult(await server.createTab(createUrl || "about:blank", params.active !== false, timeoutMs, { ...browserSession, incognito: params.incognito === true }), { action });
				if (action === "close" && tabRef !== undefined) return jsonResult(await server.closeTab(tabRef, timeoutMs, browserSession), { action });
				throw tabsToolError("INVALID_RULE", `Unsupported browser_tabs action: ${params.action}`, { action: params.action });
			});
		},
	});
}
