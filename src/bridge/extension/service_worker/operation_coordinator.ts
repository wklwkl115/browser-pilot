import { chromeApi as chrome } from "./runtimeEnv";
import { emitBrowserPilotOperationEvent, releaseBrowserPilotOperationEventSocket } from "./operation_event_transport";
import type { BrowserPilotBridgeCommand, BrowserPilotBridgeResponse, BrowserPilotChromeDownloadItem, BrowserPilotChromeTab, BrowserPilotWaitRecord, JsonRecord } from "./types";
import { enableBrowserPilotCdpDomains, releaseBrowserPilotCdpDomains } from "./wait_cdp";

type OperationState = {
	operationId: string;
	tabId?: number;
	targetRef?: string;
	generation?: number;
	sequence: number;
	startedAt: number;
	terminal: boolean;
	passiveUntil?: number;
	cleanupTimer?: ReturnType<typeof setTimeout>;
	cdpRecord?: BrowserPilotWaitRecord;
	relatedTabIds: Set<number>;
};

const operations = new Map<string, OperationState>();
const PASSIVE_WINDOW_MS = 30_000;
let listenersInstalled = false;

function activeForTab(tabId: number | undefined, includeGlobal = false): OperationState[] {
	const now = Date.now();
	return Array.from(operations.values()).filter((operation) => {
		if (operation.terminal && (operation.passiveUntil === undefined || now > operation.passiveUntil)) return false;
		return includeGlobal || operation.tabId === undefined || operation.tabId === tabId || (tabId !== undefined && operation.relatedTabIds.has(tabId));
	});
}

function emit(operation: OperationState, type: string, data: JsonRecord = {}, progress = true): void {
	operation.sequence += 1;
	emitBrowserPilotOperationEvent(operation.operationId, {
		operationId: operation.operationId,
		sequence: operation.sequence,
		type,
		timestamp: Date.now(),
		...(operation.targetRef ? { targetRef: operation.targetRef } : {}),
		...(operation.tabId !== undefined ? { tabId: operation.tabId } : {}),
		...(operation.generation !== undefined ? { generation: operation.generation } : {}),
		progress,
		data,
	});
}

const onTabCreated = (tab: BrowserPilotChromeTab) => {
	const candidates = activeForTab(undefined, true).filter((operation) => operation.tabId === undefined || tab.openerTabId === operation.tabId || activeForTab(undefined, true).length === 1);
	for (const operation of candidates) {
		if (tab.id !== undefined) operation.relatedTabIds.add(tab.id);
		emit(operation, "new_tab", { tabId: tab.id, openerTabId: tab.openerTabId, url: tab.pendingUrl ?? tab.url });
	}
};
const onTabUpdated = (tabId: number, changeInfo: JsonRecord, tab: BrowserPilotChromeTab) => {
	for (const operation of activeForTab(tabId)) {
		if (typeof changeInfo.url === "string") emit(operation, "navigation", { phase: "url", url: changeInfo.url });
		if (changeInfo.status === "complete") emit(operation, "navigation", { phase: "complete", url: tab.url });
	}
};
const onTabRemoved = (tabId: number) => {
	for (const operation of activeForTab(tabId)) emit(operation, "target_lost", { reason: "tab_removed" });
};
const onTabReplaced = (addedTabId: number, removedTabId: number) => {
	for (const operation of activeForTab(removedTabId)) emit(operation, "target_lost", { reason: "tab_replaced", addedTabId, removedTabId });
};
const onTabActivated = (info: { tabId: number; windowId: number }) => {
	for (const operation of activeForTab(info.tabId, true)) emit(operation, "target_activated", { tabId: info.tabId, windowId: info.windowId });
};
const onDownloadCreated = (item: BrowserPilotChromeDownloadItem) => {
	for (const operation of activeForTab(undefined, true)) emit(operation, "download_started", { downloadId: item.id, url: item.finalUrl ?? item.url, filename: item.filename, state: item.state });
};
const onDownloadChanged = (delta: JsonRecord & { id?: number; state?: { current?: string }; filename?: unknown }) => {
	for (const operation of activeForTab(undefined, true)) emit(operation, delta.state?.current === "complete" ? "download_completed" : "download_progress", { downloadId: delta.id, state: delta.state?.current, filename: delta.filename });
};
const onDebuggerEvent = (source: { tabId?: number }, method: string, params?: JsonRecord) => {
	for (const operation of activeForTab(source.tabId)) {
		if (method === "Network.requestWillBeSent") emit(operation, "network_started", { requestId: params?.requestId, url: (params?.request as JsonRecord | undefined)?.url });
		else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") emit(operation, "network_completed", { requestId: params?.requestId, failed: method.endsWith("Failed") });
		else if (method === "Page.javascriptDialogOpening") emit(operation, "dialog", { dialogType: params?.type, message: params?.message });
		else if (method === "Page.frameNavigated" || method === "Page.navigatedWithinDocument" || method === "Page.lifecycleEvent") emit(operation, "navigation", { phase: method, url: params?.url, name: params?.name });
	}
};

