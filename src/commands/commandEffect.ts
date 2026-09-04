import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";
import type { BrowserBridgeExecutionResult } from "../ports/BrowserRuntimeTypes.js";
import type { VerificationResult } from "../kernels/abml/types.js";
import { readPageFingerprint, samePageFingerprint, type PageFingerprint } from "./pageSignals.js";

/**
 * Budget for one fingerprint read. The content script does a bounded layout pass, which on heavy
 * pages can take a few hundred milliseconds; a budget that is too tight turns every write on such
 * pages into an unobserved effect.
 */
const EFFECT_SIGNAL_TIMEOUT_MS = 1_000;
const EFFECT_QUIET_MS = 100;
const EFFECT_SETTLE_MS = 300;
/**
 * Postcondition polling has its own budget and backs off geometrically: a wrong `expect` must not
 * consume the whole tool timeout. A quiet page does not prove asynchronous work is finished,
 * so retryable unmet states keep polling until success, cancellation, or the verification deadline.
 */
const VERIFY_BUDGET_MS = 5_000;
const VERIFY_INITIAL_POLL_MS = 100;
const VERIFY_MAX_POLL_MS = 1_000;

export type CommandEffectUnobservedReason = "no-tab" | "deadline-exhausted" | "fingerprint-unavailable";

