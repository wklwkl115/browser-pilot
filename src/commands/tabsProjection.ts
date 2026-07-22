import { defaultLeaseIdRedactor } from "../kernels/session/leaseRegistry.js";
import type { CommandTabLeaseInfo as BrowserTabLeaseInfo, CommandUiLockInfo as BrowserUiLockInfo } from "../ports/BrowserCommandRuntimePort.js";

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function copyDefined(source: Record<string, unknown>, keys = Object.keys(source)): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of keys) {
		if (source[key] !== undefined) out[key] = source[key];
	}
	return out;
}

export function compactTabForList(tab: Record<string, unknown>): Record<string, unknown> {
	const targetRef = firstString(tab.targetRef, tab.tabHandle);
	const out: Record<string, unknown> = {
		...(targetRef ? { id: targetRef } : tab.id !== undefined ? { id: tab.id } : {}),
		...(targetRef && tab.id !== undefined && tab.id !== targetRef ? { tabSessionId: tab.id } : {}),
	};
	Object.assign(out, copyDefined(tab, ["browserId", "browserSessionId", "tabId", "tabHandle", "targetRef", "logicalTabId", "generation", "url", "title", "active", "windowId", "openerTabId", "incognito", "type", "connectedAt", "replacedFromTabId", "replacedAt", "activatedAt"]));
	return out;
}

export function compactBridgeForTabsList(snapshot: Record<string, unknown>): Record<string, unknown> {
	return copyDefined(snapshot, ["browserSessionId", "host", "port", "running", "connectedClients", "extensionConnected", "extension", "defaultTabId", "defaultTabHandle", "latestTabId", "latestTabHandle", "selectionVersion"]);
}

export function publicSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
	const now = Date.now();
	const leases = Array.isArray(snapshot.leases) ? snapshot.leases.map((lease) => defaultLeaseIdRedactor.tabLease(lease as BrowserTabLeaseInfo, undefined, now)) : undefined;
	const uiLock = snapshot.uiLock && typeof snapshot.uiLock === "object" ? defaultLeaseIdRedactor.uiLock(snapshot.uiLock as BrowserUiLockInfo, undefined, now) : undefined;
	return {
		...snapshot,
		...(leases ? { leases } : {}),
		...(uiLock ? { uiLock } : {}),
	};
}
