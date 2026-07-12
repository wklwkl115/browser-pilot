import type { BrowserCommandRuntimePort, CommandActiveOperationInfo } from "../ports/BrowserCommandRuntimePort.js";
import type { BrowserBridgeExecutionResult } from "../ports/BrowserRuntimeTypes.js";
import {
	BROWSER_OPERATION_SCHEMA,
	classifyBrowserOperationStatus,
	type BrowserOperationEvent,
	type BrowserOperationOutcome,
	type BrowserOperationSignals,
	type BrowserOperationStatus,
	type BrowserOperationTarget,
} from "../kernels/session/browserOperation.js";
import { errorToPlain } from "../utils/errors.js";
import { isRecord } from "../utils/records.js";
import type { CommandOnUpdate, CommandResultContext } from "./commandRuntime.js";
import { resolveBrowserOperationCompletion, type BrowserOperationResolverInput } from "./operationResolvers.js";
import { classifyBrowserOperationLiveness, nextBrowserOperationLivenessBoundary } from "../kernels/session/browserOperationState.js";
import { redactSensitiveValue } from "../utils/redaction.js";

type BrowserOperationOptions = Omit<BrowserOperationResolverInput, "result" | "events"> & {
	server: BrowserCommandRuntimePort;
	browserSessionId?: string;
	tabId?: number;
	targetRef?: string;
	timeoutMs: number;
	ctx?: CommandResultContext;
	onUpdate?: CommandOnUpdate;
};

function resolveTarget(options: BrowserOperationOptions): BrowserOperationTarget {
	const snapshot = options.server.snapshot({ browserSessionId: options.browserSessionId });
	const tab = snapshot.tabs.find((item) => {
		if (options.tabId !== undefined && item.tabId === options.tabId) return true;
		return options.targetRef !== undefined && (item.targetRef === options.targetRef || item.tabHandle === options.targetRef);
	});
	return {
		browserSessionId: snapshot.browserSessionId ?? options.browserSessionId,
		targetRef: typeof tab?.targetRef === "string" ? tab.targetRef : typeof tab?.tabHandle === "string" ? tab.tabHandle : options.targetRef,
		tabId: typeof tab?.tabId === "number" ? tab.tabId : options.tabId,
		generation: typeof tab?.generation === "number" ? tab.generation : undefined,
		url: typeof tab?.url === "string" ? tab.url : undefined,
		scriptable: typeof tab?.scriptable === "boolean" ? tab.scriptable : undefined,
		cdpAvailable: typeof tab?.cdpAvailable === "boolean" ? tab.cdpAvailable : undefined,
	};
}

function statusForError(error: unknown): BrowserOperationStatus {
	const plain = errorToPlain(error);
	const code = String(plain.code || "");
	if (/AMBIGUOUS/.test(code)) return "ambiguous";
	if (/TAB_NOT_FOUND|NO_TAB|TARGET|FRAME_DETACHED|DISCONNECTED/.test(code)) return "target_lost";
	if (/TIMEOUT|DEADLINE/.test(code)) return "deadline";
	return "failed";
}

function summarizeSignals(events: BrowserOperationEvent[]): BrowserOperationSignals {
	const count = (types: string[]) => events.filter((event) => types.includes(event.type)).length;
	const mutations = events.filter((event) => event.type === "mutation").reduce((sum, event) => Math.max(sum, Number(event.data?.mutationCount || 0)), 0);
	const navigation = [...events].reverse().find((event) => event.type.startsWith("navigation"));
	const networkStarted = count(["network_started"]);
	const networkCompleted = count(["network_completed"]);
	const downloadsStarted = count(["download_started"]);
	const downloadsCompleted = count(["download_completed"]);
	return {
		...(navigation ? { navigation: String(navigation.data?.url ?? navigation.data?.phase ?? navigation.type) } : {}),
		...(mutations ? { mutationCount: mutations } : {}),
		...(networkStarted ? { networkStarted } : {}),
		...(networkCompleted ? { networkCompleted } : {}),
		...(networkStarted > networkCompleted ? { networkPending: networkStarted - networkCompleted } : {}),
		...(count(["dialog"]) ? { dialogs: count(["dialog"]) } : {}),
		...(count(["new_tab"]) ? { newTabs: count(["new_tab"]) } : {}),
		...(downloadsStarted ? { downloadsStarted } : {}),
		...(downloadsCompleted ? { downloadsCompleted } : {}),
		...(events.some((event) => ["target_lost", "target_activated"].includes(event.type)) ? { targetChanged: true } : {}),
	};
}

function dispatchEvidence(result: unknown): { acknowledged: boolean; target?: Record<string, unknown> } {
	if (!isRecord(result)) return { acknowledged: false };
	return { acknowledged: result.acknowledged === true, target: isRecord(result.target) ? result.target : undefined };
}