export type CommandEffect = {
	observed: boolean;
	/** Present when observed is false: why the page could not be fingerprinted around the write. */
	unobservedReason?: CommandEffectUnobservedReason;
	changed: boolean | null;
	settled: boolean;
	elapsedMs: number;
	page?: {
		navigation?: { from?: string; to?: string };
		changeSeqDelta?: number;
		readyState?: string;
		elementCountDelta?: number;
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
	/** Upper bound for postcondition polling; defaults to VERIFY_BUDGET_MS and never exceeds deadlineAt. */
	verifyBudgetMs?: number;
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
	return (
		changedString(after.pageEpoch, before.pageEpoch) ||
		changedString(after.documentId, before.documentId) ||
		changedString(after.url, before.url) ||
		after.changeSeq < before.changeSeq
	);
}

function newTabCount(result: BrowserBridgeExecutionResult): number {
	return Array.isArray(result.newTabs) ? result.newTabs.length : 0;
}

export function summarizeCommandEffect(
	before: PageFingerprint | undefined,
	after: PageFingerprint | undefined,
	result: BrowserBridgeExecutionResult,
	options: { settled: boolean; elapsedMs: number; unobservedReason?: CommandEffectUnobservedReason },
): CommandEffect {
	const newTabs = newTabCount(result);
	if (!before || !after) {
		return {
			observed: false,
			unobservedReason: options.unobservedReason ?? "fingerprint-unavailable",
			changed: newTabs > 0 ? true : null,
			settled: false,
			elapsedMs: Math.max(0, Math.round(options.elapsedMs)),
			...(newTabs > 0 ? { newTabs } : {}),
		};
	}

	const navigated = pageGenerationChanged(before, after);
	const changeSeqDelta = navigated ? undefined : Math.max(0, after.changeSeq - before.changeSeq);
	const elementCountDelta = finiteDelta(after.elementCount, before.elementCount);
	const visibleCountDelta = finiteDelta(after.visibleCount, before.visibleCount);
	const interactiveCountDelta = finiteDelta(after.interactiveCount, before.interactiveCount);
	const pageChanged =
		navigated ||
		(changeSeqDelta ?? 0) > 0 ||
		(elementCountDelta ?? 0) !== 0 ||
		(visibleCountDelta ?? 0) !== 0 ||
		(interactiveCountDelta ?? 0) !== 0 ||
		changedString(after.title, before.title) ||
		changedString(after.readyState, before.readyState);

	return {
		observed: true,
		changed: pageChanged || newTabs > 0,
		settled: options.settled && after.readyState !== "loading",
		elapsedMs: Math.max(0, Math.round(options.elapsedMs)),
		page: {
			...(navigated
				? {
						navigation: {
							...(before.url ? { from: before.url } : {}),
							...(after.url ? { to: after.url } : {}),
						},
					}
				: {}),
			...(changeSeqDelta !== undefined ? { changeSeqDelta } : {}),
			...(after.readyState ? { readyState: after.readyState } : {}),
			...(elementCountDelta !== undefined ? { elementCountDelta } : {}),
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

type FingerprintCapture = { fingerprint?: PageFingerprint; reason?: CommandEffectUnobservedReason };

async function captureFingerprint(
	server: BrowserCommandRuntimePort,
	options: CommandEffectOptions,
): Promise<FingerprintCapture> {
	if (options.tabId === undefined) return { reason: "no-tab" };
	if (options.signal?.aborted) return { reason: "deadline-exhausted" };
	const remainingMs = Math.max(0, options.deadlineAt - Date.now());
	if (remainingMs === 0) return { reason: "deadline-exhausted" };
	const fingerprint = await readPageFingerprint(server, {
		browserSessionId: options.browserSessionId,
		tabId: options.tabId,
		timeoutMs: Math.max(1, Math.min(EFFECT_SIGNAL_TIMEOUT_MS, options.timeoutMs, remainingMs)),
		signal: options.signal,
	});
	return fingerprint ? { fingerprint } : { reason: "fingerprint-unavailable" };
}

function withVerificationElapsed(result: VerificationResult, startedAt: number): VerificationResult {
	return { ...result, elapsedMs: Math.max(0, Math.round(Date.now() - startedAt)) };
}

function inconclusiveVerification(
	last: VerificationResult | undefined,
	startedAt: number,
	summary: string,
): VerificationResult {
	if (last) {
		return withVerificationElapsed(
			{
				...last,
				status: "inconclusive",
				evidence: [...last.evidence, { kind: "verification-runtime", summary }],
			},
			startedAt,
		);
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
	const deadlineAt = Math.min(options.deadlineAt, startedAt + (options.verifyBudgetMs ?? VERIFY_BUDGET_MS));
	let last = options.initialVerification;
	let pollMs = VERIFY_INITIAL_POLL_MS;
	while (!options.signal?.aborted && Date.now() < deadlineAt) {
		try {
			last = await options.verify();
			if (last.status === "verified") return withVerificationElapsed(last, startedAt);
			if (last.retryable === false) return withVerificationElapsed(last, startedAt);
		} catch {
			return inconclusiveVerification(last, startedAt, "Postcondition observation failed");
		}
		await waitFor(Math.min(pollMs, Math.max(0, deadlineAt - Date.now())), options.signal);
		pollMs = Math.min(VERIFY_MAX_POLL_MS, pollMs * 2);
	}
	if (options.signal?.aborted)
		return inconclusiveVerification(last, startedAt, "Postcondition observation was cancelled");
	return last
		? withVerificationElapsed(last, startedAt)
		: inconclusiveVerification(undefined, startedAt, "Postcondition was not observed before the deadline");
}

export async function withCommandEffect<T extends BrowserBridgeExecutionResult>(
	server: BrowserCommandRuntimePort,
	options: CommandEffectOptions,
	dispatch: () => Promise<T>,
): Promise<{ result: T; effect: CommandEffect; verification?: VerificationResult }> {
	const startedAt = Date.now();
	const beforeCapture = await captureFingerprint(server, options);
	const before = beforeCapture.fingerprint;
	const result = await dispatch();
	const afterCapture = await captureFingerprint(server, options);
	let after = afterCapture.fingerprint;
	let settled = false;

	if (before) {
		const quietMs = Math.max(0, options.quietMs ?? EFFECT_QUIET_MS);
		const settleDeadline = Math.min(
			options.deadlineAt,
			Date.now() + Math.max(0, options.settleMs ?? EFFECT_SETTLE_MS),
		);
		let previous = after;
		while (!options.signal?.aborted && Date.now() + quietMs <= settleDeadline) {
			await waitFor(quietMs, options.signal);
			if (options.signal?.aborted) break;
			const current = (await captureFingerprint(server, { ...options, deadlineAt: settleDeadline })).fingerprint;
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
		effect: summarizeCommandEffect(before, after, result, {
			settled,
			elapsedMs: Date.now() - startedAt,
			unobservedReason: beforeCapture.reason ?? afterCapture.reason,
		}),
		...(verification ? { verification } : {}),
	};
}
