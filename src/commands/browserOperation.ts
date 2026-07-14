import type { BrowserCommandRuntimePort, CommandActiveOperationInfo } from "../ports/BrowserCommandRuntimePort.js";
import type { BrowserBridgeExecutionResult } from "../ports/BrowserRuntimeTypes.js";
import {
	BROWSER_OPERATION_SCHEMA,
	classifyBrowserOperationStatus,
	type BrowserOperationEvent,
	type BrowserOperationLateEffect,
	type BrowserOperationOutcome,
	type BrowserOperationSignals,
	type BrowserOperationStatus,
	type BrowserOperationTarget,
} from "../kernels/session/browserOperation.js";
import type { SessionMutationReplayGuard } from "../kernels/session/operationRegistry.js";
import { BrowserBridgeError, errorToPlain, errorWasAcknowledged } from "../utils/errors.js";
import { isRecord } from "../utils/records.js";
import type { CommandOnUpdate, CommandResultContext } from "./commandRuntime.js";
import { resolveBrowserOperationCompletion, resolveBrowserOperationDispatchTerminal, summarizeBrowserOperationDispatch, type BrowserOperationResolverInput } from "./operationResolvers.js";
import { classifyBrowserOperationLiveness, nextBrowserOperationLivenessBoundary } from "../kernels/session/browserOperationState.js";
import { redactSensitiveValue } from "../utils/redaction.js";

type BrowserOperationOptions = Omit<BrowserOperationResolverInput, "result" | "events"> & {
	server: BrowserCommandRuntimePort;
	intentId?: string;
	intentPayload?: unknown;
	browserSessionId?: string;
	tabId?: number;
	targetRef?: string;
	timeoutMs: number;
	ctx?: CommandResultContext;
	onUpdate?: CommandOnUpdate;
	signal?: AbortSignal;
};

export type BrowserOperationDispatchContext = {
	signal: AbortSignal;
	operationId: string;
	deadlineAt: number;
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
	if (error instanceof Error && error.name === "AbortError") return "deadline";
	const plain = errorToPlain(error);
	const code = String(plain.code || "");
	if (/AMBIGUOUS/.test(code)) return "ambiguous";
	if (/TAB_NOT_FOUND|NO_TAB|TARGET|FRAME_DETACHED|DISCONNECTED/.test(code)) return "target_lost";
	if (/TIMEOUT|DEADLINE/.test(code)) return "deadline";
	return "failed";
}

function dispatchStartedForError(error: unknown, fallback: boolean): boolean {
	const plain = errorToPlain(error);
	const details = isRecord(plain.details) ? plain.details : {};
	return typeof details.dispatchStarted === "boolean" ? details.dispatchStarted : fallback;
}

