import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";
import type { BrowserBridgeExecutionResult } from "../ports/BrowserRuntimeTypes.js";
import { readPageFingerprint, type PageFingerprint } from "./pageSignals.js";

const EFFECT_SIGNAL_TIMEOUT_MS = 250;
const EFFECT_QUIET_MS = 100;
const EFFECT_SETTLE_MS = 300;

export type CommandEffect = {
	observed: boolean;
	changed: boolean | null;
	settled: boolean;
	verification?: "verified" | "failed" | "inconclusive";
	elapsedMs: number;
	page?: {
		navigation?: { from?: string; to?: string };
		changeSeqDelta?: number;
		readyState?: string;
		visibleCountDelta?: number;
		interactiveCountDelta?: number;
	};
	newTabs?: number;
};

type CommandEffectOptions = {
	browserSessionId?: string;
	tabId?: number;
	timeoutMs: number;
	deadlineAt: number;
	signal?: AbortSignal;
	quietMs?: number;
	settleMs?: number;
	verify?: () => Promise<boolean>;
};

function finiteDelta(after: number | undefined, before: number | undefined): number | undefined {
	return typeof after === "number" && typeof before === "number" ? after - before : undefined;
}

function changedString(after: string | undefined, before: string | undefined): boolean {
	return typeof after === "string" && typeof before === "string" && after !== before;
}

function pageGenerationChanged(before: PageFingerprint, after: PageFingerprint): boolean {
	return changedString(after.pageEpoch, before.pageEpoch)
		|| changedString(after.documentId, before.documentId)
		|| changedString(after.url, before.url)
		|| after.changeSeq < before.changeSeq;
}

function sameFingerprint(left: PageFingerprint, right: PageFingerprint): boolean {
	return left.changeSeq === right.changeSeq
		&& left.pageEpoch === right.pageEpoch
		&& left.documentId === right.documentId
		&& left.url === right.url
		&& left.title === right.title
		&& left.readyState === right.readyState
		&& left.visibleCount === right.visibleCount
		&& left.interactiveCount === right.interactiveCount;
}

function newTabCount(result: BrowserBridgeExecutionResult): number {
	return Array.isArray(result.newTabs) ? result.newTabs.length : 0;
}

export function summarizeCommandEffect(
	before: PageFingerprint | undefined,
	after: PageFingerprint | undefined,
	result: BrowserBridgeExecutionResult,
	options: { settled: boolean; elapsedMs: number; verification?: CommandEffect["verification"] },
): CommandEffect {
	const newTabs = newTabCount(result);
	if (!before || !after) {
		return {
			observed: false,
			changed: newTabs > 0 ? true : null,
			settled: false,
			...(options.verification ? { verification: options.verification } : {}),
			elapsedMs: Math.max(0, Math.round(options.elapsedMs)),
			...(newTabs > 0 ? { newTabs } : {}),
		};
	}

	const navigated = pageGenerationChanged(before, after);
	const changeSeqDelta = navigated ? undefined : Math.max(0, after.changeSeq - before.changeSeq);
	const visibleCountDelta = finiteDelta(after.visibleCount, before.visibleCount);
	const interactiveCountDelta = finiteDelta(after.interactiveCount, before.interactiveCount);
	const pageChanged = navigated
		|| (changeSeqDelta ?? 0) > 0
		|| (visibleCountDelta ?? 0) !== 0
		|| (interactiveCountDelta ?? 0) !== 0
		|| changedString(after.title, before.title)
		|| changedString(after.readyState, before.readyState);

	return {
		observed: true,
		changed: pageChanged || newTabs > 0,
		settled: options.settled && after.readyState !== "loading",
		...(options.verification ? { verification: options.verification } : {}),
		elapsedMs: Math.max(0, Math.round(options.elapsedMs)),
		page: {
			...(navigated ? { navigation: { ...(before.url ? { from: before.url } : {}), ...(after.url ? { to: after.url } : {}) } } : {}),
			...(changeSeqDelta !== undefined ? { changeSeqDelta } : {}),
			...(after.readyState ? { readyState: after.readyState } : {}),
			...(visibleCountDelta !== undefined ? { visibleCountDelta } : {}),
			...(interactiveCountDelta !== undefined ? { interactiveCountDelta } : {}),
		},
		...(newTabs > 0 ? { newTabs } : {}),
	};
}

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0 || signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

async function captureFingerprint(server: BrowserCommandRuntimePort, options: CommandEffectOptions): Promise<PageFingerprint | undefined> {
	if (options.tabId === undefined || options.signal?.aborted) return undefined;
	const remainingMs = Math.max(0, options.deadlineAt - Date.now());
	if (remainingMs === 0) return undefined;
	return await readPageFingerprint(server, {
		browserSessionId: options.browserSessionId,
		tabId: options.tabId,
		timeoutMs: Math.max(1, Math.min(EFFECT_SIGNAL_TIMEOUT_MS, options.timeoutMs, remainingMs)),
		signal: options.signal,
	});
}

async function verifyPostcondition(options: CommandEffectOptions): Promise<CommandEffect["verification"]> {
	if (!options.verify) return undefined;
	let observedFalse = false;
	while (!options.signal?.aborted && Date.now() < options.deadlineAt) {
		try {
			if (await options.verify()) return "verified";
			observedFalse = true;
		} catch {
			return "inconclusive";
		}
		await waitFor(Math.min(EFFECT_QUIET_MS, Math.max(0, options.deadlineAt - Date.now())), options.signal);
	}
	return options.signal?.aborted ? "inconclusive" : observedFalse ? "failed" : "inconclusive";
}

export async function withCommandEffect<T extends BrowserBridgeExecutionResult>(
	server: BrowserCommandRuntimePort,
	options: CommandEffectOptions,
	dispatch: () => Promise<T>,
): Promise<{ result: T; effect: CommandEffect }> {
	const startedAt = Date.now();
	const before = await captureFingerprint(server, options);
	const result = await dispatch();
	let after = await captureFingerprint(server, options);
	let settled = false;

	if (before) {
		const quietMs = Math.max(0, options.quietMs ?? EFFECT_QUIET_MS);
		const settleDeadline = Math.min(options.deadlineAt, Date.now() + Math.max(0, options.settleMs ?? EFFECT_SETTLE_MS));
		let previous = after;
		while (!options.signal?.aborted && Date.now() + quietMs <= settleDeadline) {
			await waitFor(quietMs, options.signal);
			if (options.signal?.aborted) break;
			const current = await captureFingerprint(server, { ...options, deadlineAt: settleDeadline });
			if (!current) continue;
			after = current;
			if (previous && sameFingerprint(previous, current) && current.readyState !== "loading") {
				settled = true;
				break;
			}
			previous = current;
		}
	}
	const verification = await verifyPostcondition(options);

	return {
		result,
		effect: summarizeCommandEffect(before, after, result, { settled, verification, elapsedMs: Date.now() - startedAt }),
	};
}