const webNavigationListeners: Array<{ event?: { addListener(listener: (details: JsonRecord & { tabId?: number; url?: string }) => void): void; removeListener(listener: (details: JsonRecord & { tabId?: number; url?: string }) => void): void }; listener: (details: JsonRecord & { tabId?: number; url?: string }) => void }> = [];

function installListeners(): void {
	if (listenersInstalled) return;
	chrome.tabs.onCreated.addListener(onTabCreated);
	chrome.tabs.onUpdated.addListener(onTabUpdated);
	chrome.tabs.onRemoved.addListener(onTabRemoved);
	chrome.tabs.onReplaced?.addListener(onTabReplaced);
	chrome.tabs.onActivated?.addListener(onTabActivated);
	chrome.downloads.onCreated.addListener(onDownloadCreated);
	chrome.downloads.onChanged.addListener(onDownloadChanged);
	chrome.debugger.onEvent.addListener(onDebuggerEvent);
	for (const [name, type] of [["onCommitted", "navigation_committed"], ["onCompleted", "navigation_completed"], ["onHistoryStateUpdated", "navigation_history"], ["onErrorOccurred", "navigation_error"]] as const) {
		const event = chrome.webNavigation[name];
		if (!event) continue;
		const listener = (details: JsonRecord & { tabId?: number; url?: string }) => {
			if (details.frameId !== undefined && details.frameId !== 0) return;
			for (const operation of activeForTab(details.tabId)) emit(operation, type, { url: details.url, frameId: details.frameId, error: details.error });
		};
		event.addListener(listener);
		webNavigationListeners.push({ event, listener });
	}
	listenersInstalled = true;
}

function uninstallListenersIfIdle(): void {
	if (!listenersInstalled || operations.size) return;
	chrome.tabs.onCreated.removeListener(onTabCreated);
	chrome.tabs.onUpdated.removeListener(onTabUpdated);
	chrome.tabs.onRemoved.removeListener(onTabRemoved);
	chrome.tabs.onReplaced?.removeListener(onTabReplaced);
	chrome.tabs.onActivated?.removeListener(onTabActivated);
	chrome.downloads.onCreated.removeListener(onDownloadCreated);
	chrome.downloads.onChanged.removeListener(onDownloadChanged);
	chrome.debugger.onEvent.removeListener(onDebuggerEvent);
	for (const item of webNavigationListeners.splice(0)) item.event?.removeListener(item.listener);
	listenersInstalled = false;
}

async function installMutationObserver(operation: OperationState): Promise<boolean> {
	if (operation.tabId === undefined) return false;
	try {
		await chrome.scripting.executeScript({
			target: { tabId: operation.tabId, allFrames: false },
			world: "ISOLATED",
			func: (operationId: string) => {
				const root = globalThis as typeof globalThis & { __browserPilotOperationObservers?: Map<string, MutationObserver> };
				root.__browserPilotOperationObservers ??= new Map();
				root.__browserPilotOperationObservers.get(operationId)?.disconnect();
				let mutationCount = 0;
				const observer = new MutationObserver((records) => {
					mutationCount += records.length;
					void chrome.runtime.sendMessage({ type: "browser-pilot-operation-dom-event", operationId, mutationCount, batchCount: records.length });
				});
				observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
				root.__browserPilotOperationObservers.set(operationId, observer);
			},
			args: [operation.operationId],
		});
		return true;
	} catch {
		return false;
	}
}

