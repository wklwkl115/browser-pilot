import { chromeApi as chrome } from "./runtimeEnv";
import { emitBrowserPilotOperationEvent, isBrowserPilotOperationEventSocket, releaseBrowserPilotOperationEventSocket } from "./operation_event_transport";
import type { BrowserPilotBridgeCommand, BrowserPilotBridgeResponse, BrowserPilotBridgeWebSocketLike, BrowserPilotChromeDownloadItem, BrowserPilotChromeTab, BrowserPilotWaitRecord, JsonRecord } from "./types";
import { enableBrowserPilotCdpDomains, releaseBrowserPilotCdpDomains } from "./wait_cdp";

type OperationState = {
	operationId: string;
	tabId?: number;
	targetRef?: string;
	generation?: number;
	targetInvalidated?: { tabId: number; reason: string; at: number };
	sequence: number;
	startedAt: number;
	terminal: boolean;
	activeUntil?: number;
	passiveUntil?: number;
	cleanupTimer?: ReturnType<typeof setTimeout>;
	dispatchMarker?: Promise<BrowserPilotBridgeResponse>;
	cdpRecord?: BrowserPilotWaitRecord;
	relatedTabIds: Set<number>;
	relatedDownloadIds: Set<number>;
};

type OperationDispatchContext = {
	tabId?: number;
	operationGeneration?: number;
	socket?: BrowserPilotBridgeWebSocketLike;
};

type OperationEmission = {
	sourceSequence: number;
	delivered: boolean;
};

const operations = new Map<string, OperationState>();
const PASSIVE_WINDOW_MS = 30_000;
const ACTIVE_OPERATION_TTL_MS = 310_000;
const MIN_ACTIVE_OPERATION_TTL_MS = 25;
const PAGE_OBSERVER_TTL_GRACE_MS = PASSIVE_WINDOW_MS + 1_000;
let listenersInstalled = false;

function activeOperationExpired(operation: OperationState, now = Date.now()): boolean {
	return !operation.terminal && operation.activeUntil !== undefined && now >= operation.activeUntil;
}

function activeForTab(tabId: number | undefined, includeGlobal = false): OperationState[] {
	const now = Date.now();
	return Array.from(operations.values()).filter((operation) => {
		if (activeOperationExpired(operation, now)) {
			void deleteOperation(operation.operationId);
			return false;
		}
		if (operation.terminal && (operation.passiveUntil === undefined || now > operation.passiveUntil)) return false;
		return includeGlobal || operation.tabId === undefined || operation.tabId === tabId || (tabId !== undefined && operation.relatedTabIds.has(tabId));
	});
}

