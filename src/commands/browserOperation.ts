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
import type { AbmlActionContext } from "../kernels/abml/actionOutcome.js";
import type {
	BrowserOperationBusinessResult,
	BrowserOperationSemanticEvidence,
	SemanticExecutionProvider,
	SemanticExecutionProviderFactory,
} from "./semanticExecution.js";

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
	semanticExecution?: SemanticExecutionProviderFactory;
	semanticAction?: AbmlActionContext;
	semanticMutation?: boolean;
};

export type BrowserOperationDispatchContext = {
	signal: AbortSignal;
	operationId: string;
	targetGeneration?: number;
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

async function sendExtensionCleanup(options: BrowserOperationOptions, operationId: string, browserSessionId: string | undefined, command: "operation.finish" | "operation.cancel"): Promise<boolean> {
	const controller = new AbortController();
	const timeoutMs = Math.min(3_000, Math.max(500, options.timeoutMs));
	const timer = setTimeout(() => controller.abort(new BrowserBridgeError("BRIDGE_TIMEOUT", `${command} cleanup timed out`, { operationId, cleanup: true })), timeoutMs);
	try {
		const result = await options.server.sendCommand({ cmd: command, operationId }, {
			browserSessionId,
			timeoutMs,
			accessMode: "read",
			internal: true,
			signal: controller.signal,
		});
		const data = isRecord(result.data) ? result.data : {};
		return result.acknowledged && (command === "operation.finish" ? data.finished === true : data.cancelled === true);
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

async function finishExtension(options: BrowserOperationOptions, operationId: string, browserSessionId: string | undefined): Promise<void> {
	if (await sendExtensionCleanup(options, operationId, browserSessionId, "operation.finish")) return;
	await sendExtensionCleanup(options, operationId, browserSessionId, "operation.cancel");
}

type OperationSettlement = {
	status: BrowserOperationStatus;
	events: BrowserOperationEvent[];
	completion?: ReturnType<typeof resolveBrowserOperationCompletion>;
	diagnostics?: Array<Record<string, unknown>>;
	semantic?: BrowserOperationSemanticEvidence;
	business?: BrowserOperationBusinessResult;
	expectedRevision?: number;
};

type SemanticTerminalHint = "verified" | "query" | "declared-failure" | "unverified-mutation";

function terminalEvidence(options: BrowserOperationOptions, result: unknown, events: BrowserOperationEvent[]): OperationSettlement | undefined {
	if (events.filter((event) => event.type === "new_tab").length > 1) return { status: "ambiguous", events };
	if (events.filter((event) => event.type === "download_started").length > 1) return { status: "ambiguous", events };
	const dispatchTerminal = resolveBrowserOperationDispatchTerminal({ ...options, result, events });
	if (dispatchTerminal) return { ...dispatchTerminal, events };
	const completion = resolveBrowserOperationCompletion({ ...options, result, events });
	return completion ? { status: "completed", events, completion } : undefined;
}

function strongBusinessCompletion(completion: OperationSettlement["completion"]): boolean {
	return completion !== undefined && !["script-resolved", "program-resolved", "native-command-result"].includes(completion.source);
}

function semanticTerminalHint(options: BrowserOperationOptions, terminal: OperationSettlement | undefined): SemanticTerminalHint {
	if (declaredBusinessFailure(terminal)) return "declared-failure";
	if (strongBusinessCompletion(terminal?.completion)) return "verified";
	if (options.semanticMutation) return "unverified-mutation";
	return terminal?.completion ? "query" : "unverified-mutation";
}

function declaredBusinessFailure(terminal: OperationSettlement | undefined): boolean {
	return terminal?.diagnostics?.some((diagnostic) => ["BUSINESS_POSTCONDITION_FAILED", "PROGRAM_VERIFICATION_FAILED"].includes(String(diagnostic.code || ""))) === true;
}

function semanticBusinessResult(semantic: BrowserOperationSemanticEvidence, completion: OperationSettlement["completion"]): BrowserOperationBusinessResult {
	if (semantic.verification?.status === "verified") return { status: "verified", source: "abml", reason: "declared_expectation_matched" };
	if (semantic.verification?.status === "failed") return strongBusinessCompletion(completion)
		? { status: "inconclusive", source: "abml", reason: "semantic_and_completion_proof_conflict" }
		: { status: "failed", source: "abml", reason: "stable_expectation_contradicted" };
	if (strongBusinessCompletion(completion)) return { status: "verified", source: completion!.source, reason: "declared_completion_proof" };
	const observed = semantic.verification?.observed;
	const reason = isRecord(observed) && typeof observed.reason === "string" ? observed.reason : semantic.stability === "stable" ? "business_expectation_not_declared" : "semantic_evidence_unavailable";
	return { status: "inconclusive", source: "abml", reason };
}

function terminalHasStrongBusinessProof(terminal: OperationSettlement | undefined): boolean {
	return terminal?.status === "completed" && strongBusinessCompletion(terminal.completion);
}

function stableQueryCompleted(terminal: OperationSettlement | undefined, semantic: BrowserOperationSemanticEvidence, terminalHint: SemanticTerminalHint): boolean {
	return terminal?.status === "completed"
		&& terminalHint === "query"
		&& semantic.stability === "stable"
		&& semantic.effect?.summary.hasSemanticEffect === false;
}

function semanticSettlementStatus(
	terminal: OperationSettlement | undefined,
	semantic: BrowserOperationSemanticEvidence,
	deadlineReached: boolean,
	terminalHint: SemanticTerminalHint,
): BrowserOperationStatus {
	if (terminal?.status !== "completed" && declaredBusinessFailure(terminal)) return terminal!.status;
	const verification = semantic.verification?.status;
	if (verification === "verified") return "completed";
	if (verification === "failed") return terminalHasStrongBusinessProof(terminal) ? "ambiguous" : "failed";
	if (terminalHasStrongBusinessProof(terminal)) return "completed";
	if (semantic.effect?.summary.hasSemanticEffect === true) return "effect_observed";
	if (stableQueryCompleted(terminal, semantic, terminalHint)) return "completed";
	if (terminal && terminal.status !== "completed") return terminal.status;
	return deadlineReached ? "deadline" : "ambiguous";
}

function semanticSettlementCompletion(
	terminal: OperationSettlement | undefined,
	semantic: BrowserOperationSemanticEvidence,
	status: BrowserOperationStatus,
): OperationSettlement["completion"] {
	if (semantic.verification?.status === "verified" && status === "completed") {
		return { source: "abml-verified", evidence: { verification: semantic.verification, semantic: semantic.effect?.summary ?? {} } };
	}
	return status === "effect_observed" ? undefined : terminal?.completion;
}

function semanticOperationSettlement(
	terminal: OperationSettlement | undefined,
	semantic: BrowserOperationSemanticEvidence,
	expectedRevision: number,
	deadlineReached: boolean,
	events: BrowserOperationEvent[],
	terminalHint: SemanticTerminalHint,
): OperationSettlement {
	const diagnostics = [...(terminal?.diagnostics ?? []), ...(semantic.diagnostics ?? [])];
	const status = semanticSettlementStatus(terminal, semantic, deadlineReached, terminalHint);
	const completion = semanticSettlementCompletion(terminal, semantic, status);
	return {
		status,
		events,
		...(completion ? { completion } : {}),
		...(diagnostics.length ? { diagnostics } : {}),
		semantic,
		business: semanticBusinessResult(semantic, completion),
		expectedRevision,
	};
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

function eventsAfterActionBoundary(events: BrowserOperationEvent[], actionBoundary: number | undefined): BrowserOperationEvent[] {
	return actionBoundary === undefined
		? events
		: events.filter((event) => event.sourceSequence === undefined || event.sourceSequence > actionBoundary);
}

function semanticFields(semantic: BrowserOperationSemanticEvidence | undefined): Pick<OperationSettlement, "semantic" | "business"> {
	return semantic ? { semantic, business: semanticBusinessResult(semantic, undefined) } : {};
}

function semanticUnavailableAfterProof(observerLoss: OperationSettlement | undefined): BrowserOperationSemanticEvidence {
	return {
		provider: "abml",
		stability: "unknown",
		diagnostics: [{
			code: observerLoss ? "SEMANTIC_OBSERVER_LOST_AFTER_PROOF" : "SEMANTIC_TARGET_LOST_AFTER_PROOF",
			message: "A command-specific business proof completed, but ABML semantic capture was unavailable after the page observer or target changed.",
		}],
	};
}

function semanticLossSettlement(input: {
	terminal: OperationSettlement | undefined;
	observerLoss: OperationSettlement | undefined;
	targetLost: boolean;
	events: BrowserOperationEvent[];
	expectedRevision?: number;
	proofExpectedRevision?: number;
	semantic?: BrowserOperationSemanticEvidence;
	deadlineReached?: boolean;
}): OperationSettlement | undefined {
	if (!input.observerLoss && !input.targetLost) return undefined;
	if (terminalHasStrongBusinessProof(input.terminal)) {
		const semantic = input.semantic ?? semanticUnavailableAfterProof(input.observerLoss);
		const settled = semanticOperationSettlement(input.terminal, semantic, input.proofExpectedRevision ?? input.expectedRevision ?? 0, input.deadlineReached === true, input.events, "verified");
		return input.observerLoss ? { ...settled, diagnostics: [...(settled.diagnostics ?? []), ...(input.observerLoss.diagnostics ?? [])] } : settled;
	}
	const evidence = semanticFields(input.semantic);
	if (input.observerLoss) return { ...input.observerLoss, ...evidence, expectedRevision: input.expectedRevision };
	return { status: "target_lost", events: input.events, ...evidence, expectedRevision: input.expectedRevision };
}

async function settleWithSemantic(options: BrowserOperationOptions, provider: SemanticExecutionProvider, operationId: string, result: unknown, dispatchFinishedAt: number, deadlineAt: number): Promise<OperationSettlement> {
	let operation = options.server.getOperation?.(operationId);
	const actionBoundary = provider.actionEventBoundary();
	let events = eventsAfterActionBoundary(operation?.events ?? [], actionBoundary);
	const initialTerminal = terminalEvidence(options, result, events);
	const terminalHint = semanticTerminalHint(options, initialTerminal);
	const observerLoss = operationObserverLoss(events);
	const targetLost = operationTargetLost(events, operation);
	const initialLoss = semanticLossSettlement({ terminal: initialTerminal, observerLoss, targetLost, events, expectedRevision: operation?.revision });
	if (initialLoss) return initialLoss;
	const semanticResult = await provider.settle({
		operationId,
		dispatchFinishedAt,
		deadlineAt,
		signal: options.signal!,
		terminalHint,
	});
	operation = options.server.getOperation?.(operationId) ?? operation;
	events = eventsAfterActionBoundary(operation?.events ?? events, actionBoundary);
	const terminal = terminalEvidence(options, result, events);
	const latestObserverLoss = operationObserverLoss(events);
	const latestTargetLost = operationTargetLost(events, operation);
	const latestLoss = semanticLossSettlement({
		terminal,
		observerLoss: latestObserverLoss,
		targetLost: latestTargetLost,
		events,
		expectedRevision: operation?.revision,
		proofExpectedRevision: operation?.revision ?? semanticResult.expectedRevision,
		semantic: semanticResult.semantic,
		deadlineReached: semanticResult.deadlineReached,
	});
	if (latestLoss) return latestLoss;
	return semanticOperationSettlement(terminal, semanticResult.semantic, semanticResult.expectedRevision, semanticResult.deadlineReached === true, events, terminalHint);
}

function immediateOperationSettlement(
	options: BrowserOperationOptions,
	result: unknown,
	events: BrowserOperationEvent[],
	operation: CommandActiveOperationInfo | undefined,
	dispatchFinishedAt: number,
	deadlineAt: number,
): OperationSettlement | undefined {
	const terminal = terminalEvidence(options, result, events);
	if (terminal?.status === "completed") return { ...terminal, expectedRevision: operation?.revision };
	const observerLoss = operationObserverLoss(events);
	if (observerLoss) return { ...observerLoss, expectedRevision: operation?.revision };
	if (terminal) return { ...terminal, expectedRevision: operation?.revision };
	if (operationTargetLost(events, operation)) return { status: "target_lost", events, expectedRevision: operation?.revision };
	const liveness = livenessStatus(events, operation, dispatchFinishedAt, deadlineAt);
	return liveness ? { status: liveness, events, expectedRevision: operation?.revision } : undefined;
}

async function waitForSettlementBoundary(
	options: BrowserOperationOptions,
	operationId: string,
	operation: CommandActiveOperationInfo | undefined,
	events: BrowserOperationEvent[],
	dispatchFinishedAt: number,
	deadlineAt: number,
): Promise<void> {
	const now = Date.now();
	const boundary = livenessBoundary(events, operation, dispatchFinishedAt, deadlineAt, now);
	const timeoutMs = Math.max(0, boundary - now);
	if (options.server.waitForOperationChange && operation) {
		await options.server.waitForOperationChange(operationId, operation.revision, timeoutMs, options.signal);
		return;
	}
	// Non-production test ports may omit the waiter. Waiting once for the exact pure
	// boundary preserves event-driven production semantics and never polls the registry.
	await waitForBoundary(timeoutMs, options.signal);
}

async function settleStatus(options: BrowserOperationOptions, operationId: string, result: unknown, dispatchFinishedAt: number, deadlineAt: number, semanticProvider?: SemanticExecutionProvider): Promise<OperationSettlement> {
	if (semanticProvider) return await settleWithSemantic(options, semanticProvider, operationId, result, dispatchFinishedAt, deadlineAt);
	let operation = options.server.getOperation?.(operationId);
	let events = operation?.events ?? [];
	while (true) {
		operation = options.server.getOperation?.(operationId) ?? operation;
		events = operation?.events ?? events;
		const settled = immediateOperationSettlement(options, result, events, operation, dispatchFinishedAt, deadlineAt);
		if (settled) return settled;
		await waitForSettlementBoundary(options, operationId, operation, events, dispatchFinishedAt, deadlineAt);
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
	dispatchCompleted = true,
): BrowserOperationOutcome {
	const signals = summarizeSignals(settled.events);
	const dispatchSummary = summarizeBrowserOperationDispatch({ ...options, result, events: settled.events });
	const diagnostics = [...(settled.diagnostics ?? []), ...(dispatchSummary ? [dispatchSummary] : [])];
	const dispatchStarted = browserDispatchStarted(options, result);
	const settledAt = Date.now();
	return redactSensitiveValue({
		schema: BROWSER_OPERATION_SCHEMA,
		operationId: operation.operationId,
		commandName: options.commandName,
		status: settled.status,
		...classifyBrowserOperationStatus(settled.status),
		target: completedTarget(target, result),
		dispatch: { acknowledged, started: dispatchStarted, finished: dispatchCompleted && dispatchStarted, startedAt, finishedAt: dispatchFinishedAt, ...(settled.semantic ? { settledAt } : {}) },
		signals,
		...(settled.completion ? { completion: settled.completion } : {}),
		...(settled.semantic ? { semantic: settled.semantic } : {}),
		...(settled.business ? { business: settled.business } : {}),
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
	eventSnapshot?: BrowserOperationEvent[],
): BrowserOperationOutcome {
	const finishedAt = Date.now();
	const events = eventSnapshot ?? options.server.getOperation?.(operation.operationId)?.events ?? [];
	const observerLoss = operationObserverLoss(events);
	const errorStatus = statusForError(error);
	const status = observerLoss ? "ambiguous" : acknowledged && errorStatus !== "deadline" ? "ambiguous" : errorStatus;
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

type OperationOutcomeContext = {
	options: BrowserOperationOptions;
	target: BrowserOperationTarget;
	operation: CommandActiveOperationInfo;
	lateEffects: BrowserOperationLateEffect[];
	startedAt: number;
};

type BrowserDispatchState = {
	acknowledged: boolean;
	dispatchStarted: boolean;
	semanticProvider?: SemanticExecutionProvider;
	result?: unknown;
	dispatchFailure?: unknown;
};

type CompletedDispatchAttempt = {
	acknowledged: boolean;
	result?: unknown;
	dispatchFailure?: unknown;
	dispatchFinishedAt: number;
};

async function requireArmedExtension(options: BrowserOperationOptions, operation: CommandActiveOperationInfo, target: BrowserOperationTarget): Promise<void> {
	const armed = await armExtension(options, operation, target);
	if (!armed.acknowledged || !isRecord(armed.data) || armed.data.armed !== true) throw new Error("operation observers were not armed before dispatch");
}

function semanticProviderForOperation(options: BrowserOperationOptions, target: BrowserOperationTarget): SemanticExecutionProvider | undefined {
	if (!options.semanticExecution || !options.semanticAction) return undefined;
	const provider = options.semanticExecution({ server: options.server, target, action: options.semanticAction });
	if (!provider) throw new Error("semantic execution settlement requires a target ledger with revision-CAS support");
	return provider;
}

async function prepareOperationDispatch(options: BrowserOperationOptions, operationId: string, deadlineAt: number, provider?: SemanticExecutionProvider): Promise<void> {
	if (provider) {
		options.server.updateOperation(operationId, { phase: "modeling", progress: 12 });
		await provider.prepare({ operationId, deadlineAt, signal: options.signal! });
	}
	options.server.updateOperation(operationId, { phase: "dispatching", progress: 20 });
	if (provider) await provider.beforeDispatch({ operationId, deadlineAt, signal: options.signal! });
}

async function runOperationDispatch<T>(
	dispatch: (context: BrowserOperationDispatchContext) => Promise<T>,
	operation: CommandActiveOperationInfo,
	target: BrowserOperationTarget,
	deadlineAt: number,
	signal: AbortSignal,
	semanticProvider?: SemanticExecutionProvider,
): Promise<CompletedDispatchAttempt> {
	let acknowledged = false;
	let result: T | undefined;
	let dispatchFailure: unknown;
	try {
		result = await dispatch({ signal, operationId: operation.operationId, targetGeneration: target.generation, deadlineAt });
	} catch (error) {
		acknowledged = errorWasAcknowledged(error);
		if (!semanticProvider || (!acknowledged && !dispatchStartedForError(error, true))) throw error;
		dispatchFailure = error;
	}
	return {
		acknowledged: acknowledged || dispatchEvidence(result).acknowledged,
		result,
		dispatchFailure,
		dispatchFinishedAt: Date.now(),
	};
}

function commitSettledOutcome(
	options: BrowserOperationOptions,
	operationId: string,
	settled: OperationSettlement,
	outcome: BrowserOperationOutcome,
	semanticProvider?: SemanticExecutionProvider,
): CommandActiveOperationInfo | undefined {
	if (semanticProvider) return options.server.finishOperationIfRevision!(operationId, settled.expectedRevision!, outcome);
	if (options.server.finishOperationIfRevision && settled.expectedRevision !== undefined) {
		return options.server.finishOperationIfRevision(operationId, settled.expectedRevision, outcome);
	}
	return options.server.finishOperation(operationId, outcome);
}

async function commitCompletedDispatch(
	context: OperationOutcomeContext,
	activeOptions: BrowserOperationOptions,
	state: BrowserDispatchState,
	dispatchFinishedAt: number,
	deadlineAt: number,
): Promise<BrowserOperationOutcome> {
	while (true) {
		const resolved = await settleStatus(activeOptions, context.operation.operationId, state.result, dispatchFinishedAt, deadlineAt, state.semanticProvider);
		const settled = state.dispatchFailure ? { ...resolved, diagnostics: [...(resolved.diagnostics ?? []), errorToPlain(state.dispatchFailure)] } : resolved;
		const outcome = completedOperationOutcome(context.options, context.target, context.operation, state.result, settled, context.lateEffects, state.acknowledged, context.startedAt, dispatchFinishedAt, state.dispatchFailure === undefined);
		const committed = commitSettledOutcome(context.options, context.operation.operationId, settled, outcome, state.semanticProvider);
		if (!committed) continue;
		await finishExtension(context.options, context.operation.operationId, context.target.browserSessionId);
		return outcome;
	}
}

function semanticInterruptedAfterProof(): BrowserOperationSemanticEvidence {
	return {
		provider: "abml",
		stability: "unknown",
		diagnostics: [{ code: "SEMANTIC_SETTLEMENT_INTERRUPTED_AFTER_PROOF", message: "The command-specific business proof completed, but semantic capture was interrupted." }],
	};
}

function outcomeAfterTerminalError(
	context: OperationOutcomeContext,
	state: BrowserDispatchState,
	terminal: OperationSettlement | undefined,
	events: BrowserOperationEvent[],
	revision: number,
	terminalError: unknown,
	dispatchFinishedAt: number,
	deadlineAborted: boolean,
): BrowserOperationOutcome | undefined {
	if (!terminalHasStrongBusinessProof(terminal)) return undefined;
	const settled = state.semanticProvider
		? semanticOperationSettlement(terminal, semanticInterruptedAfterProof(), revision, deadlineAborted, events, "verified")
		: terminal!;
	return completedOperationOutcome(context.options, context.target, context.operation, state.result, {
		...settled,
		diagnostics: [...(settled.diagnostics ?? []), errorToPlain(terminalError)],
	}, context.lateEffects, state.acknowledged, context.startedAt, dispatchFinishedAt, state.dispatchFailure === undefined);
}

function commitFailedOutcome(context: OperationOutcomeContext, snapshot: CommandActiveOperationInfo | undefined, outcome: BrowserOperationOutcome): boolean {
	if (snapshot && context.options.server.finishOperationIfRevision) {
		return context.options.server.finishOperationIfRevision(context.operation.operationId, snapshot.revision, outcome) !== undefined;
	}
	context.options.server.finishOperation(context.operation.operationId, outcome);
	return true;
}

async function commitFailedDispatch(
	context: OperationOutcomeContext,
	state: BrowserDispatchState,
	terminalError: unknown,
	dispatchFinishedAt: number,
	deadlineAborted: boolean,
): Promise<BrowserOperationOutcome> {
	while (true) {
		const snapshot = context.options.server.getOperation?.(context.operation.operationId);
		const events = snapshot?.events ?? [];
		const terminal = terminalEvidence(context.options, state.result, events);
		const completed = outcomeAfterTerminalError(context, state, terminal, events, snapshot?.revision ?? 0, terminalError, dispatchFinishedAt, deadlineAborted);
		const outcome = completed ?? failedOperationOutcome(context.options, context.target, context.operation, terminalError, context.lateEffects, state.acknowledged, dispatchStartedForError(terminalError, state.dispatchStarted), context.startedAt, events);
		if (!commitFailedOutcome(context, snapshot, outcome)) continue;
		await finishExtension(context.options, context.operation.operationId, context.target.browserSessionId);
		return outcome;
	}
}

function terminalDispatchError(error: unknown, signal: AbortSignal): unknown {
	if (errorHasDispatchEvidence(error)) return error;
	return signal.aborted && signal.reason ? signal.reason : error;
}

async function dispatchBrowserOperation<T>(options: BrowserOperationOptions, dispatch: (context: BrowserOperationDispatchContext) => Promise<T>, target: BrowserOperationTarget, operation: CommandActiveOperationInfo, transactionDeadlineAt?: number): Promise<BrowserOperationOutcome> {
	const lateEffects = options.server.surfaceLateEffects?.({ ownerId: options.ctx?.operationOwnerId, browserSessionId: target.browserSessionId, excludeOperationId: operation.operationId }) ?? [];
	const startedAt = Date.now();
	const deadlineAt = transactionDeadlineAt ?? startedAt + options.timeoutMs;
	const controller = new AbortController();
	const abortFromCaller = () => controller.abort(options.signal?.reason ?? new BrowserBridgeError("BRIDGE_TIMEOUT", "Browser operation was cancelled by its caller", { aborted: true }));
	const deadlineError = new BrowserBridgeError("BRIDGE_TIMEOUT", `Browser operation exceeded its ${options.timeoutMs}ms hard deadline`, { timeoutMs: options.timeoutMs, aborted: true });
	const deadlineTimer = setTimeout(() => controller.abort(deadlineError), Math.max(0, deadlineAt - Date.now()));
	if (deadlineAt <= Date.now()) controller.abort(deadlineError);
	if (options.signal?.aborted) abortFromCaller();
	else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
	const activeOptions = { ...options, signal: controller.signal };
	const context = { options, target, operation, lateEffects, startedAt };
	const state: BrowserDispatchState = { acknowledged: false, dispatchStarted: false };
	try {
		await requireArmedExtension(activeOptions, operation, target);
		state.semanticProvider = semanticProviderForOperation(activeOptions, target);
		await prepareOperationDispatch(activeOptions, operation.operationId, deadlineAt, state.semanticProvider);
		state.dispatchStarted = true;
		const attempt = await runOperationDispatch(dispatch, operation, target, deadlineAt, controller.signal, state.semanticProvider);
		state.acknowledged = attempt.acknowledged;
		state.result = attempt.result;
		state.dispatchFailure = attempt.dispatchFailure;
		options.server.updateOperation(operation.operationId, { phase: "resolving", progress: 75, details: { acknowledged: state.acknowledged } });
		return await commitCompletedDispatch(context, activeOptions, state, attempt.dispatchFinishedAt, deadlineAt);
	} catch (error) {
		state.acknowledged = state.acknowledged || errorWasAcknowledged(error);
		const terminalError = terminalDispatchError(error, controller.signal);
		state.acknowledged = state.acknowledged || errorWasAcknowledged(terminalError);
		return await commitFailedDispatch(context, state, terminalError, Date.now(), controller.signal.aborted);
	} finally {
		clearTimeout(deadlineTimer);
		options.signal?.removeEventListener("abort", abortFromCaller);
	}
}

async function runLockedBrowserOperation<T>(options: BrowserOperationOptions, dispatch: (context: BrowserOperationDispatchContext) => Promise<T>, transactionDeadlineAt: number): Promise<BrowserOperationOutcome> {
	const target = resolveTarget(options);
	const guard = mutationReplayGuard(options, target);
	const reusedOutcome = reusedIntentOutcome(options, guard);
	if (reusedOutcome) return reusedOutcome;
	const operation = beginBrowserOperation(options, target, guard);
	if (guard) return blockedMutationOutcome(options, target, operation, guard);
	return await dispatchBrowserOperation(options, dispatch, target, operation, transactionDeadlineAt);
}

function undispatchedTransactionOutcome(options: BrowserOperationOptions, target: BrowserOperationTarget, error: unknown, startedAt: number): BrowserOperationOutcome {
	const operation = options.server.beginOperation({
		commandName: options.commandName,
		command: options.command ?? options.action ?? options.mode ?? options.commandName,
		browserSessionId: target.browserSessionId,
		tabId: target.tabId,
		targetRef: target.targetRef,
		generation: target.generation,
		ownerId: options.ctx?.operationOwnerId ?? "local-cli",
		mutation: false,
		phase: "queued",
		progress: 0,
		queueDepth: options.server.queueDepth(target.browserSessionId, target.tabId),
		leaseOwnerHash: options.server.leaseOwnerHash(target.browserSessionId, target.tabId),
	});
	const publicOutcome = failedOperationOutcome(options, target, operation, error, [], false, false, startedAt);
	options.server.finishOperation(operation.operationId, publicOutcome);
	return publicOutcome;
}

export async function withBrowserOperation<T>(options: BrowserOperationOptions, dispatch: (context: BrowserOperationDispatchContext) => Promise<T>): Promise<BrowserOperationOutcome> {
	const startedAt = Date.now();
	const transactionDeadlineAt = startedAt + options.timeoutMs;
	const target = resolveTarget(options);
	if (!options.server.withTargetTransaction || target.tabId === undefined) return await runLockedBrowserOperation(options, dispatch, transactionDeadlineAt);
	const controller = new AbortController();
	const abortFromCaller = () => controller.abort(options.signal?.reason ?? new BrowserBridgeError("BRIDGE_TIMEOUT", "Browser operation was cancelled while waiting for its target transaction", { aborted: true }));
	const timer = setTimeout(() => controller.abort(new BrowserBridgeError("BRIDGE_TIMEOUT", `Browser operation exceeded its ${options.timeoutMs}ms hard deadline while waiting for its target transaction`, { timeoutMs: options.timeoutMs, dispatchStarted: false, aborted: true })), Math.max(0, options.timeoutMs));
	if (options.signal?.aborted) abortFromCaller();
	else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
	try {
		return await options.server.withTargetTransaction({ browserSessionId: target.browserSessionId, tabId: target.tabId, signal: controller.signal }, async () => await runLockedBrowserOperation({ ...options, signal: controller.signal }, dispatch, transactionDeadlineAt));
	} catch (error) {
		if (dispatchStartedForError(error, false)) throw error;
		return undispatchedTransactionOutcome(options, target, error, startedAt);
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abortFromCaller);
	}
}