function completedTarget(initial: BrowserOperationTarget, result: unknown): BrowserOperationTarget {
	if (!isRecord(result)) return initial;
	const candidate = isRecord(result.createdTarget) ? result.createdTarget : isRecord(result.target) ? result.target : undefined;
	if (!candidate) return initial;
	return {
		...initial,
		...(typeof candidate.browserSessionId === "string" ? { browserSessionId: candidate.browserSessionId } : {}),
		...(typeof candidate.targetRef === "string" ? { targetRef: candidate.targetRef } : typeof candidate.tabHandle === "string" ? { targetRef: candidate.tabHandle } : {}),
		...(typeof candidate.tabId === "number" ? { tabId: candidate.tabId } : {}),
		...(typeof candidate.generation === "number" ? { generation: candidate.generation } : {}),
		...(typeof candidate.url === "string" ? { url: candidate.url } : {}),
	};
}

async function armExtension(options: BrowserOperationOptions, operation: CommandActiveOperationInfo, target: BrowserOperationTarget): Promise<BrowserBridgeExecutionResult> {
	return await options.server.sendCommand({
		cmd: "operation.begin",
		operationId: operation.operationId,
		...(target.tabId !== undefined ? { tabId: target.tabId } : {}),
		...(target.targetRef ? { targetRef: target.targetRef } : {}),
		...(target.generation !== undefined ? { generation: target.generation } : {}),
	}, {
		browserSessionId: target.browserSessionId,
		...(target.targetRef ? { targetRef: target.targetRef } : target.tabId !== undefined ? { tabId: target.tabId } : {}),
		timeoutMs: Math.min(5_000, options.timeoutMs),
		accessMode: "read",
		internal: true,
	});
}

async function finishExtension(options: BrowserOperationOptions, operationId: string, target: BrowserOperationTarget): Promise<void> {
	await options.server.sendCommand({
		cmd: "operation.finish",
		operationId,
		...(target.tabId !== undefined ? { tabId: target.tabId } : {}),
		...(target.targetRef ? { targetRef: target.targetRef } : {}),
	}, {
		browserSessionId: target.browserSessionId,
		...(target.targetRef ? { targetRef: target.targetRef } : target.tabId !== undefined ? { tabId: target.tabId } : {}),
		timeoutMs: Math.min(5_000, options.timeoutMs),
		accessMode: "read",
		internal: true,
	}).catch(() => undefined);
}

type OperationSettlement = { status: BrowserOperationStatus; events: BrowserOperationEvent[]; completion?: ReturnType<typeof resolveBrowserOperationCompletion> };

function terminalEvidence(options: BrowserOperationOptions, result: unknown, events: BrowserOperationEvent[]): OperationSettlement | undefined {
	if (events.filter((event) => event.type === "new_tab").length > 1) return { status: "ambiguous", events };
	if (events.filter((event) => event.type === "download_started").length > 1) return { status: "ambiguous", events };
	const completion = resolveBrowserOperationCompletion({ ...options, result, events });
	return completion ? { status: "completed", events, completion } : undefined;
}

function operationTargetLost(events: BrowserOperationEvent[], operation: CommandActiveOperationInfo | undefined): boolean {
	return events.some((event) => event.type === "target_lost" || (event.generation !== undefined && operation?.generation !== undefined && event.generation !== operation.generation));
}

function livenessStatus(events: BrowserOperationEvent[], operation: CommandActiveOperationInfo | undefined, dispatchFinishedAt: number, deadlineAt: number): OperationSettlement["status"] | undefined {
	const signals = summarizeSignals(events);
	const hasActivity = events.some((event) => event.progress !== false);
	const downloadPending = Number(signals.downloadsStarted || 0) > Number(signals.downloadsCompleted || 0);
	const pending = Number(signals.networkPending || 0) > 0 || downloadPending;
	return classifyBrowserOperationLiveness({
		now: Date.now(),
		deadlineAt,
		dispatchFinishedAt,
		lastProgressAt: operation?.lastProgressAt ?? dispatchFinishedAt,
		hasActivity,
		pending,
		downloadPending,
	});
}

function livenessBoundary(events: BrowserOperationEvent[], operation: CommandActiveOperationInfo | undefined, dispatchFinishedAt: number, deadlineAt: number, now = Date.now()): number {
	const signals = summarizeSignals(events);
	const hasActivity = events.some((event) => event.progress !== false);
	const downloadPending = Number(signals.downloadsStarted || 0) > Number(signals.downloadsCompleted || 0);
	const pending = Number(signals.networkPending || 0) > 0 || downloadPending;
	return nextBrowserOperationLivenessBoundary({
		now,
		deadlineAt,
		dispatchFinishedAt,
		lastProgressAt: operation?.lastProgressAt ?? dispatchFinishedAt,
		hasActivity,
		pending,
		downloadPending,
	});
}

function waitForBoundary(timeoutMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, timeoutMs)));
}