function emit(operation: OperationState, type: string, data: JsonRecord = {}, progress = true): OperationEmission {
	operation.sequence += 1;
	const delivered = emitBrowserPilotOperationEvent(operation.operationId, {
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
	return { sourceSequence: operation.sequence, delivered };
}

const onTabCreated = (tab: BrowserPilotChromeTab) => {
	const active = activeForTab(undefined, true);
	const candidates = active.filter((operation) => operation.tabId === undefined || tab.openerTabId === operation.tabId || active.length === 1);
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
	for (const operation of activeForTab(tabId)) invalidateOperationTarget(operation, tabId, "tab_removed");
};
const onTabReplaced = (addedTabId: number, removedTabId: number) => {
	for (const operation of activeForTab(removedTabId)) invalidateOperationTarget(operation, removedTabId, "tab_replaced", { addedTabId, removedTabId });
};
const onTabActivated = (info: { tabId: number; windowId: number }) => {
	for (const operation of activeForTab(info.tabId, true)) emit(operation, "target_activated", { tabId: info.tabId, windowId: info.windowId });
};
const onDownloadCreated = (item: BrowserPilotChromeDownloadItem) => {
	const candidates = activeForTab(undefined, true).filter((operation) => !operation.terminal);
	const downloadId = Number(item.id);
	if (candidates.length !== 1 || !Number.isInteger(downloadId)) return;
	const operation = candidates[0]!;
	operation.relatedDownloadIds.add(downloadId);
	emit(operation, "download_started", { downloadId, url: item.finalUrl ?? item.url, filename: item.filename, state: item.state });
};
const onDownloadChanged = (delta: JsonRecord & { id?: number; state?: { current?: string }; filename?: unknown }) => {
	const downloadId = Number(delta.id);
	if (!Number.isInteger(downloadId)) return;
	for (const operation of activeForTab(undefined, true)) {
		if (!operation.relatedDownloadIds.has(downloadId)) continue;
		emit(operation, delta.state?.current === "complete" ? "download_completed" : "download_progress", { downloadId, state: delta.state?.current, filename: delta.filename });
	}
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

async function installMutationObserver(operation: OperationState, observerTtlMs: number): Promise<boolean> {
	if (operation.tabId === undefined) return false;
	try {
		const response = await chrome.tabs.sendMessage(operation.tabId, {
			cmd: "browserPilot.operation.begin",
			operationId: operation.operationId,
			ttlMs: observerTtlMs,
		}, { frameId: 0 });
		const result = response && typeof response === "object" && !Array.isArray(response) ? response as JsonRecord : {};
		return result.ok === true && result.observerArmed === true;
	} catch {
		return false;
	}
}

type MutationCheckpoint = {
	mutationCount: number;
	batchCount: number;
	observerFound: boolean;
	deliveryFailures: number;
	deliveryReliable: boolean;
	fenceId?: string;
	checkedAt?: number;
	sourceSequence?: number;
};

async function takePendingMutationRecords(operation: OperationState, fenceId: string, eventType: "checkpoint" | "dispatch" = "checkpoint"): Promise<MutationCheckpoint> {
	if (operation.tabId === undefined) return { mutationCount: 0, batchCount: 0, observerFound: false, deliveryFailures: 0, deliveryReliable: false };
	try {
		const raw = await chrome.tabs.sendMessage(operation.tabId, {
			cmd: "browserPilot.operation.checkpoint",
			operationId: operation.operationId,
			fenceId,
			eventType,
		}, { frameId: 0 });
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { mutationCount: 0, batchCount: 0, observerFound: false, deliveryFailures: 0, deliveryReliable: false };
		const checkpoint = raw as Partial<MutationCheckpoint>;
		return {
			mutationCount: Math.max(0, Number(checkpoint.mutationCount) || 0),
			batchCount: Math.max(0, Number(checkpoint.batchCount) || 0),
			observerFound: checkpoint.observerFound === true,
			deliveryFailures: Math.max(0, Math.floor(Number(checkpoint.deliveryFailures) || 0)),
			deliveryReliable: checkpoint.deliveryReliable === true,
			...(typeof checkpoint.fenceId === "string" ? { fenceId: checkpoint.fenceId } : {}),
			...(Number.isFinite(Number(checkpoint.checkedAt)) ? { checkedAt: Number(checkpoint.checkedAt) } : {}),
			...(Number.isInteger(Number(checkpoint.sourceSequence)) && Number(checkpoint.sourceSequence) > 0 ? { sourceSequence: Number(checkpoint.sourceSequence) } : {}),
		};
	} catch {
		return { mutationCount: 0, batchCount: 0, observerFound: false, deliveryFailures: 0, deliveryReliable: false };
	}
}

async function removeMutationObserver(operation: OperationState): Promise<void> {
	if (operation.tabId === undefined) return;
	await chrome.tabs.sendMessage(operation.tabId, { cmd: "browserPilot.operation.remove", operationId: operation.operationId }, { frameId: 0 }).catch(() => undefined);
}

function operationFenceId(operation: OperationState, message: BrowserPilotBridgeCommand): string {
	const provided = typeof message.fenceId === "string" ? message.fenceId.trim() : "";
	if (provided) return provided;
	const randomId = globalThis.crypto?.randomUUID?.();
	return randomId ? `fence-${randomId}` : `fence-${operation.operationId}-${Date.now().toString(36)}-${(operation.sequence + 1).toString(36)}`;
}

function activeOperationTtlMs(message: BrowserPilotBridgeCommand): number {
	const requested = Number(message.activeTtlMs);
	if (!Number.isFinite(requested) || requested <= 0) return ACTIVE_OPERATION_TTL_MS;
	return Math.max(MIN_ACTIVE_OPERATION_TTL_MS, Math.min(ACTIVE_OPERATION_TTL_MS, Math.floor(requested)));
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
	if (!operation || activeOperationExpired(operation)) {
		if (operation) void deleteOperation(operation.operationId);
		return false;
	}
	return emit(operation, "mutation", { mutationCount: Number(message.mutationCount || 0), batchCount: Number(message.batchCount || 0), ...(typeof message.signalType === "string" ? { signalType: message.signalType } : {}) }).delivered;
}

export function handleBrowserPilotOperationCheckpointEvent(message: JsonRecord): { ok: boolean; sourceSequence?: number; checkedAt?: number; deliveryFailures?: number; deliveryReliable?: boolean; reliable?: boolean } {
	const operation = operations.get(String(message.operationId || ""));
	const fenceId = typeof message.fenceId === "string" ? message.fenceId.trim() : "";
	if (!operation || operation.terminal || activeOperationExpired(operation) || !fenceId) {
		if (operation && activeOperationExpired(operation)) void deleteOperation(operation.operationId);
		return { ok: false };
	}
	const checkedAt = Date.now();
	const deliveryFailures = Math.max(0, Math.floor(Number(message.deliveryFailures) || 0));
	const deliveryReliable = deliveryFailures === 0;
	const eventType = message.eventType === "dispatch" ? "dispatch" : "checkpoint";
	const emission = emit(operation, eventType, { fenceId, checkedAt, mutationObserverFound: true, deliveryFailures, deliveryReliable, reliable: deliveryReliable }, false);
	const reliable = deliveryReliable && emission.delivered;
	return { ok: emission.delivered, sourceSequence: emission.sourceSequence, checkedAt, deliveryFailures, deliveryReliable: reliable, reliable };
}

function dispatchContextError(operation: OperationState, context: OperationDispatchContext): BrowserPilotBridgeResponse | undefined {
	if (operation.targetInvalidated) {
		return {
			ok: false,
			error_code: "INVALID_RULE",
			error: "operation dispatch marker target was invalidated before dispatch",
			details: { operationId: operation.operationId, dispatchStarted: false, acked: false, targetInvalidated: operation.targetInvalidated },
		};
	}
	const tabMatches = operation.tabId === context.tabId;
	const generationMatches = operation.generation === context.operationGeneration;
	const socketMatches = context.socket !== undefined && isBrowserPilotOperationEventSocket(operation.operationId, context.socket);
	if (tabMatches && generationMatches && socketMatches) return undefined;
	return {
		ok: false,
		error_code: "INVALID_RULE",
		error: "operation dispatch marker target does not match its armed operation",
		details: {
			operationId: operation.operationId,
			dispatchStarted: false,
			acked: false,
			expectedTabId: operation.tabId,
			actionTabId: context.tabId,
			expectedGeneration: operation.generation,
			actionGeneration: context.operationGeneration,
			tabMatches,
			generationMatches,
			socketMatches,
		},
	};
}

function invalidateOperationTarget(operation: OperationState, tabId: number, reason: string, details: JsonRecord = {}): void {
	operation.targetInvalidated ??= { tabId, reason, at: Date.now() };
	emit(operation, "target_lost", { reason, ...details });
}

export function invalidateBrowserPilotOperationTarget(tabId: number, reason: string): number {
	const normalizedTabId = Number(tabId);
	if (!Number.isInteger(normalizedTabId) || normalizedTabId <= 0) return 0;
	const targets = activeForTab(normalizedTabId).filter((operation) => !operation.terminal && operation.tabId === normalizedTabId);
	for (const operation of targets) invalidateOperationTarget(operation, normalizedTabId, reason);
	return targets.length;
}

export async function markBrowserPilotOperationDispatch(operationId: string, context: OperationDispatchContext): Promise<BrowserPilotBridgeResponse> {
	const normalizedOperationId = String(operationId || "").trim();
	const operation = operations.get(normalizedOperationId);
	if (!operation || operation.terminal || activeOperationExpired(operation)) {
		if (operation && activeOperationExpired(operation)) void deleteOperation(operation.operationId);
		return { ok: false, error_code: "INVALID_RULE", error: "operation dispatch marker could not find an active operation", details: { operationId: normalizedOperationId, dispatchStarted: false, acked: false } };
	}
	const contextFailure = dispatchContextError(operation, context);
	if (contextFailure) return contextFailure;
	if (operation.dispatchMarker) return await operation.dispatchMarker;
	const fenceId = `dispatch-${normalizedOperationId}`;
	operation.dispatchMarker = (async (): Promise<BrowserPilotBridgeResponse> => {
		const mutation = await takePendingMutationRecords(operation, fenceId, "dispatch");
		if (operations.get(normalizedOperationId) !== operation || operation.terminal || activeOperationExpired(operation)) {
			return { ok: false, error_code: "INVALID_RULE", error: "operation ended before its dispatch marker was established", details: { operationId: normalizedOperationId, fenceId, dispatchStarted: false, acked: false } };
		}
		const postMarkerContextFailure = dispatchContextError(operation, context);
		if (postMarkerContextFailure) return postMarkerContextFailure;
		const reliable = mutation.observerFound
			&& mutation.deliveryReliable
			&& mutation.sourceSequence !== undefined
			&& mutation.checkedAt !== undefined;
		const data = {
			operationId: normalizedOperationId,
			fenceId,
			sourceSequence: mutation.sourceSequence,
			checkedAt: mutation.checkedAt,
			mutationObserverFound: mutation.observerFound,
			deliveryFailures: mutation.deliveryFailures,
			deliveryReliable: mutation.deliveryReliable,
			reliable,
		};
		return reliable
			? { ok: true, data }
			: { ok: false, error_code: "INVALID_RULE", error: "operation dispatch marker was not established reliably", details: { ...data, dispatchStarted: false, acked: false } };
	})();
	return await operation.dispatchMarker;
}

function operationNotFound(operationId: string): BrowserPilotBridgeResponse {
	return { ok: false, error_code: "INVALID_RULE", error: "operation was not found", details: { operationId } };
}

async function beginBrowserPilotOperation(operationId: string, message: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
	await deleteOperation(operationId);
	const tabId = Number(message.tabId || 0) || undefined;
	const activeTtlMs = activeOperationTtlMs(message);
	const startedAt = Date.now();
	const operation: OperationState = {
		operationId,
		tabId,
		targetRef: typeof message.targetRef === "string" ? message.targetRef : undefined,
		generation: Number.isFinite(Number(message.generation)) ? Number(message.generation) : undefined,
		sequence: 0,
		startedAt,
		terminal: false,
		activeUntil: startedAt + activeTtlMs,
		relatedTabIds: new Set(),
		relatedDownloadIds: new Set(),
	};
	operations.set(operationId, operation);
	operation.cleanupTimer = setTimeout(() => void deleteOperation(operationId), activeTtlMs);
	installListeners();
	try {
		let cdpArmed = false;
		if (tabId !== undefined) {
			const cdpRecord = { key: `operation:${operationId}`, waitId: operationId, kind: "operation", tabId, cdpDomains: new Set<string>(), cdpSubscriptions: [] } as unknown as BrowserPilotWaitRecord;
			await enableBrowserPilotCdpDomains(cdpRecord, ["Page", "Network", "Runtime"]);
			operation.cdpRecord = cdpRecord;
			cdpArmed = true;
		}
		// Targetless control-plane operations (for example tabs.create) still need the
		// Chrome lifecycle listeners and operation ledger, but have no page in which a
		// content observer could be armed. A concrete tab operation must confirm the
		// persistent top-frame observer before it can dispatch.
		const mutationObserverArmed = tabId === undefined ? false : await installMutationObserver(operation, activeTtlMs + PAGE_OBSERVER_TTL_GRACE_MS);
		if (tabId !== undefined && !mutationObserverArmed) {
			await deleteOperation(operationId);
			return {
				ok: false,
				error_code: "INJECTION_FAILED",
				error: "operation page observer could not be armed in the top-frame content script",
				details: { operationId, tabId, generation: operation.generation, dispatchStarted: false, acked: false },
			};
		}
		return { ok: true, data: { operationId, armed: true, cdpArmed, mutationObserverArmed, tabId, generation: operation.generation, startedAt: operation.startedAt, activeUntil: operation.activeUntil } };
	} catch (error) {
		await deleteOperation(operationId);
		throw error;
	}
}

async function requireActiveBrowserPilotOperation(operationId: string): Promise<OperationState | BrowserPilotBridgeResponse> {
	const operation = operations.get(operationId);
	if (!operation) return operationNotFound(operationId);
	if (!activeOperationExpired(operation)) return operation;
	await deleteOperation(operationId);
	return operationNotFound(operationId);
}

function isOperationState(value: OperationState | BrowserPilotBridgeResponse): value is OperationState {
	return value instanceof Object && "operationId" in value;
}

async function checkpointBrowserPilotOperation(operationId: string, operation: OperationState, message: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
	if (operation.terminal) return { ok: false, error_code: "INVALID_RULE", error: "operation is already finished", details: { operationId } };
	const fenceId = operationFenceId(operation, message);
	const mutation = await takePendingMutationRecords(operation, fenceId);
	if (operations.get(operationId) !== operation) return operationNotFound(operationId);
	const checkedAt = mutation.checkedAt ?? Date.now();
	const deliveryFailures = mutation.deliveryFailures;
	const deliveryReliable = mutation.sourceSequence !== undefined && mutation.deliveryReliable;
	const sourceSequence = mutation.sourceSequence ?? emit(operation, "checkpoint", { fenceId, checkedAt, mutationObserverFound: false, deliveryFailures, deliveryReliable: false }, false).sourceSequence;
	return { ok: true, data: { operationId, fenceId, sourceSequence, checkedAt, deliveryFailures, deliveryReliable } };
}

async function cancelBrowserPilotOperation(operationId: string): Promise<BrowserPilotBridgeResponse> {
	await deleteOperation(operationId);
	return { ok: true, data: { operationId, cancelled: true } };
}

function finishBrowserPilotOperation(operationId: string, operation: OperationState): BrowserPilotBridgeResponse {
	operation.terminal = true;
	operation.passiveUntil = Date.now() + PASSIVE_WINDOW_MS;
	if (operation.cleanupTimer) clearTimeout(operation.cleanupTimer);
	operation.cleanupTimer = setTimeout(() => void deleteOperation(operationId), PASSIVE_WINDOW_MS);
	return { ok: true, data: { operationId, finished: true, sequence: operation.sequence, passiveUntil: operation.passiveUntil } };
}

export async function handleBrowserPilotOperationCommand(command: string, message: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
	const operationId = String(message.operationId || "").trim();
	if (!operationId) return { ok: false, error_code: "INVALID_RULE", error: "operation command requires operationId" };
	if (command === "operation.begin") return await beginBrowserPilotOperation(operationId, message);
	const active = await requireActiveBrowserPilotOperation(operationId);
	if (!isOperationState(active)) return active;
	if (command === "operation.checkpoint") return await checkpointBrowserPilotOperation(operationId, active, message);
	if (command === "operation.cancel") return await cancelBrowserPilotOperation(operationId);
	if (command !== "operation.finish") return { ok: false, error_code: "INVALID_RULE", error: "unknown operation command", details: { operationId, command } };
	return finishBrowserPilotOperation(operationId, active);
}
