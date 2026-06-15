import { normalizePersistentBrowserPilotResponse, browserPilotError, browserPilotEval, browserPilotPersistentCdp, BROWSER_PILOT_ERROR_CODES } from "./runtime";
import { subscribeBrowserPilotCdp, unsubscribeBrowserPilotCdp } from "./wait_cdp";
import type { JsonRecord, BrowserPilotBridgeCommand, BrowserPilotBridgeResponse } from "./types";

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function asPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(n)));
}

function selectorText(value: unknown): string {
	const text = String(value || "").trim();
	if (!text) throw new Error("selector is required");
	return text;
}

function sinkHintsExpression(selector: string): string {
	return `(() => {
		const selector = ${JSON.stringify(selector)};
		let node;
		try { node = document.querySelector(selector); } catch (error) { return { ok:false, error_code:'INVALID_SELECTOR', error:String(error && error.message ? error.message : error) }; }
		if (!node) return { ok:false, error_code:'SELECTOR_NOT_FOUND', error:'selector did not match an element' };
		const text = String(node.innerText || node.textContent || '').trim();
		const attrs = {
			onclick: node.getAttribute ? node.getAttribute('onclick') || '' : '',
			onchange: node.getAttribute ? node.getAttribute('onchange') || '' : '',
			onsubmit: node.getAttribute ? node.getAttribute('onsubmit') || '' : '',
		};
		const sinks = [];
		const sinkNode = document.querySelector('#sink,[data-sink],[data-dom-sink]');
		if (sinkNode) {
			sinks.push({
				selector: sinkNode.id ? ('#' + sinkNode.id) : (sinkNode.getAttribute && sinkNode.getAttribute('data-sink')) || '',
				innerHTML: String(sinkNode.innerHTML || '').slice(0, 240),
				text: String(sinkNode.textContent || '').trim().slice(0, 240),
			});
		}
		const hints = [];
		for (const [name, value] of Object.entries(attrs)) {
			if (value) hints.push({ kind: 'inline-handler', eventType: name.replace(/^on/, ''), detail: value.slice(0, 240), suspicious: /innerHTML|outerHTML|insertAdjacentHTML|document.write/i.test(value) });
		}
		if (/pay|submit|login|continue|checkout/i.test(text)) hints.push({ kind: 'actionable-node', eventType: 'click', detail: text.slice(0, 120), suspicious: sinks.length > 0 });
		return { ok:true, node: { tagName: node.tagName || '', id: node.id || '', text: text.slice(0, 240) }, sinks, hints };
	})()`;
}

async function cdpSend(tabId: number, method: string, params: JsonRecord = {}, timeoutMs?: number): Promise<JsonRecord> {
	const cdp = browserPilotPersistentCdp();
	if (!cdp?.send) throw new Error("persistent CDP helper is not loaded");
	const response = normalizePersistentBrowserPilotResponse(await cdp.send(tabId, method, params, { persistent: true, name: "dom_flow", timeoutMs }));
	if (!response || response.ok === false) {
		const error = asRecord(response?.error);
		throw new Error(String(error.message || response?.message || response?.error || `${method} failed`));
	}
	return asRecord(asRecord(response.data).result || response.result || response.data || {});
}

function listenerSourceFact(entry: JsonRecord, scriptLookup: Map<string, JsonRecord>, pageUrl?: string): JsonRecord {
	const handler = asRecord(entry.handler);
	const object = asRecord(handler.object || handler.description ? handler : {});
	const scriptId = String(object.scriptId || handler.scriptId || "").trim();
	const script = scriptLookup.get(scriptId) || {};
	return {
		scriptId: scriptId || undefined,
		url: script.url || pageUrl,
		line: object.lineNumber ?? handler.lineNumber,
		column: object.columnNumber ?? handler.columnNumber,
		functionName: object.className || object.description || handler.description,
		sourceKind: script.url ? "script" : pageUrl ? "inline-page" : undefined,
	};
}

