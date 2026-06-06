import { Type } from "typebox";
import { type NativeErrorCode } from "../protocol/nativeErrorCodes.js";
import { BrowserBridgeError } from "../driver/errors.js";
import { jsonResult } from "../utils/toolResult.js";
import { defineBrowserTool, runTool, sharedTabScopedToolParams, toolTimeoutMs } from "./toolAdapter.js";
import { asPositiveInt, strictToolParameters } from "./toolShared.js";
import type { ToolRegistrarContext } from "./toolShared.js";

function tabsToolError(code: NativeErrorCode, message: string, details: Record<string, unknown> = {}): BrowserBridgeError {
	return new BrowserBridgeError(code, message, details);
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
	if (protocol === "javascript:" || protocol === "data:") {
		throw tabsToolError("INVALID_TAB_URL", "browser_tabs create does not accept javascript: or data: URLs; use browser_execute for JavaScript in an existing tab", { url: raw, protocol });
	}
	return parsed.href;
}

export function registerTabsTool({ pi, ensureStarted }: ToolRegistrarContext) {
	defineBrowserTool(pi, {
		name: "browser_tabs",
		label: "Browser Tabs",
		description: "List, switch, create, close, select a real browser, or manage browser sessions connected through the Pi browser bridge.",
		promptSnippet: "Control connected browser tabs and scoped browser sessions: list, snapshot, switch, create, close, selectBrowser, listSessions, createSession, selectSession, closeSession, attachTab, detachTab, leaseTab, releaseTab.",
		promptGuidelines: [
			"Start automation with browser_tabs list; use switch only when you intentionally change the browser active tab.",
			"Keep the target tabId and pass it explicitly to later tab-scoped browser_* calls.",
		],
		parameters: strictToolParameters({
			action: Type.String({ description: "One of: list, snapshot, switch, create, close, selectBrowser, listSessions, createSession, selectSession, closeSession, attachTab, detachTab, leaseTab, releaseTab" }),
			// Universal output/control params (browserSessionId/tabId/detailLevel/timeoutMs/maxChars/redact)
			// come from the shared mixin so browser_tabs accepts them like every other browser_* tool. Real
			// agents repeatedly passed maxChars/detailLevel here and hit a hard "additional properties" reject
			// (C2, ≥7 occurrences across sessions); outputPath is excluded (browser_tabs writes no artifact).
			...sharedTabScopedToolParams({ includeOutputPath: false, tabIdDescription: "Target tab id for switch/close; use browser_tabs list to identify it first." }),
			name: Type.Optional(Type.String({ description: "Browser session display name for createSession." })),
			browserId: Type.Optional(Type.String({ description: "Browser client id or extension id for selectBrowser" })),
			snapshotId: Type.Optional(Type.String({ description: "Optional observation snapshot id for browser_tabs action=snapshot." })),
			allowExpired: Type.Optional(Type.Boolean({ description: "browser_tabs action=snapshot only: allow returning expired observation snapshot metadata." })),
			url: Type.Optional(Type.String({ description: "URL for create" })),
			active: Type.Optional(Type.Boolean({ description: "Whether created tab should be active" })),
				incognito: Type.Optional(Type.Boolean({ description: "create only: open in a fresh incognito window (isolated cookie jar = logged-out session). Requires the extension to be allowed in incognito at chrome://extensions; if not, returns a recovery hint." })),
		}),
		async execute(_toolCallId, params) {
			return await runTool(async () => {
				const action = String(params.action || "").trim().toLowerCase();
				const timeoutMs = toolTimeoutMs(params.timeoutMs, 5_000);
				// Honor maxChars on the sizable outputs (tab list / observation snapshots); detailLevel and
				// redact are accepted for cross-tool consistency but are no-ops here (tab metadata is a small,
				// non-secret JSON list, not a distilled/redacted summary).
				const maxChars = asPositiveInt(params.maxChars, 50_000);
				const tabId = action === "switch" || action === "close" || action === "attachtab" || action === "detachtab" || action === "leasetab" || action === "releasetab" ? requireTabsActionTabId(action, params.tabId) : undefined;
				const createUrl = action === "create" ? normalizeCreateTabUrl(params.url) : undefined;
				const server = await ensureStarted();
				const browserSession = { browserSessionId: typeof params.browserSessionId === "string" ? params.browserSessionId : undefined };
				if (action === "list") return jsonResult(await server.refreshTabs(timeoutMs, browserSession), { action, snapshot: server.snapshot(browserSession), observationSnapshots: server.listObservationSnapshots().length }, maxChars);
				if (action === "snapshot") {
					if (typeof params.snapshotId === "string" && params.snapshotId.trim()) {
						const snapshot = server.getObservationSnapshot(params.snapshotId);
						if (!snapshot) throw tabsToolError("INVALID_RULE", "browser_tabs snapshotId was not found", { snapshotId: params.snapshotId, reason: "snapshot_not_found" });
						if (snapshot.expired && params.allowExpired !== true) throw tabsToolError("INVALID_RULE", "browser_tabs snapshotId is stale; read the saved artifact explicitly or pass allowExpired:true", { snapshotId: snapshot.snapshotId, invalidatedReason: snapshot.invalidatedReason, saved: snapshot.saved, reason: "snapshot_expired" });
						return jsonResult({ snapshot, bridge: server.snapshot(browserSession) }, { action }, maxChars);
					}
					return jsonResult({ bridge: server.snapshot(browserSession), observationSnapshots: server.listObservationSnapshots() }, { action }, maxChars);
				}
				if (action === "listsessions") return jsonResult({ sessions: server.listBrowserSessions() }, { action });
				if (action === "createsession") return jsonResult({ session: server.createBrowserSession(params.name) }, { action });
				if (action === "selectsession") return jsonResult({ session: server.selectBrowserSession(params.browserSessionId || ""), snapshot: server.snapshot(browserSession) }, { action });
				if (action === "closesession") return jsonResult({ closed: server.closeBrowserSession(params.browserSessionId || ""), sessions: server.listBrowserSessions() }, { action });
				if (action === "attachtab" && tabId !== undefined) return jsonResult({ tab: server.attachTabToBrowserSession(tabId, { ...browserSession, browserId: typeof params.browserId === "string" ? params.browserId : undefined }), session: server.snapshot(browserSession) }, { action });
				if (action === "detachtab" && tabId !== undefined) return jsonResult({ session: server.detachTabFromBrowserSession(tabId, browserSession) }, { action });
				if (action === "leasetab" && tabId !== undefined) return jsonResult({ lease: server.leaseTab(tabId, browserSession), session: server.snapshot(browserSession) }, { action });
				if (action === "releasetab" && tabId !== undefined) return jsonResult({ released: server.releaseTab(tabId, browserSession), session: server.snapshot(browserSession) }, { action });
				if (action === "selectbrowser" || action === "browser" || action === "select") return jsonResult({ selected: server.selectBrowser(params.browserId || "", browserSession), snapshot: server.snapshot(browserSession) }, { action });
				if (action === "switch" && tabId !== undefined) return jsonResult(await server.switchTab(tabId, timeoutMs, browserSession), { action });
				if (action === "create") return jsonResult(await server.createTab(createUrl || "about:blank", params.active !== false, timeoutMs, { ...browserSession, incognito: params.incognito === true }), { action });
				if (action === "close" && tabId !== undefined) return jsonResult(await server.closeTab(tabId, timeoutMs, browserSession), { action });
				throw tabsToolError("INVALID_RULE", `Unsupported browser_tabs action: ${params.action}`, { action: params.action });
			});
		},
	});
}
