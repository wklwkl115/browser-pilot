import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";
import type { BrowserBridgeExecutionResult } from "../ports/BrowserRuntimeTypes.js";
import type { VerificationResult } from "../kernels/abml/types.js";
import { readPageFingerprint, samePageFingerprint, type PageFingerprint } from "./pageSignals.js";

const EFFECT_SIGNAL_TIMEOUT_MS = 250;
const EFFECT_QUIET_MS = 100;
const EFFECT_SETTLE_MS = 300;

export type CommandEffect = {
	observed: boolean;
	changed: boolean | null;
	settled: boolean;
	elapsedMs: number;
	page?: {
		navigation?: { from?: string; to?: string };
		changeSeqDelta?: number;
		readyState?: string;
		visibleCountDelta?: number;
		interactiveCountDelta?: number;
	};
	newTabs?: number;
	visual?: {
		observed: boolean;
		changed: boolean | null;
		beforeSha256?: string;
		afterSha256?: string;
		resourceUri?: string;
	};
};

type CommandEffectOptions = {
	browserSessionId?: string;
	tabId?: number;
	timeoutMs: number;
	deadlineAt: number;
	signal?: AbortSignal;
	quietMs?: number;
	settleMs?: number;
	initialVerification?: VerificationResult;
	verify?: () => Promise<VerificationResult>;
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

function newTabCount(result: BrowserBridgeExecutionResult): number {
	return Array.isArray(result.newTabs) ? result.newTabs.length : 0;
}

export function summarizeCommandEffect(
	before: PageFingerprint | undefined,
	after: PageFingerprint | undefined,
	result: BrowserBridgeExecutionResult,
	options: { settled: boolean; elapsedMs: number },
): CommandEffect {
	const newTabs = newTabCount(result);
	if (!before || !after) {
		return {
			observed: false,
			changed: newTabs > 0 ? true : null,
			settled: false,
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

function withVerificationElapsed(result: VerificationResult, startedAt: number): VerificationResult {
	return { ...result, elapsedMs: Math.max(0, Math.round(Date.now() - startedAt)) };
}

function inconclusiveVerification(last: VerificationResult | undefined, startedAt: number, summary: string): VerificationResult {
	if (last) {
		return withVerificationElapsed({
			...last,
			status: "inconclusive",
			evidence: [...last.evidence, { kind: "verification-runtime", summary }],
		}, startedAt);
	}
	return {
		status: "inconclusive",
		verb: "browser-operation",
		observed: {},
		evidence: [{ kind: "verification-runtime", summary }],
		elapsedMs: Math.max(0, Math.round(Date.now() - startedAt)),
	};
}

async function verifyPostcondition(options: CommandEffectOptions): Promise<VerificationResult | undefined> {
	if (!options.verify) return undefined;
	const startedAt = Date.now();
	let last = options.initialVerification;
	while (!options.signal?.aborted && Date.now() < options.deadlineAt) {
		try {
			last = await options.verify();
			if (last.status === "verified") return withVerificationElapsed(last, startedAt);
		} catch {
			return inconclusiveVerification(last, startedAt, "Postcondition observation failed");
		}
		await waitFor(Math.min(EFFECT_QUIET_MS, Math.max(0, options.deadlineAt - Date.now())), options.signal);
	}
	if (options.signal?.aborted) return inconclusiveVerification(last, startedAt, "Postcondition observation was cancelled");
	return last ? withVerificationElapsed(last, startedAt) : inconclusiveVerification(undefined, startedAt, "Postcondition was not observed before the deadline");
}

export async function withCommandEffect<T extends BrowserBridgeExecutionResult>(
	server: BrowserCommandRuntimePort,
	options: CommandEffectOptions,
	dispatch: () => Promise<T>,
): Promise<{ result: T; effect: CommandEffect; verification?: VerificationResult }> {
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
			if (previous && samePageFingerprint(previous, current) && current.readyState !== "loading") {
				settled = true;
				break;
			}
			previous = current;
		}
	}
	const verification = await verifyPostcondition(options);

	return {
		result,
		effect: summarizeCommandEffect(before, after, result, { settled, elapsedMs: Date.now() - startedAt }),
		...(verification ? { verification } : {}),
	};
}
