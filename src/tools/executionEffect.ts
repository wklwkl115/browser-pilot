import type { BrowserBridgeServer } from "../driver/BrowserBridgeServer.js";
import type { BrowserBridgeExecutionResult } from "../driver/types.js";
import { canonicalBridgeCommand, getNativeCommandProtocolSchema, type BridgeCommand } from "../protocol/nativeProtocol.js";
import { isRecord } from "../utils/params.js";
import { readHookRecorderSeq, readNetworkRecorderSeq, readPageFingerprint, type PageFingerprint, type RecorderSeq } from "./pageSignals.js";
import type { ExecuteEffect } from "./executionJournal.js";

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
};

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function effectEnabled(): boolean {
	return process.env.PI_BROWSER_EXECUTE_EFFECT !== "0";
}

async function readExecutionSignals(server: BrowserBridgeServer, options: EffectOptions): Promise<ExecutionSignalSnapshot> {
	const snapshot = server.snapshot({ browserSessionId: options.browserSessionId });
	const signalOptions = { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs };
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

function buildEffect(before: ExecutionSignalSnapshot, after: ExecutionSignalSnapshot, quiet: ExecutionSignalSnapshot | undefined): ExecuteEffect {
	const beforeFp = before.fingerprint;
	const afterFp = after.fingerprint;
	const quietFp = quiet?.fingerprint;
	const mutations = delta(afterFp?.changeSeq, beforeFp?.changeSeq) ?? 0;
	const quietDelta = delta(quietFp?.changeSeq, afterFp?.changeSeq) ?? 0;
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
	return {
		mutations,
		settled: mutations === 0 || quietDelta === 0,
		navigated: !!(beforeFp?.url && afterFp?.url && beforeFp.url !== afterFp.url),
		visibleDelta: delta(afterFp?.visibleCount, beforeFp?.visibleCount) ?? 0,
		interactiveDelta: delta(afterFp?.interactiveCount, beforeFp?.interactiveCount) ?? 0,
		...(requestsFired !== undefined ? { requestsFired } : {}),
		...(hookEventsFired !== undefined ? { hookEventsFired } : {}),
		...(Object.keys(targetDelta).length ? { targetDelta } : {}),
		...(Object.keys(anchor).length ? { anchor } : {}),
	};
}

export async function withExecutionEffect<T extends BrowserBridgeExecutionResult>(
	server: BrowserBridgeServer,
	options: EffectOptions,
	dispatch: () => Promise<T>,
): Promise<ExecutionEffectRun<T>> {
	if (!effectEnabled() || !options.tabId) return { result: await dispatch() };
	const before = await readExecutionSignals(server, options);
	const result = await dispatch();
	const after = await readExecutionSignals(server, options);
	let quiet: ExecutionSignalSnapshot | undefined;
	const mutationDelta = delta(after.fingerprint?.changeSeq, before.fingerprint?.changeSeq) ?? 0;
	if (mutationDelta > 0) {
		await delay(options.quietMs ?? 150);
		quiet = await readExecutionSignals(server, options);
	}
	return { result, effect: buildEffect(before, after, quiet), before, after: quiet ?? after };
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
