// layer.js - internal LayerTree mechanism probes.

import { BROWSER_PILOT_ERROR_CODES, normalizePersistentBrowserPilotResponse, browserPilotError, browserPilotPersistentCdp } from "./runtime";
import { subscribeBrowserPilotCdp, unsubscribeBrowserPilotCdp } from "./wait_cdp";
import type { JsonRecord, BrowserPilotBridgeCommand, BrowserPilotBridgeResponse } from "./types";

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function asPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

async function cdpSend(tabId: number, method: string, params: JsonRecord = {}, timeoutMs?: number): Promise<JsonRecord> {
	const cdp = browserPilotPersistentCdp();
	if (!cdp?.send) throw new Error("persistent CDP helper is not loaded");
	const response = normalizePersistentBrowserPilotResponse(await cdp.send(tabId, method, params, { persistent: true, name: "layer_probe", timeoutMs }));
	if (!response || response.ok === false) {
		const error = asRecord(response?.error);
		throw new Error(String(error.message || response?.message || response?.error || `${method} failed`));
	}
	return asRecord(asRecord(response.data).result || response.result || response.data || {});
}

function snapshotString(strings: unknown[], index: unknown): string {
	const text = strings[Number(index)];
	return typeof text === "string" ? text : String(index ?? "");
}

function snapshotAttrs(nodes: JsonRecord, strings: unknown[], nodeIndex: number): JsonRecord {
	const raw = arrayValue(arrayValue(nodes.attributes)[nodeIndex]);
	const out: JsonRecord = {};
	for (let i = 0; i + 1 < raw.length; i += 2) out[snapshotString(strings, raw[i])] = snapshotString(strings, raw[i + 1]);
	return out;
}

async function probeDomSnapshotPaintOrder(tabId: number, timeoutMs: number, maxLayers: number): Promise<JsonRecord> {
	try {
		const snapshot = await cdpSend(tabId, "DOMSnapshot.captureSnapshot", { computedStyles: [], includeDOMRects: true, includePaintOrder: true }, timeoutMs);
		const strings = arrayValue(snapshot.strings);
		const entries: JsonRecord[] = [];
		for (const documentSnapshot of arrayValue(snapshot.documents)) {
			const doc = asRecord(documentSnapshot);
			const nodes = asRecord(doc.nodes);
			const layout = asRecord(doc.layout);
			const backendIds = arrayValue(nodes.backendNodeId);
			const nodeNames = arrayValue(nodes.nodeName);
			const layoutNodeIndexes = arrayValue(layout.nodeIndex);
			const paintOrders = arrayValue(layout.paintOrders || layout.paintOrder);
			const bounds = arrayValue(layout.bounds);
			for (let i = 0; i < layoutNodeIndexes.length && entries.length < maxLayers; i += 1) {
				const nodeIndex = Number(layoutNodeIndexes[i]);
				const backendNodeId = Number(backendIds[nodeIndex]);
				const paintOrder = Number(paintOrders[i]);
				if (!Number.isFinite(backendNodeId) || backendNodeId <= 0 || !Number.isFinite(paintOrder)) continue;
				const rawBounds = arrayValue(bounds[i]).map(Number);
				entries.push({
					backendNodeId,
					paintOrder,
					nodeName: snapshotString(strings, nodeNames[nodeIndex]),
					id: snapshotAttrs(nodes, strings, nodeIndex).id,
					bounds: rawBounds.length >= 4 ? rawBounds.slice(0, 4) : undefined,
				});
			}
		}
		const ownerIds = Array.from(new Set(entries.map((item) => Number(item.backendNodeId)).filter((id) => Number.isFinite(id) && id > 0))).sort((a, b) => a - b);
		return {
			supported: entries.length > 0,
			paintOrderCount: entries.length,
			ownerBackendNodeIds: ownerIds,
			entries,
			proof: entries.length ? "domsnapshot-paint-order-backend-node-id-present" : "domsnapshot-paint-order-empty",
		};
	} catch (error) {
		return { supported: false, paintOrderCount: 0, ownerBackendNodeIds: [], entries: [], proof: "domsnapshot-paint-order-not-available", error: errorText(error) };
	}
}