async function collectDebuggerScriptLookup(tabId: number, timeoutMs?: number): Promise<Map<string, JsonRecord>> {
	const lookup = new Map<string, JsonRecord>();
	const cdp = browserPilotPersistentCdp();
	if (!cdp?.send) return lookup;
	const subscriptionId = subscribeBrowserPilotCdp(tabId, "Debugger.scriptParsed", (_source, _method, params) => {
		const entry = asRecord(params);
		const scriptId = String(entry.scriptId || "").trim();
		if (!scriptId) return;
		lookup.set(scriptId, {
			url: entry.url || undefined,
			startLine: entry.startLine,
			startColumn: entry.startColumn,
			endLine: entry.endLine,
			endColumn: entry.endColumn,
			hash: entry.hash,
		});
	});
	try {
		await cdpSend(tabId, "Debugger.enable", {}, timeoutMs);
		await new Promise((resolve) => setTimeout(resolve, 60));
	} finally {
		if (subscriptionId) unsubscribeBrowserPilotCdp(subscriptionId);
	}
	return lookup;
}

type ResolvedNode = { objectId: string; node: JsonRecord; pageUrl?: string };

async function resolveNodeObjectId(tabId: number, selector: string, timeoutMs?: number): Promise<ResolvedNode> {
	const probeExpression = `(() => {
		const selector = ${JSON.stringify(selector)};
		let node;
		try { node = document.querySelector(selector); } catch (error) { return { ok:false, error_code:'INVALID_SELECTOR', error:String(error && error.message ? error.message : error) }; }
		if (!node) return { ok:false, error_code:'SELECTOR_NOT_FOUND', error:'selector did not match an element' };
		const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
		return {
			ok:true,
			nodeInfo: {
				tagName: node.tagName || '',
				id: node.id || '',
				className: typeof node.className === 'string' ? node.className : '',
				text: String(node.innerText || node.textContent || '').trim().slice(0, 240),
				rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
			},
			pageUrl: location.href,
		};
	})()`;
	const probe = await browserPilotEval(tabId, probeExpression, true, { timeoutMs });
	if (!probe.ok) throw new Error(String(probe.error || probe.message || "Runtime.evaluate failed"));
	const probeData = asRecord(probe.data);
	if (probeData.ok === false && probeData.error_code === "INVALID_SELECTOR") throw new Error(`INVALID_SELECTOR: ${String(probeData.error || "invalid selector")}`);
	if (probeData.ok === false && probeData.error_code === "SELECTOR_NOT_FOUND") throw new Error(`SELECTOR_NOT_FOUND: ${String(probeData.error || "selector did not match an element")}`);
	const resolveExpression = `(() => document.querySelector(${JSON.stringify(selector)}))()`;
	const response = normalizePersistentBrowserPilotResponse(await (browserPilotPersistentCdp()!.send!(tabId, "Runtime.evaluate", { expression: resolveExpression, awaitPromise: true, returnByValue: false }, { persistent: true, name: "dom_flow_resolve", timeoutMs })));
	if (!response || response.ok === false) {
		const error = asRecord(response?.error);
		throw new Error(String(error.message || response?.message || response?.error || "Runtime.evaluate failed"));
	}
	const result = asRecord(asRecord(response.data).result || response.result || response.data || {});
	const remote = asRecord(result.result);
	const objectId = String(remote.objectId || "").trim();
	if (!objectId) throw new Error("failed to resolve selector objectId");
	return { objectId, node: asRecord(probeData.nodeInfo), pageUrl: typeof probeData.pageUrl === "string" ? probeData.pageUrl : undefined };
}

