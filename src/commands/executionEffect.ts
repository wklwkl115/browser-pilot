import type { BrowserBridgeExecutionResult } from "../ports/BrowserRuntimeTypes.js";
import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";
import { canonicalBridgeCommand, getNativeCommandProtocolSchema, type BridgeCommand } from "../types/nativeProtocol.js";
import { classifyStaleness } from "../kernels/temporal/classify.js";
import { isRecord } from "../utils/params.js";
import { readHookRecorderSeq, readNetworkRecorderSeq, readPageFingerprint, type PageFingerprint, type RecorderSeq } from "./pageSignals.js";
import type { ExecuteEffect } from "./executionJournal.js";
import type { ExecuteStdlibTargetRef } from "../browser-command-runtime/executeStdlib.js";

export type ExecutionSignalSnapshot = {
	fingerprint?: PageFingerprint;
	network: RecorderSeq;
	hook: RecorderSeq;
	selectionVersion?: number;
	defaultTabId?: number;
};

// T is unconstrained: the wrapper only times the dispatch and reads page signals before/after — it
// never touches the result's shape — so it can wrap a JS execution result or a multi-frame program run.
export type ExecutionEffectRun<T = BrowserBridgeExecutionResult> = {
	result: T;
	effect?: ExecuteEffect;
	before?: ExecutionSignalSnapshot;
	after?: ExecutionSignalSnapshot;
};

type EffectOptions = {
	browserSessionId?: string;
	tabId?: number;
	timeoutMs: number;
	quietMs?: number;
	drainDirty?: boolean;
	targetRefs?: ExecuteStdlibTargetRef[];
};

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function effectEnabled(): boolean {
	return process.env.BROWSER_PILOT_EXECUTE_EFFECT !== "0";
}

async function readExecutionSignals(server: BrowserCommandRuntimePort, options: EffectOptions): Promise<ExecutionSignalSnapshot> {
	const snapshot = server.snapshot({ browserSessionId: options.browserSessionId });
	const signalOptions = { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs, drainDirty: options.drainDirty };
	const [fingerprint, network, hook] = await Promise.all([
		readPageFingerprint(server, signalOptions),
		readNetworkRecorderSeq(server, signalOptions),
		readHookRecorderSeq(server, signalOptions),
	]);
	return { fingerprint, network, hook, selectionVersion: snapshot.selectionVersion, defaultTabId: snapshot.defaultTabId };
}

function delta(after: number | undefined, before: number | undefined): number | undefined {
	if (after === undefined || before === undefined) return undefined;
	return Math.max(0, after - before);
}

function selectorMightCoverDirtyRoot(selector: string, dirtyRoot: string): boolean {
	const target = selector.trim();
	const root = dirtyRoot.trim();
	if (!target || !root) return false;
	return target === root
		|| target.startsWith(`${root} `)
		|| target.startsWith(`${root}>`)
		|| root.startsWith(`${target} `)
		|| root.startsWith(`${target}>`);
}

function targetFeedbackForDirtyWindow(targetRefs: ExecuteStdlibTargetRef[] | undefined, dirty: PageFingerprint["dirty"] | undefined): Pick<ExecuteEffect, "targetObservedAt" | "targetObservationId" | "targetRef" | "targetRegionDirty" | "targetDirtyRoots"> {
	const target = targetRefs?.[0];
	if (!target) return {};
	const roots = dirty?.roots ?? [];
	const matchedRoots: string[] = [];
	for (const root of roots) {
		if (dirty?.overflow !== true && !target.cssRoots.some((selector) => selectorMightCoverDirtyRoot(selector, root))) continue;
		matchedRoots.push(root);
		if (matchedRoots.length >= 8) break;
	}
	const regionDirty = dirty?.overflow === true || matchedRoots.length > 0;
	return {
		...(target.observedAt !== undefined ? { targetObservedAt: target.observedAt } : {}),
		...(target.observationId ? { targetObservationId: target.observationId } : {}),
		targetRef: target.refId,
		...(regionDirty ? { targetRegionDirty: true } : {}),
		...(matchedRoots.length ? { targetDirtyRoots: matchedRoots } : {}),
	};
}

function targetDirtyBeforeDispatch(targetRefs: ExecuteStdlibTargetRef[] | undefined, dirty: PageFingerprint["dirty"] | undefined): ExecuteEffect["temporal"] | undefined {
	const target = targetRefs?.[0];
	if (!target) return undefined;
	const feedback = targetFeedbackForDirtyWindow(targetRefs, dirty);
	if (feedback.targetRegionDirty !== true) return undefined;
	const stableLocator = target.locators?.some((locator) => locator.by === "backendNodeId" || locator.by === "axNodeId") === true;
	const cssOnlyLocator = !stableLocator && target.locators?.some((locator) => locator.by === "css") === true;
	const decision = classifyStaleness({
		anchorPresent: true,
		targetRegionDirty: true,
		stableLocator,
		cssOnlyLocator,
	});
	return {
		verdict: {
			status: decision.verdict.status,
			confidence: decision.verdict.confidence,
			reasons: decision.verdict.reasons,
		},
		frontier: { next: decision.frontier.next, ...(decision.frontier.next === "reuse_target" ? { handle: target.refId } : {}) },
	};
}