function errorHasDispatchEvidence(error: unknown): boolean {
	const plain = errorToPlain(error);
	const details = isRecord(plain.details) ? plain.details : {};
	return typeof details.dispatchStarted === "boolean" || typeof details.acked === "boolean" || errorWasAcknowledged(error);
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

function browserDispatchStarted(options: BrowserOperationOptions, result: unknown): boolean {
	if (options.commandName !== "browser_execute" || options.mode !== "program" || !isRecord(result) || !Array.isArray(result.frames)) return true;
	return result.frames.some((frame) => isRecord(frame) && String(frame.kind || "") !== "wait");
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
		signal: options.signal,
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

type OperationSettlement = { status: BrowserOperationStatus; events: BrowserOperationEvent[]; completion?: ReturnType<typeof resolveBrowserOperationCompletion>; diagnostics?: Array<Record<string, unknown>> };

function terminalEvidence(options: BrowserOperationOptions, result: unknown, events: BrowserOperationEvent[]): OperationSettlement | undefined {
	if (events.filter((event) => event.type === "new_tab").length > 1) return { status: "ambiguous", events };
	if (events.filter((event) => event.type === "download_started").length > 1) return { status: "ambiguous", events };
	const dispatchTerminal = resolveBrowserOperationDispatchTerminal({ ...options, result, events });
	if (dispatchTerminal) return { ...dispatchTerminal, events };
	const completion = resolveBrowserOperationCompletion({ ...options, result, events });
	return completion ? { status: "completed", events, completion } : undefined;
}

function operationTargetLost(events: BrowserOperationEvent[], operation: CommandActiveOperationInfo | undefined): boolean {
	return events.some((event) => event.type === "target_lost" || (event.generation !== undefined && operation?.generation !== undefined && event.generation !== operation.generation));
}

function operationObserverLoss(events: BrowserOperationEvent[]): OperationSettlement | undefined {
	const event = [...events].reverse().find((item) => item.type === "observer_lost");
	return event ? {
		status: "ambiguous",
		events,
		diagnostics: [{
			code: "OPERATION_OBSERVER_LOST",
			message: "The extension worker restarted after this operation began, so completion evidence may have been lost. Verify page state and do not replay the mutation blindly.",
			reason: event.data?.reason,
		}],
	} : undefined;
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

function waitForBoundary(timeoutMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Operation wait aborted", "AbortError"));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(finish, Math.max(0, timeoutMs));
		const onAbort = () => {
			cleanup();
			reject(signal?.reason ?? new DOMException("Operation wait aborted", "AbortError"));
		};
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		function finish() {
			cleanup();
			resolve();
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function settleStatus(options: BrowserOperationOptions, operationId: string, result: unknown, dispatchFinishedAt: number, deadlineAt: number): Promise<OperationSettlement> {
	let operation = options.server.getOperation?.(operationId);
	let events = operation?.events ?? [];
	while (true) {
		operation = options.server.getOperation?.(operationId) ?? operation;
		events = operation?.events ?? events;
		const terminal = terminalEvidence(options, result, events);
		if (terminal?.status === "completed") return terminal;
		const observerLoss = operationObserverLoss(events);
		if (observerLoss) return observerLoss;
		if (terminal) return terminal;
		if (operationTargetLost(events, operation)) return { status: "target_lost", events };
		const liveness = livenessStatus(events, operation, dispatchFinishedAt, deadlineAt);
		if (liveness) return { status: liveness, events };
		const now = Date.now();
		const boundary = livenessBoundary(events, operation, dispatchFinishedAt, deadlineAt, now);
		const timeoutMs = Math.max(0, boundary - now);
		if (options.server.waitForOperationChange && operation) {
			await options.server.waitForOperationChange(operationId, operation.revision, timeoutMs, options.signal);
		} else {
			// Non-production test ports may omit the waiter. Waiting once for the
			// exact pure boundary preserves event-driven production semantics and
			// never polls the registry.
			await waitForBoundary(timeoutMs, options.signal);
		}
	}
}

function mutationReplayGuard(options: BrowserOperationOptions, target: BrowserOperationTarget): SessionMutationReplayGuard | undefined {
	return options.server.mutationReplayGuard?.({
		ownerId: options.ctx?.operationOwnerId,
		browserSessionId: target.browserSessionId,
		tabId: target.tabId,
		targetRef: target.targetRef,
		generation: target.generation,
		commandName: options.commandName,
		intentId: options.intentId,
		intentPayload: options.intentPayload,
	});
}

function reusedIntentOutcome(options: BrowserOperationOptions, guard: SessionMutationReplayGuard | undefined): BrowserOperationOutcome | undefined {
	if (guard?.kind === "intent_replay" && guard.commandName === options.commandName && guard.outcome?.status === "completed") {
		return redactSensitiveValue({
			...guard.outcome,
			diagnostics: [...(guard.outcome.diagnostics ?? []), {
				code: "INTENT_RESULT_REUSED",
				message: "The same intent already completed; Browser Pilot returned its prior outcome without dispatching the mutation again.",
				priorOperationId: guard.operationId,
			}],
		}) as BrowserOperationOutcome;
	}
	return undefined;
}

function beginBrowserOperation(options: BrowserOperationOptions, target: BrowserOperationTarget, guard: SessionMutationReplayGuard | undefined): CommandActiveOperationInfo {
	return options.server.beginOperation({
		commandName: options.commandName,
		command: options.command ?? options.action ?? options.mode ?? options.commandName,
		browserSessionId: target.browserSessionId,
		tabId: target.tabId,
		targetRef: target.targetRef,
		generation: target.generation,
		ownerId: options.ctx?.operationOwnerId ?? "local-cli",
		intentId: guard ? undefined : options.intentId,
		intentPayload: guard ? undefined : options.intentPayload,
		mutation: !guard,
		phase: "arming",
		progress: 5,
		queueDepth: options.server.queueDepth(target.browserSessionId, target.tabId),
		leaseOwnerHash: options.server.leaseOwnerHash(target.browserSessionId, target.tabId),
	});
}

function mutationReplayMessage(kind: SessionMutationReplayGuard["kind"]): string {
	switch (kind) {
		case "intent_replay": return "This intent was already dispatched; verify its prior outcome instead of replaying it.";
		case "intent_conflict": return "This intentId was already used with a different mutation payload; reuse the original payload or choose a new business intent.";
		case "mutation_in_progress": return "Another mutation is already in progress on this target; wait for its factual outcome before issuing any write.";
		case "ledger_capacity": return "The protected mutation ledger is full; Browser Pilot refused a new write instead of evicting at-most-once evidence.";
		case "observation_required": return "A prior acknowledged mutation on this target has not been observed yet; call browser_observe before another mutation.";
	}
}

function blockedMutationOutcome(options: BrowserOperationOptions, target: BrowserOperationTarget, operation: CommandActiveOperationInfo, guard: SessionMutationReplayGuard): BrowserOperationOutcome {
	const now = Date.now();
	const outcome: BrowserOperationOutcome = {
		schema: BROWSER_OPERATION_SCHEMA,
		operationId: operation.operationId,
		commandName: options.commandName,
		status: "ambiguous",
		...classifyBrowserOperationStatus("ambiguous"),
		target,
		dispatch: { acknowledged: false, started: false, finished: false, startedAt: now, finishedAt: now },
		signals: {},
		diagnostics: [{
			code: "MUTATION_REPLAY_BLOCKED",
			message: mutationReplayMessage(guard.kind),
			reason: guard.kind,
			priorOperationId: guard.operationId,
			priorStatus: guard.terminalStatus,
		}],
	};
	const publicOutcome = redactSensitiveValue(outcome) as BrowserOperationOutcome;
	options.server.finishOperation(operation.operationId, publicOutcome);
	return publicOutcome;
}

function completedOperationOutcome(
	options: BrowserOperationOptions,
	target: BrowserOperationTarget,
	operation: CommandActiveOperationInfo,
	result: unknown,
	settled: OperationSettlement,
	lateEffects: BrowserOperationLateEffect[],
	acknowledged: boolean,
	startedAt: number,
	dispatchFinishedAt: number,
): BrowserOperationOutcome {
	const signals = summarizeSignals(settled.events);
	const dispatchSummary = summarizeBrowserOperationDispatch({ ...options, result, events: settled.events });
	const diagnostics = [...(settled.diagnostics ?? []), ...(dispatchSummary ? [dispatchSummary] : [])];
	const dispatchStarted = browserDispatchStarted(options, result);
	return redactSensitiveValue({
		schema: BROWSER_OPERATION_SCHEMA,
		operationId: operation.operationId,
		commandName: options.commandName,
		status: settled.status,
		...classifyBrowserOperationStatus(settled.status),
		target: completedTarget(target, result),
		dispatch: { acknowledged, started: dispatchStarted, finished: dispatchStarted, startedAt, finishedAt: dispatchFinishedAt },
		signals,
		...(settled.completion ? { completion: settled.completion } : {}),
		...(signals.mutationCount ? { pageEffect: { changed: settled.events.filter((event) => event.type === "mutation").slice(-20).map((event) => event.data) } } : {}),
		...(diagnostics.length ? { diagnostics } : {}),
		...(lateEffects.length ? { lateEffects } : {}),
	}) as BrowserOperationOutcome;
}

function failedOperationOutcome(
	options: BrowserOperationOptions,
	target: BrowserOperationTarget,
	operation: CommandActiveOperationInfo,
	error: unknown,
	lateEffects: BrowserOperationLateEffect[],
	acknowledged: boolean,
	dispatchStarted: boolean,
	startedAt: number,
): BrowserOperationOutcome {
	const finishedAt = Date.now();
	const events = options.server.getOperation?.(operation.operationId)?.events ?? [];
	const observerLoss = operationObserverLoss(events);
	const status = observerLoss || acknowledged ? "ambiguous" : statusForError(error);
	return redactSensitiveValue({
		schema: BROWSER_OPERATION_SCHEMA,
		operationId: operation.operationId,
		commandName: options.commandName,
		status,
		...classifyBrowserOperationStatus(status),
		target,
		dispatch: { acknowledged, started: dispatchStarted, finished: false, startedAt, finishedAt },
		signals: summarizeSignals(events),
		diagnostics: [...(observerLoss?.diagnostics ?? []), errorToPlain(error)],
		...(lateEffects.length ? { lateEffects } : {}),
	}) as BrowserOperationOutcome;
}

async function dispatchBrowserOperation<T>(options: BrowserOperationOptions, dispatch: (context: BrowserOperationDispatchContext) => Promise<T>, target: BrowserOperationTarget, operation: CommandActiveOperationInfo): Promise<BrowserOperationOutcome> {
	const lateEffects = options.server.surfaceLateEffects?.({ ownerId: options.ctx?.operationOwnerId, browserSessionId: target.browserSessionId, excludeOperationId: operation.operationId }) ?? [];
	const startedAt = Date.now();
	const deadlineAt = startedAt + options.timeoutMs;
	const controller = new AbortController();
	const abortFromCaller = () => controller.abort(options.signal?.reason ?? new BrowserBridgeError("BRIDGE_TIMEOUT", "Browser operation was cancelled by its caller", { aborted: true }));
	const deadlineError = new BrowserBridgeError("BRIDGE_TIMEOUT", `Browser operation exceeded its ${options.timeoutMs}ms hard deadline`, { timeoutMs: options.timeoutMs, aborted: true });
	const deadlineTimer = setTimeout(() => controller.abort(deadlineError), Math.max(0, options.timeoutMs));
	if (options.timeoutMs <= 0) controller.abort(deadlineError);
	if (options.signal?.aborted) abortFromCaller();
	else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
	const activeOptions = { ...options, signal: controller.signal };
	let acknowledged = false;
	let dispatchStarted = false;
	try {
		const armed = await armExtension(activeOptions, operation, target);
		if (!armed.acknowledged || !isRecord(armed.data) || armed.data.armed !== true) throw new Error("operation observers were not armed before dispatch");
		options.server.updateOperation(operation.operationId, { phase: "dispatching", progress: 20 });
		dispatchStarted = true;
		const result = await dispatch({ signal: controller.signal, operationId: operation.operationId, deadlineAt });
		const dispatchFinishedAt = Date.now();
		acknowledged = dispatchEvidence(result).acknowledged;
		options.server.updateOperation(operation.operationId, { phase: "resolving", progress: 75, details: { acknowledged } });
		const settled = await settleStatus(activeOptions, operation.operationId, result, dispatchFinishedAt, deadlineAt);
		const publicOutcome = completedOperationOutcome(options, target, operation, result, settled, lateEffects, acknowledged, startedAt, dispatchFinishedAt);
		await finishExtension(options, operation.operationId, target);
		options.server.finishOperation(operation.operationId, publicOutcome);
		return publicOutcome;
	} catch (error) {
		acknowledged = acknowledged || errorWasAcknowledged(error);
		const terminalError = errorHasDispatchEvidence(error) ? error : controller.signal.aborted && controller.signal.reason ? controller.signal.reason : error;
		acknowledged = acknowledged || errorWasAcknowledged(terminalError);
		const publicOutcome = failedOperationOutcome(options, target, operation, terminalError, lateEffects, acknowledged, dispatchStartedForError(terminalError, dispatchStarted), startedAt);
		await finishExtension(options, operation.operationId, target);
		options.server.finishOperation(operation.operationId, publicOutcome);
		return publicOutcome;
	} finally {
		clearTimeout(deadlineTimer);
		options.signal?.removeEventListener("abort", abortFromCaller);
	}
}

export async function withBrowserOperation<T>(options: BrowserOperationOptions, dispatch: (context: BrowserOperationDispatchContext) => Promise<T>): Promise<BrowserOperationOutcome> {
	const target = resolveTarget(options);
	const guard = mutationReplayGuard(options, target);
	const reusedOutcome = reusedIntentOutcome(options, guard);
	if (reusedOutcome) return reusedOutcome;
	const operation = beginBrowserOperation(options, target, guard);
	if (guard) return blockedMutationOutcome(options, target, operation, guard);
	return await dispatchBrowserOperation(options, dispatch, target, operation);
}
