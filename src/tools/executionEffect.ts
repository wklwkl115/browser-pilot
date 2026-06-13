import type { BrowserBridgeServer } from "../driver/BrowserBridgeServer.js";
import type { BrowserBridgeExecutionResult } from "../driver/types.js";
import { canonicalBridgeCommand, getNativeCommandProtocolSchema, type BridgeCommand } from "../protocol/nativeProtocol.js";
import { classifyStaleness } from "../temporal-core/classify.js";
import { isRecord } from "../utils/params.js";
import { readHookRecorderSeq, readNetworkRecorderSeq, readPageFingerprint, type PageFingerprint, type RecorderSeq } from "./pageSignals.js";
import type { ExecuteEffect } from "./executionJournal.js";
import type { ExecuteStdlibTargetRef } from "./executeStdlib.js";

type ExecutionSignalSnapshot = {
	fingerprint?: PageFingerprint;
	network: RecorderSeq;
	hook: RecorderSeq;
	selectionVersion?: number;
	defaultTabId?: number;
};

export type ExecutionEffectRun<T extends BrowserBridgeExecutionResult = BrowserBridgeExecutionResult> = {
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
	return process.env.PI_BROWSER_EXECUTE_EFFECT !== "0";
}

async function readExecutionSignals(server: BrowserBridgeServer, options: EffectOptions): Promise<ExecutionSignalSnapshot> {
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

function buildEffect(before: ExecutionSignalSnapshot, after: ExecutionSignalSnapshot, quiet: ExecutionSignalSnapshot | undefined, options: Pick<EffectOptions, "targetRefs"> = {}): ExecuteEffect {
	const beforeFp = before.fingerprint;
	const afterFp = after.fingerprint;
	const quietFp = quiet?.fingerprint;
	const url = quietFp?.url ?? afterFp?.url ?? beforeFp?.url;
	const hasFingerprintPair = beforeFp !== undefined && afterFp !== undefined;
	const mutations = hasFingerprintPair ? delta(afterFp.changeSeq, beforeFp.changeSeq) : undefined;
	const quietDelta = quietFp && afterFp ? delta(quietFp.changeSeq, afterFp.changeSeq) : undefined;
	const dirty = quietFp?.dirty ?? afterFp?.dirty;
	const dirtyOverflow = dirty?.overflow === true;
	const requestsFired = before.network.active && after.network.active ? delta(after.network.lastSeq, before.network.lastSeq) : undefined;
	const hookEventsFired = before.hook.active && after.hook.active ? delta(after.hook.lastSeq, before.hook.lastSeq) : undefined;
	const targetDelta = {
		...(before.selectionVersion !== after.selectionVersion ? { selectionVersionBefore: before.selectionVersion, selectionVersionAfter: after.selectionVersion } : {}),
		...(before.defaultTabId !== after.defaultTabId ? { tabIdBefore: before.defaultTabId, tabIdAfter: after.defaultTabId } : {}),
	};
	const changeSeq = quietFp?.changeSeq ?? afterFp?.changeSeq;
	const anchor = {
		...(changeSeq !== undefined ? { changeSeq } : {}),
		...(after.network.lastSeq !== undefined ? { networkSeq: after.network.lastSeq } : {}),
		...(after.hook.lastSeq !== undefined ? { hookSeq: after.hook.lastSeq } : {}),
	};
	const preDispatchTemporal = targetDirtyBeforeDispatch(options.targetRefs, beforeFp?.dirty);
	return {
		...(url ? { url } : {}),
		...(!hasFingerprintPair || dirtyOverflow ? { signals: "partial" as const } : {}),
		...(dirtyOverflow ? { coverage: "overflow" as const } : {}),
		...(mutations !== undefined ? { mutations } : {}),
		...(mutations !== undefined ? { settled: mutations === 0 || quietDelta === 0 } : {}),
		navigated: !!(beforeFp?.url && afterFp?.url && beforeFp.url !== afterFp.url),
		...(hasFingerprintPair ? { visibleDelta: delta(afterFp.visibleCount, beforeFp.visibleCount) ?? 0 } : {}),
		...(hasFingerprintPair ? { interactiveDelta: delta(afterFp.interactiveCount, beforeFp.interactiveCount) ?? 0 } : {}),
		...(dirty && (dirty.roots.length || dirty.overflow) ? { dirty } : {}),
		...(requestsFired !== undefined ? { requestsFired } : {}),
		...(hookEventsFired !== undefined ? { hookEventsFired } : {}),
		...(Object.keys(targetDelta).length ? { targetDelta } : {}),
		...(Object.keys(anchor).length ? { anchor } : {}),
		...targetFeedbackForDirtyWindow(options.targetRefs, dirty),
		...(preDispatchTemporal ? { temporal: preDispatchTemporal } : {}),
	};
}

export async function withExecutionEffect<T extends BrowserBridgeExecutionResult>(
	server: BrowserBridgeServer,
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