function fingerprintPairEffect(beforeFp: PageFingerprint | undefined, afterFp: PageFingerprint | undefined, quietFp: PageFingerprint | undefined): Partial<ExecuteEffect> & Pick<ExecuteEffect, "navigated"> {
	if (!beforeFp || !afterFp) return { signals: "partial", navigated: false };
	const mutations = delta(afterFp.changeSeq, beforeFp.changeSeq) ?? 0;
	const quietDelta = quietFp ? delta(quietFp.changeSeq, afterFp.changeSeq) : undefined;
	return {
		mutations,
		settled: mutations === 0 || quietDelta === 0,
		navigated: Boolean(beforeFp.url && afterFp.url && beforeFp.url !== afterFp.url),
		visibleDelta: delta(afterFp.visibleCount, beforeFp.visibleCount) ?? 0,
		interactiveDelta: delta(afterFp.interactiveCount, beforeFp.interactiveCount) ?? 0,
	};
}

function fingerprintContextEffect(beforeFp: PageFingerprint | undefined, afterFp: PageFingerprint | undefined, quietFp: PageFingerprint | undefined, dirty: PageFingerprint["dirty"] | undefined): Partial<ExecuteEffect> {
	const url = quietFp?.url ?? afterFp?.url ?? beforeFp?.url;
	return {
		...(url ? { url } : {}),
		...(dirty?.overflow === true ? { signals: "partial" as const, coverage: "overflow" as const } : {}),
		...(dirty && (dirty.roots.length > 0 || dirty.overflow) ? { dirty } : {}),
	};
}

function signalDeltaEffect(before: ExecutionSignalSnapshot, after: ExecutionSignalSnapshot, quietFp: PageFingerprint | undefined): Partial<ExecuteEffect> {
	const effect: Partial<ExecuteEffect> = {};
	const requestsFired = before.network.active && after.network.active ? delta(after.network.lastSeq, before.network.lastSeq) : undefined;
	const hookEventsFired = before.hook.active && after.hook.active ? delta(after.hook.lastSeq, before.hook.lastSeq) : undefined;
	if (requestsFired !== undefined) effect.requestsFired = requestsFired;
	if (hookEventsFired !== undefined) effect.hookEventsFired = hookEventsFired;
	const targetDelta: NonNullable<ExecuteEffect["targetDelta"]> = {};
	if (before.selectionVersion !== after.selectionVersion) Object.assign(targetDelta, { selectionVersionBefore: before.selectionVersion, selectionVersionAfter: after.selectionVersion });
	if (before.defaultTabId !== after.defaultTabId) Object.assign(targetDelta, { tabIdBefore: before.defaultTabId, tabIdAfter: after.defaultTabId });
	if (Object.keys(targetDelta).length) effect.targetDelta = targetDelta;
	const anchor: NonNullable<ExecuteEffect["anchor"]> = {};
	const changeSeq = quietFp?.changeSeq ?? after.fingerprint?.changeSeq;
	if (changeSeq !== undefined) anchor.changeSeq = changeSeq;
	if (after.network.lastSeq !== undefined) anchor.networkSeq = after.network.lastSeq;
	if (after.hook.lastSeq !== undefined) anchor.hookSeq = after.hook.lastSeq;
	if (Object.keys(anchor).length) effect.anchor = anchor;
	return effect;
}

export function buildEffect(before: ExecutionSignalSnapshot, after: ExecutionSignalSnapshot, quiet: ExecutionSignalSnapshot | undefined, options: Pick<EffectOptions, "targetRefs"> = {}): ExecuteEffect {
	const beforeFp = before.fingerprint;
	const afterFp = after.fingerprint;
	const quietFp = quiet?.fingerprint;
	const dirty = quietFp?.dirty ?? afterFp?.dirty;
	const temporal = targetDirtyBeforeDispatch(options.targetRefs, beforeFp?.dirty);
	return {
		...fingerprintPairEffect(beforeFp, afterFp, quietFp),
		...fingerprintContextEffect(beforeFp, afterFp, quietFp, dirty),
		...signalDeltaEffect(before, after, quietFp),
		...targetFeedbackForDirtyWindow(options.targetRefs, dirty),
		...(temporal ? { temporal } : {}),
	};
}

export async function withExecutionEffect<T>(
	server: BrowserCommandRuntimePort,
	options: EffectOptions,
	dispatch: () => Promise<T>,
): Promise<ExecutionEffectRun<T>> {
	if (!effectEnabled() || !options.tabId) return { result: await dispatch() };
	const before = await readExecutionSignals(server, { ...options, drainDirty: true });
	const result = await dispatch();
	const after = await readExecutionSignals(server, options);
	let quiet: ExecutionSignalSnapshot | undefined;
	const mutationDelta = delta(after.fingerprint?.changeSeq, before.fingerprint?.changeSeq);
	if (mutationDelta !== undefined && mutationDelta > 0) {
		await delay(options.quietMs ?? 150);
		quiet = await readExecutionSignals(server, options);
	}
	return { result, effect: buildEffect(before, after, quiet, options), before, after: quiet ?? after };
}

export function commandCollectsExecutionEffect(command: BridgeCommand): boolean {
	if (!isRecord(command) || typeof command.cmd !== "string") return false;
	const schema = getNativeCommandProtocolSchema();
	const canonical = canonicalBridgeCommand(command.cmd, schema);
	const spec = schema.commands[command.cmd] || schema.commands[canonical];
	if (!spec?.tabScoped) return false;
	const method = String(command.method || command.action || spec.defaultMethod || "").toLowerCase();
	const methodSpec = method ? spec.methodSpecs?.[method] : undefined;
	return (methodSpec?.accessMode ?? spec.accessMode) === "write";
}
