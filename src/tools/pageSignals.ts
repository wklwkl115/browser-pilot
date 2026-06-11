import type { BrowserBridgeServer } from "../driver/BrowserBridgeServer.js";
import { isRecord } from "../utils/params.js";

export type PageFingerprint = {
	changeSeq: number;
	url?: string;
	title?: string;
	readyState?: string;
	visibleCount?: number;
	interactiveCount?: number;
	capturedAt?: number;
};

export type RecorderSeq = {
	active: boolean;
	lastSeq?: number;
};

export type PageSignalOptions = {
	browserSessionId?: string;
	tabId?: number;
	timeoutMs: number;
};

export function normalizePageFingerprint(value: unknown): PageFingerprint | undefined {
	const record = isRecord(value) ? value : {};
	const changeSeq = Number(record.changeSeq);
	if (!Number.isFinite(changeSeq)) return undefined;
	return {
		changeSeq,
		...(typeof record.url === "string" ? { url: record.url } : {}),
		...(typeof record.title === "string" ? { title: record.title } : {}),
		...(typeof record.readyState === "string" ? { readyState: record.readyState } : {}),
		...(typeof record.visibleCount === "number" ? { visibleCount: record.visibleCount } : {}),
		...(typeof record.interactiveCount === "number" ? { interactiveCount: record.interactiveCount } : {}),
		...(typeof record.capturedAt === "number" ? { capturedAt: record.capturedAt } : {}),
	};
}

export async function readPageFingerprint(server: BrowserBridgeServer, options: PageSignalOptions): Promise<PageFingerprint | undefined> {
	if (!options.tabId) return undefined;
	try {
		const result = await server.sendCommand({ cmd: "content.fingerprint", tabId: options.tabId, timeoutMs: options.timeoutMs }, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: Math.min(options.timeoutMs, 2_000), internal: true });
		return normalizePageFingerprint(result.data);
	} catch {
		return undefined;
	}
}

export async function readNetworkRecorderSeq(server: BrowserBridgeServer, options: PageSignalOptions): Promise<RecorderSeq> {
	if (!options.tabId) return { active: false };
	try {
		const res = await server.sendCommand({ cmd: "network.status" }, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs });
		const data = isRecord(res.data) ? res.data : {};
		if (data.active === false) return { active: false };
		return { active: true, lastSeq: typeof data.lastSeq === "number" ? data.lastSeq : undefined };
	} catch {
		return { active: false };
	}
}

export async function queryNetworkDelta(server: BrowserBridgeServer, options: PageSignalOptions & { sinceSeq: number }): Promise<Array<Record<string, unknown>>> {
	if (!options.tabId) return [];
	const res = await server.sendCommand({ cmd: "network.list", sinceSeq: options.sinceSeq, limit: 500 }, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs });
	const data = isRecord(res.data) ? res.data : {};
	return Array.isArray(data.items) ? data.items.filter(isRecord) : [];
}

export async function readHookRecorderSeq(server: BrowserBridgeServer, options: PageSignalOptions): Promise<RecorderSeq> {
	if (!options.tabId) return { active: false };
	try {
		const res = await server.sendCommand({ cmd: "hook.status" }, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs });
		const data = isRecord(res.data) ? res.data : {};
		const lastSeq = typeof data.last_seq === "number" ? data.last_seq : undefined;
		return { active: lastSeq !== undefined, lastSeq };
	} catch {
		return { active: false };
	}
}

export async function queryHookDelta(server: BrowserBridgeServer, options: PageSignalOptions & { sinceSeq: number }): Promise<Array<Record<string, unknown>>> {
	if (!options.tabId) return [];
	const res = await server.sendCommand({ cmd: "hook.collect", since_seq: options.sinceSeq, limit: 200 }, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs });
	const data = isRecord(res.data) ? res.data : {};
	return Array.isArray(data.events) ? data.events.filter(isRecord) : [];
}