export async function collectNodeListeners(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
	try {
		const selector = selectorText(msg.selector);
		const timeoutMs = asPositiveInt(msg.timeoutMs ?? msg.timeout_ms, 10_000, 1, 60_000);
		const maxListeners = asPositiveInt(msg.maxListeners ?? msg.max_listeners, 20, 1, 200);
		const { objectId, node, pageUrl } = await resolveNodeObjectId(tabId, selector, timeoutMs);
		const listenerResult = await cdpSend(tabId, "DOMDebugger.getEventListeners", { objectId, depth: 1, pierce: true }, timeoutMs);
		const listeners = Array.isArray(listenerResult.listeners) ? listenerResult.listeners.slice(0, maxListeners).map((item) => asRecord(item)) : [];
		const scripts = await collectDebuggerScriptLookup(tabId, timeoutMs);
		return {
			ok: true,
			data: {
				tabId,
				selector,
				node,
				listeners: listeners.map((listener) => ({
					type: listener.type,
					useCapture: listener.useCapture,
					passive: listener.passive,
					once: listener.once,
					backendNodeId: listener.backendNodeId,
					handler: listenerSourceFact(listener, scripts, pageUrl),
				})),
				count: listeners.length,
				truncated: Array.isArray(listenerResult.listeners) ? listenerResult.listeners.length > listeners.length : false,
			},
		};
	} catch (error) {
		const message = errorText(error);
		if (/INVALID_SELECTOR/i.test(message)) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_SELECTOR, message, { tabId, selector: msg.selector });
		if (/SELECTOR_NOT_FOUND|selector did not match/i.test(message)) return browserPilotError(BROWSER_PILOT_ERROR_CODES.SELECTOR_NOT_FOUND, message, { tabId, selector: msg.selector });
		return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, message, { tabId, selector: msg.selector });
	}
}

export async function collectNodeSinkHints(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
	try {
		const selector = selectorText(msg.selector);
		const timeoutMs = asPositiveInt(msg.timeoutMs ?? msg.timeout_ms, 10_000, 1, 60_000);
		const result = await browserPilotEval(tabId, sinkHintsExpression(selector), true, { timeoutMs });
		if (!result.ok) return result;
		const data = asRecord(result.data);
		if (data.ok === false && data.error_code === 'INVALID_SELECTOR') return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_SELECTOR, data.error || 'invalid selector', { tabId, selector });
		if (data.ok === false && data.error_code === 'SELECTOR_NOT_FOUND') return browserPilotError(BROWSER_PILOT_ERROR_CODES.SELECTOR_NOT_FOUND, data.error || 'selector did not match an element', { tabId, selector });
		return {
			ok: true,
			data: {
				tabId,
				selector,
				node: asRecord(data.node),
				sinks: Array.isArray(data.sinks) ? data.sinks.map((item) => asRecord(item)) : [],
				hints: Array.isArray(data.hints) ? data.hints.map((item) => asRecord(item)) : [],
				count: Array.isArray(data.hints) ? data.hints.length : 0,
			},
		};
	} catch (error) {
		const message = errorText(error);
		if (/INVALID_SELECTOR/i.test(message)) return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_SELECTOR, message, { tabId, selector: msg.selector });
		if (/SELECTOR_NOT_FOUND|selector did not match/i.test(message)) return browserPilotError(BROWSER_PILOT_ERROR_CODES.SELECTOR_NOT_FOUND, message, { tabId, selector: msg.selector });
		return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, message, { tabId, selector: msg.selector });
	}
}

export async function collectNodeListenerChain(tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
	const listeners = await collectNodeListeners(tabId, msg);
	if (!listeners.ok) return listeners;
	const data = asRecord(listeners.data);
	const chain = Array.isArray(data.listeners) ? data.listeners.map((listener, index) => {
		const entry = asRecord(listener);
		const handler = asRecord(entry.handler);
		return {
			index,
			eventType: entry.type,
			flags: {
				capture: entry.useCapture === true,
				passive: entry.passive === true,
				once: entry.once === true,
			},
			handler,
		};
	}) : [];
	return {
		ok: true,
		data: {
			tabId,
			selector: data.selector,
			node: data.node,
			chain,
			count: chain.length,
		},
	};
}
