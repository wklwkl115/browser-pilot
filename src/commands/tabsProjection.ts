import { defaultLeaseIdRedactor } from "../kernels/session/leaseRegistry.js";
import type { CommandTabLeaseInfo as BrowserTabLeaseInfo, CommandUiLockInfo as BrowserUiLockInfo } from "../ports/BrowserCommandRuntimePort.js";
import { recordValue, toTabId } from "../utils/records.js";

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

function firstTabId(...values: unknown[]): number | undefined {
	for (const value of values) {
		const tabId = toTabId(value);
		if (tabId !== undefined) return tabId;
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

function compactTarget(target: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!target) return undefined;
	return copyDefined(target, ["browserSessionId", "browserId", "tabId", "tabHandle", "targetRef", "requestedTabId", "replacedFrom", "replacedByTabId", "replacementHops", "openerTabId", "url", "source", "implicit", "selectionVersionAtDispatch", "selectionVersionAtResolve"]);
}

export function publicCreateTabResult(result: unknown): Record<string, unknown> {
	const raw = recordValue(result) || {};
	const data = recordValue(raw.data);
	const createdTarget = compactTarget(recordValue(raw.createdTarget));
	const rawCreatedTab = recordValue(raw.createdTab);
	const createdTab = rawCreatedTab ? compactTabForList(rawCreatedTab) : undefined;
	const targetValues = createdTarget || {}, tabValues = createdTab || {}, dataValues = data || {};
	const targetRef = firstString(targetValues.targetRef, targetValues.tabHandle, tabValues.targetRef, tabValues.tabHandle, dataValues.targetRef, dataValues.tabHandle);
	const tabId = firstTabId(targetValues.tabId, tabValues.tabId, dataValues.tabId, dataValues.id, raw.tabId);
	const id = targetRef ?? tabId ?? raw.id;
	const browserSessionId = firstString(targetValues.browserSessionId, dataValues.browserSessionId);
	const browserId = firstString(targetValues.browserId, tabValues.browserId, dataValues.browserId);
	const url = firstString(dataValues.url, tabValues.url, targetValues.url);
	const title = firstString(dataValues.title, tabValues.title);
	return copyDefined({
		id, targetRef, tabHandle: targetRef, tabId, browserSessionId, browserId, url, title,
		requestId: raw.id !== undefined && raw.id !== id ? raw.id : undefined, acknowledged: raw.acknowledged,
		createdTarget, createdTab, data, target: raw.target, newTabs: raw.newTabs, diagnostics: raw.diagnostics,
	});
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
