import type { BrowserBridgeSnapshot, BrowserBridgeTargetInfo } from "./types.js";

export function buildBridgeTimeoutDiagnostics(snapshot: BrowserBridgeSnapshot, tabId: number | undefined, timeoutMs: number, acked: boolean, target?: BrowserBridgeTargetInfo): Record<string, unknown> {
	const queueEntry = tabId !== undefined && snapshot.queues
		? snapshot.queues.find((q) => q.tabId === tabId)
		: undefined;
	return {
		tabId,
		timeoutMs,
		acked,
		running: snapshot.running,
		extensionConnected: snapshot.extensionConnected,
		connectedClients: snapshot.connectedClients,
		defaultTabId: snapshot.defaultTabId,
		latestTabId: snapshot.latestTabId,
		selectionVersion: snapshot.selectionVersion,
		target,
		tabCount: snapshot.tabs.filter((tab) => !tab.disconnectedAt).length,
		pendingCount: snapshot.pending.length,
		pendingRequestCount: snapshot.pending.length,
		queueDepth: queueEntry?.depth ?? 0,
		workerBootId: snapshot.extension?.workerBootId,
	};
}