function summarizeLayer(layer: JsonRecord): JsonRecord {
	return {
		layerId: layer.layerId,
		parentLayerId: layer.parentLayerId,
		backendNodeId: layer.backendNodeId,
		offsetX: layer.offsetX,
		offsetY: layer.offsetY,
		width: layer.width,
		height: layer.height,
		drawsContent: layer.drawsContent,
		paintCount: layer.paintCount,
	};
}

export async function probeLayerTree(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
	const timeoutMs = asPositiveInt(msg.timeoutMs ?? msg.timeout_ms, 2_000, 100, 15_000);
	const waitMs = asPositiveInt(msg.waitMs ?? msg.wait_ms, 350, 50, Math.min(timeoutMs, 5_000));
	const maxEvents = asPositiveInt(msg.maxEvents ?? msg.max_events, 3, 1, 20);
	const maxLayers = asPositiveInt(msg.maxLayers ?? msg.max_layers, 80, 1, 500);
	const cdp = browserPilotPersistentCdp();
	if (!cdp?.send) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, "persistent CDP helper is not loaded", { tabId, cmd: "layer.probe" });

	const events: JsonRecord[] = [];
	const subscriptionId = subscribeBrowserPilotCdp(tabId, "LayerTree.layerTreeDidChange", (_source, _method, params) => {
		if (events.length >= maxEvents) return;
		const layers = Array.isArray(params.layers) ? params.layers.map((item) => asRecord(item)) : [];
		events.push({
			layerCount: layers.length,
			layers: layers.slice(0, maxLayers).map(summarizeLayer),
			truncated: layers.length > maxLayers,
		});
	}, { waitId: "layer.probe", kind: "layer.probe", cdpSubscriptions: [] });

	let enabled = false;
	let enableError: string | undefined;
	let disableError: string | undefined;
	try {
		try {
			await cdpSend(tabId, "LayerTree.enable", {}, timeoutMs);
			enabled = true;
		} catch (error) {
			enableError = errorText(error);
			const paintOrder = await probeDomSnapshotPaintOrder(tabId, timeoutMs, maxLayers);
			return { ok: true, data: { tabId, supported: false, enabled: false, enableError, events: [], eventCount: 0, ownerBackendNodeIds: [], paintOrder, proof: paintOrder.supported ? "paint-order-fallback-present" : "not-available" } };
		}
		await cdpSend(tabId, "Runtime.evaluate", { expression: "(() => { void document.body?.offsetHeight; return true; })()", awaitPromise: true, returnByValue: true }, Math.min(timeoutMs, 2_000)).catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, waitMs));
		const ownerIds = new Set<number>();
		for (const event of events) {
			for (const layer of Array.isArray(event.layers) ? event.layers : []) {
				const backendNodeId = Number(asRecord(layer).backendNodeId);
				if (Number.isFinite(backendNodeId) && backendNodeId > 0) ownerIds.add(backendNodeId);
			}
		}
		const paintOrder = await probeDomSnapshotPaintOrder(tabId, timeoutMs, maxLayers);
		return {
			ok: true,
			data: {
				tabId,
				supported: true,
				enabled,
				eventCount: events.length,
				events,
				ownerBackendNodeIds: Array.from(ownerIds.values()).sort((a, b) => a - b),
				paintOrder,
				proof: ownerIds.size ? "owner-backend-node-id-present" : "layer-events-without-owner-backend-node-id",
				limits: { waitMs, maxEvents, maxLayers },
			},
		};
	} finally {
		if (subscriptionId) unsubscribeBrowserPilotCdp(subscriptionId);
		if (enabled) {
			try { await cdpSend(tabId, "LayerTree.disable", {}, Math.min(timeoutMs, 2_000)); }
			catch (error) { disableError = errorText(error); }
		}
		if (disableError) console.warn("[BROWSER-PILOT-LAYER] LayerTree.disable failed", disableError);
	}
}

export async function handleBrowserPilotLayerCommand(cmd: string, tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
	if (cmd === "layer.probe") return await probeLayerTree(tabId, msg);
	return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, "Unknown Browser Pilot layer command: " + cmd, { cmd });
}

export const __browserPilotBridgeModule_layer = { name: "layer", symbols: { probeLayerTree, handleBrowserPilotLayerCommand } };
