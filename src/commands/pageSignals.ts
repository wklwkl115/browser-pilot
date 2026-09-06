// Concept: "Fingerprint bracket" (docs/concepts.md). A lightweight page fingerprint read before and
// after browser reads or writes, used to detect torn observations and to summarize write effects.
import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";
import { isRecord } from "../utils/params.js";

export type PageFingerprint = {
	changeSeq: number;
	observerEpoch?: string;
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
	elementCount?: number;
	visibleCount?: number;
	interactiveCount?: number;
	capturedAt?: number;
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
	signal?: AbortSignal;
};

export function normalizePageFingerprint(value: unknown): PageFingerprint | undefined {
	const record = isRecord(value) ? value : {};
	const changeSeq = Number(record.changeSeq);
	if (!Number.isFinite(changeSeq)) return undefined;
	return {
		changeSeq,
		...(typeof record.observerEpoch === "string" ? { observerEpoch: record.observerEpoch } : {}),
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
		...(typeof record.elementCount === "number" ? { elementCount: record.elementCount } : {}),
		...(typeof record.visibleCount === "number" ? { visibleCount: record.visibleCount } : {}),
		...(typeof record.interactiveCount === "number" ? { interactiveCount: record.interactiveCount } : {}),
		...(typeof record.capturedAt === "number" ? { capturedAt: record.capturedAt } : {}),
	};
}

export function pageFingerprintDiscriminators(fingerprint: PageFingerprint): readonly unknown[] {
	return [
		fingerprint.changeSeq,
		fingerprint.observerEpoch,
		fingerprint.pageEpoch,
		fingerprint.documentId,
		fingerprint.url,
		fingerprint.title,
		fingerprint.readyState,
		fingerprint.scrollX,
		fingerprint.scrollY,
		fingerprint.viewportWidth,
		fingerprint.viewportHeight,
		fingerprint.devicePixelRatio,
		fingerprint.elementCount,
		fingerprint.visibleCount,
		fingerprint.interactiveCount,
	];
}

export function samePageFingerprint(left: PageFingerprint, right: PageFingerprint): boolean {
	const rightValues = pageFingerprintDiscriminators(right);
	return pageFingerprintDiscriminators(left).every((value, index) => value === rightValues[index]);
}

/**
 * Mutation records an observation bracket may absorb before it counts as torn. Live regions
 * (carousels, timers, ad slots) mutate constantly without changing which controls exist; the
 * structural counts still have to match exactly.
 */
export const OBSERVATION_CHANGE_SEQ_TOLERANCE = 12;

export type FingerprintCoherence = { coherent: boolean; changeSeqDrift: number; reason?: string };

/** Coherence for DOM+AX fusion: same document, same layout, same control counts, bounded mutation drift. */
export function coherentPageFingerprint(
	before: PageFingerprint,
	after: PageFingerprint,
	tolerance = OBSERVATION_CHANGE_SEQ_TOLERANCE,
): FingerprintCoherence {
	const drift = after.changeSeq - before.changeSeq;
	const identityKeys: Array<keyof PageFingerprint> = ["observerEpoch", "pageEpoch", "documentId", "url"];
	for (const key of identityKeys)
		if (before[key] !== after[key]) return { coherent: false, changeSeqDrift: drift, reason: `${key} changed` };
	const layoutKeys: Array<keyof PageFingerprint> = [
		"readyState",
		"scrollX",
		"scrollY",
		"viewportWidth",
		"viewportHeight",
		"devicePixelRatio",
		"elementCount",
		"visibleCount",
		"interactiveCount",
	];
	for (const key of layoutKeys)
		if (before[key] !== after[key]) return { coherent: false, changeSeqDrift: drift, reason: `${key} changed` };
	if (drift < 0 || drift > tolerance)
		return { coherent: false, changeSeqDrift: drift, reason: `changeSeq drifted by ${drift}` };
	return { coherent: true, changeSeqDrift: drift };
}

export async function readPageFingerprint(
	server: BrowserCommandRuntimePort,
	options: PageSignalOptions,
): Promise<PageFingerprint | undefined> {
	options.signal?.throwIfAborted();
	if (!options.tabId) return undefined;
	try {
		const result = await server.sendCommand(
			{ cmd: "content.fingerprint", tabId: options.tabId, timeoutMs: options.timeoutMs },
			{
				browserSessionId: options.browserSessionId,
				tabId: options.tabId,
				timeoutMs: Math.min(options.timeoutMs, 2_000),
				internal: true,
				signal: options.signal,
			},
		);
		return normalizePageFingerprint(result.data);
	} catch {
		options.signal?.throwIfAborted();
		return undefined;
	}
}

export async function queryNetworkDelta(
	server: BrowserCommandRuntimePort,
	options: PageSignalOptions & { sinceSeq: number },
): Promise<RecorderDelta> {
	options.signal?.throwIfAborted();
	if (!options.tabId) return { active: false, items: [] };
	const res = await server.sendCommand(
		{ cmd: "network.list", sinceSeq: options.sinceSeq, limit: 500 },
		{
			browserSessionId: options.browserSessionId,
			tabId: options.tabId,
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		},
	);
	const data = isRecord(res.data) ? res.data : {};
	return {
		active: data.active !== false,
		...(typeof data.lastSeq === "number" ? { lastSeq: data.lastSeq } : {}),
		items: Array.isArray(data.items) ? data.items.filter(isRecord) : [],
	};
}

export async function queryHookDelta(
	server: BrowserCommandRuntimePort,
	options: PageSignalOptions & { sinceSeq: number },
): Promise<RecorderDelta> {
	options.signal?.throwIfAborted();
	if (!options.tabId) return { active: false, items: [] };
	const res = await server.sendCommand(
		{ cmd: "hook.collect", sinceSeq: options.sinceSeq, limit: 200 },
		{
			browserSessionId: options.browserSessionId,
			tabId: options.tabId,
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		},
	);
	const data = isRecord(res.data) ? res.data : {};
	const lastSeq =
		typeof data.lastSeq === "number" ? data.lastSeq : typeof data.last_seq === "number" ? data.last_seq : undefined;
	return {
		active: data.active !== false,
		...(lastSeq !== undefined ? { lastSeq } : {}),
		items: Array.isArray(data.events) ? data.events.filter(isRecord) : [],
	};
}
