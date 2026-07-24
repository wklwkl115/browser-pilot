import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";
import { isRecord } from "../utils/params.js";

export type PageFingerprint = {
	changeSeq: number;
	pageEpoch?: string;
	documentId?: string;
	url?: string;
	title?: string;
	readyState?: string;
	scrollX?: number;
	scrollY?: number;
	viewportWidth?: number;
	viewportHeight?: number;
	devicePixelRatio?: number;
	visibleCount?: number;
	interactiveCount?: number;
	capturedAt?: number;
	dirty?: {
		roots: string[];
		overflow: boolean;
		sinceSeq?: number;
	};
};

export type RecorderSeq = {
	active: boolean;
	lastSeq?: number;
};

export type RecorderDelta = RecorderSeq & { items: Array<Record<string, unknown>> };

export type PageSignalOptions = {
	browserSessionId?: string;
	tabId?: number;
	timeoutMs: number;
	drainDirty?: boolean;
	signal?: AbortSignal;
};

function normalizeDirtyFingerprint(value: unknown): PageFingerprint["dirty"] | undefined {
	const record = isRecord(value) ? value : {};
	const roots: string[] = [];
	if (Array.isArray(record.roots)) {
		for (const item of record.roots) {
			if (typeof item !== "string" || item.trim().length === 0) continue;
			roots.push(item);
			if (roots.length >= 32) break;
		}
	}
	const overflow = record.overflow === true;
	const sinceSeq = Number(record.sinceSeq);
	if (!roots.length && !overflow && !Number.isFinite(sinceSeq)) return undefined;
	return {
		roots,
		overflow,
		...(Number.isFinite(sinceSeq) ? { sinceSeq } : {}),
	};
}

export function normalizePageFingerprint(value: unknown): PageFingerprint | undefined {
	const record = isRecord(value) ? value : {};
	const changeSeq = Number(record.changeSeq);
	if (!Number.isFinite(changeSeq)) return undefined;
	return {
		changeSeq,
		...(typeof record.pageEpoch === "string" ? { pageEpoch: record.pageEpoch } : {}),
		...(typeof record.documentId === "string" ? { documentId: record.documentId } : {}),
		...(typeof record.url === "string" ? { url: record.url } : {}),
		...(typeof record.title === "string" ? { title: record.title } : {}),
		...(typeof record.readyState === "string" ? { readyState: record.readyState } : {}),
		...(typeof record.scrollX === "number" ? { scrollX: record.scrollX } : {}),
		...(typeof record.scrollY === "number" ? { scrollY: record.scrollY } : {}),
		...(typeof record.viewportWidth === "number" ? { viewportWidth: record.viewportWidth } : {}),
		...(typeof record.viewportHeight === "number" ? { viewportHeight: record.viewportHeight } : {}),
		...(typeof record.devicePixelRatio === "number" ? { devicePixelRatio: record.devicePixelRatio } : {}),
		...(typeof record.visibleCount === "number" ? { visibleCount: record.visibleCount } : {}),
		...(typeof record.interactiveCount === "number" ? { interactiveCount: record.interactiveCount } : {}),
		...(typeof record.capturedAt === "number" ? { capturedAt: record.capturedAt } : {}),
		...(normalizeDirtyFingerprint(record.dirty) ? { dirty: normalizeDirtyFingerprint(record.dirty) } : {}),
	};
}

export function samePageFingerprint(left: PageFingerprint, right: PageFingerprint): boolean {
	return left.changeSeq === right.changeSeq
		&& left.pageEpoch === right.pageEpoch
		&& left.documentId === right.documentId
		&& left.url === right.url
		&& left.title === right.title
		&& left.readyState === right.readyState
		&& left.scrollX === right.scrollX
		&& left.scrollY === right.scrollY
		&& left.viewportWidth === right.viewportWidth
		&& left.viewportHeight === right.viewportHeight
		&& left.devicePixelRatio === right.devicePixelRatio
		&& left.visibleCount === right.visibleCount
		&& left.interactiveCount === right.interactiveCount;
}

export async function readPageFingerprint(server: BrowserCommandRuntimePort, options: PageSignalOptions): Promise<PageFingerprint | undefined> {
	options.signal?.throwIfAborted();
	if (!options.tabId) return undefined;
	try {
		const result = await server.sendCommand({ cmd: "content.fingerprint", tabId: options.tabId, timeoutMs: options.timeoutMs, ...(options.drainDirty === true ? { drainDirty: true } : {}) }, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: Math.min(options.timeoutMs, 2_000), internal: true, signal: options.signal });
		return normalizePageFingerprint(result.data);
	} catch {
		options.signal?.throwIfAborted();
		return undefined;
	}
}

export async function queryNetworkDelta(server: BrowserCommandRuntimePort, options: PageSignalOptions & { sinceSeq: number }): Promise<RecorderDelta> {
	options.signal?.throwIfAborted();
	if (!options.tabId) return { active: false, items: [] };
	const res = await server.sendCommand({ cmd: "network.list", sinceSeq: options.sinceSeq, limit: 500 }, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs, signal: options.signal });
	const data = isRecord(res.data) ? res.data : {};
	return {
		active: data.active !== false,
		...(typeof data.lastSeq === "number" ? { lastSeq: data.lastSeq } : {}),
		items: Array.isArray(data.items) ? data.items.filter(isRecord) : [],
	};
}

export async function queryHookDelta(server: BrowserCommandRuntimePort, options: PageSignalOptions & { sinceSeq: number }): Promise<RecorderDelta> {
	options.signal?.throwIfAborted();
	if (!options.tabId) return { active: false, items: [] };
	const res = await server.sendCommand({ cmd: "hook.collect", sinceSeq: options.sinceSeq, limit: 200 }, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs, signal: options.signal });
	const data = isRecord(res.data) ? res.data : {};
	const lastSeq = typeof data.lastSeq === "number" ? data.lastSeq : typeof data.last_seq === "number" ? data.last_seq : undefined;
	return {
		active: data.active !== false,
		...(lastSeq !== undefined ? { lastSeq } : {}),
		items: Array.isArray(data.events) ? data.events.filter(isRecord) : [],
	};
}