async function removeMutationObserver(operation: OperationState): Promise<void> {
	if (operation.tabId === undefined) return;
	await chrome.scripting.executeScript({
		target: { tabId: operation.tabId, allFrames: false },
		world: "ISOLATED",
		func: (operationId: string) => {
			const root = globalThis as typeof globalThis & { __browserPilotOperationObservers?: Map<string, MutationObserver> };
			root.__browserPilotOperationObservers?.get(operationId)?.disconnect();
			root.__browserPilotOperationObservers?.delete(operationId);
		},
		args: [operation.operationId],
	}).catch(() => undefined);
}

async function deleteOperation(operationId: string): Promise<void> {
	const operation = operations.get(operationId);
	if (!operation) {
		releaseBrowserPilotOperationEventSocket(operationId);
		return;
	}
	if (operation.cleanupTimer) clearTimeout(operation.cleanupTimer);
	operations.delete(operationId);
	releaseBrowserPilotOperationEventSocket(operationId);
	if (operation.cdpRecord) releaseBrowserPilotCdpDomains(operation.cdpRecord, operation.cdpRecord.cdpDomains, "operation_cleanup");
	await removeMutationObserver(operation);
	uninstallListenersIfIdle();
}

export function handleBrowserPilotOperationDomEvent(message: JsonRecord): boolean {
	const operation = operations.get(String(message.operationId || ""));
	if (!operation) return false;
	emit(operation, "mutation", { mutationCount: Number(message.mutationCount || 0), batchCount: Number(message.batchCount || 0) });
	return true;
}

export async function handleBrowserPilotOperationCommand(command: string, message: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
	const operationId = String(message.operationId || "").trim();
	if (!operationId) return { ok: false, error_code: "INVALID_RULE", error: "operation command requires operationId" };
	if (command === "operation.begin") {
		await deleteOperation(operationId);
		const tabId = Number(message.tabId || 0) || undefined;
		const operation: OperationState = {
			operationId,
			tabId,
			targetRef: typeof message.targetRef === "string" ? message.targetRef : undefined,
			generation: Number.isFinite(Number(message.generation)) ? Number(message.generation) : undefined,
			sequence: 0,
			startedAt: Date.now(),
			terminal: false,
			relatedTabIds: new Set(),
		};
		operations.set(operationId, operation);
		installListeners();
		try {
			let cdpArmed = false;
			if (tabId !== undefined) {
				const cdpRecord = { key: `operation:${operationId}`, waitId: operationId, kind: "operation", tabId, cdpDomains: new Set<string>(), cdpSubscriptions: [] } as unknown as BrowserPilotWaitRecord;
				await enableBrowserPilotCdpDomains(cdpRecord, ["Page", "Network", "Runtime"]);
				operation.cdpRecord = cdpRecord;
				cdpArmed = true;
			}
			const mutationObserverArmed = await installMutationObserver(operation);
			return { ok: true, data: { operationId, armed: true, cdpArmed, mutationObserverArmed, tabId, generation: operation.generation, startedAt: operation.startedAt } };
		} catch (error) {
			await deleteOperation(operationId);
			throw error;
		}
	}
	const operation = operations.get(operationId);
	if (!operation) return { ok: false, error_code: "INVALID_RULE", error: "operation was not found", details: { operationId } };
	if (command === "operation.cancel") {
		await deleteOperation(operationId);
		return { ok: true, data: { operationId, cancelled: true } };
	}
	operation.terminal = true;
	operation.passiveUntil = Date.now() + PASSIVE_WINDOW_MS;
	operation.cleanupTimer = setTimeout(() => void deleteOperation(operationId), PASSIVE_WINDOW_MS);
	return { ok: true, data: { operationId, finished: true, sequence: operation.sequence, passiveUntil: operation.passiveUntil } };
}