async function settleStatus(options: BrowserOperationOptions, operationId: string, result: unknown, dispatchFinishedAt: number, deadlineAt: number): Promise<OperationSettlement> {
	let operation = options.server.getOperation?.(operationId);
	let events = operation?.events ?? [];
	while (true) {
		operation = options.server.getOperation?.(operationId) ?? operation;
		events = operation?.events ?? events;
		const terminal = terminalEvidence(options, result, events);
		if (terminal) return terminal;
		if (operationTargetLost(events, operation)) return { status: "target_lost", events };
		const liveness = livenessStatus(events, operation, dispatchFinishedAt, deadlineAt);
		if (liveness) return { status: liveness, events };
		const now = Date.now();
		const boundary = livenessBoundary(events, operation, dispatchFinishedAt, deadlineAt, now);
		const timeoutMs = Math.max(0, boundary - now);
		if (options.server.waitForOperationChange && operation) {
			await options.server.waitForOperationChange(operationId, operation.revision, timeoutMs);
		} else {
			// Non-production test ports may omit the waiter. Waiting once for the
			// exact pure boundary preserves event-driven production semantics and
			// never polls the registry.
			await waitForBoundary(timeoutMs);
		}
	}
}

export async function withBrowserOperation<T>(options: BrowserOperationOptions, dispatch: () => Promise<T>): Promise<BrowserOperationOutcome> {
	const target = resolveTarget(options);
	const operation = options.server.beginOperation({
		commandName: options.commandName,
		command: options.command ?? options.action ?? options.mode ?? options.commandName,
		browserSessionId: target.browserSessionId,
		tabId: target.tabId,
		generation: target.generation,
		ownerId: options.ctx?.operationOwnerId ?? "local-cli",
		phase: "arming",
		progress: 5,
		queueDepth: options.server.queueDepth(target.browserSessionId, target.tabId),
		leaseOwnerHash: options.server.leaseOwnerHash(target.browserSessionId, target.tabId),
	});
	const lateEffects = options.server.surfaceLateEffects?.({ ownerId: options.ctx?.operationOwnerId, browserSessionId: target.browserSessionId, excludeOperationId: operation.operationId }) ?? [];
	const startedAt = Date.now();
	const deadlineAt = startedAt + options.timeoutMs;
	let acknowledged = false;
	try {
		const armed = await armExtension(options, operation, target);
		if (!armed.acknowledged || !isRecord(armed.data) || armed.data.armed !== true) throw new Error("operation observers were not armed before dispatch");
		options.server.updateOperation(operation.operationId, { phase: "dispatching", progress: 20 });
		const result = await dispatch();
		const dispatchFinishedAt = Date.now();
		acknowledged = dispatchEvidence(result).acknowledged;
		options.server.updateOperation(operation.operationId, { phase: "resolving", progress: 75, details: { acknowledged } });
		const settled = await settleStatus(options, operation.operationId, result, dispatchFinishedAt, deadlineAt);
		const signals = summarizeSignals(settled.events);
		const outcome: BrowserOperationOutcome = {
			schema: BROWSER_OPERATION_SCHEMA,
			operationId: operation.operationId,
			commandName: options.commandName,
			status: settled.status,
			...classifyBrowserOperationStatus(settled.status),
			target: completedTarget(target, result),
			dispatch: { acknowledged, started: true, finished: true, startedAt, finishedAt: dispatchFinishedAt },
			signals,
			...(settled.completion ? { completion: settled.completion } : {}),
			...(signals.mutationCount ? { pageEffect: { changed: settled.events.filter((event) => event.type === "mutation").slice(-20).map((event) => event.data) } } : {}),
			...(lateEffects.length ? { lateEffects } : {}),
		};
		const publicOutcome = redactSensitiveValue(outcome) as BrowserOperationOutcome;
		await finishExtension(options, operation.operationId, target);
		options.server.finishOperation(operation.operationId, publicOutcome);
		return publicOutcome;
	} catch (error) {
		const finishedAt = Date.now();
		const status = statusForError(error);
		const events = options.server.getOperation?.(operation.operationId)?.events ?? [];
		const outcome: BrowserOperationOutcome = {
			schema: BROWSER_OPERATION_SCHEMA,
			operationId: operation.operationId,
			commandName: options.commandName,
			status,
			...classifyBrowserOperationStatus(status),
			target,
			dispatch: { acknowledged, started: true, finished: false, startedAt, finishedAt },
			signals: summarizeSignals(events),
			diagnostics: [errorToPlain(error)],
			...(lateEffects.length ? { lateEffects } : {}),
		};
		const publicOutcome = redactSensitiveValue(outcome) as BrowserOperationOutcome;
		await finishExtension(options, operation.operationId, target);
		options.server.finishOperation(operation.operationId, publicOutcome);
		return publicOutcome;
	}
}
