import { createBrowserAbmlIntegration } from "../browser-command-runtime/abml/integration.js";
import { randomUUID } from "node:crypto";
import { buildAbmlActionOutcome, type AbmlActionContext, type ActionOutcomeStability } from "../kernels/abml/actionOutcome.js";
import type { Entity } from "../kernels/abml/entity.js";
import type { EntityDiff } from "../kernels/abml/diff.js";
import { samePageIdentity, type PageIdentity } from "../kernels/session/pageIdentity.js";
import type { BrowserOperationEvent, BrowserOperationTarget } from "../kernels/session/browserOperation.js";
import type { BrowserCommandRuntimePort, CommandActiveOperationInfo } from "../ports/BrowserCommandRuntimePort.js";
import { isRecord } from "../utils/records.js";
import { currentPageIdentity } from "./observe/pageIdentity.js";
import { readPageFingerprint, type PageFingerprint } from "./pageSignals.js";
import type {
	BrowserOperationSemanticWindow,
	SemanticExecutionPrepareInput,
	SemanticExecutionProvider,
	SemanticExecutionProviderFactory,
	SemanticExecutionSettleInput,
	SemanticExecutionSettlement,
} from "./semanticExecution.js";

const QUIET_WINDOW_MS = 500;
const DEADLINE_GUARD_MS = 40;
const MAX_DIAGNOSTICS = 4;
const SETTLEMENT_CAPTURE_MAX_CHARS = 100_000;
const SETTLEMENT_CAPTURE_TIMEOUT_MS = 2_500;

type StructureRead = {
	ok: boolean;
	entities?: Entity[];
	diff?: EntityDiff;
	error?: unknown;
};

type SettlementDependencies = {
	readStructure?: (input: { baseline?: Entity[]; timeoutMs: number; signal: AbortSignal }) => Promise<StructureRead>;
	readFingerprint?: (input: { timeoutMs: number; signal: AbortSignal }) => Promise<PageFingerprint | undefined>;
	readIdentity?: (fingerprint: PageFingerprint | undefined) => PageIdentity | undefined;
	now?: () => number;
};

type SourceFence = {
	fenceId: string;
	sourceSequence: number;
	revision: number;
	checkedAt: number;
	observerFound: boolean;
	deliveryReliable: boolean;
};

type CaptureAttempt = {
	stability: ActionOutcomeStability;
	reason?: string;
	window?: BrowserOperationSemanticWindow;
	entities?: Entity[];
	diff?: EntityDiff;
	identity?: PageIdentity;
	fingerprint?: PageFingerprint;
	startFence?: SourceFence;
	endFence?: SourceFence;
	revision: number;
};

type StableCaptureAttempt = CaptureAttempt & { stability: "stable"; entities: Entity[]; identity: PageIdentity };

function isStableCaptureAttempt(attempt: CaptureAttempt | undefined): attempt is StableCaptureAttempt {
	return attempt?.stability === "stable" && attempt.entities !== undefined && attempt.identity !== undefined;
}

function remainingMs(deadlineAt: number, now: () => number): number {
	return Math.max(0, deadlineAt - now());
}

function captureTimeout(deadlineAt: number, now: () => number): number {
	return Math.max(100, Math.min(SETTLEMENT_CAPTURE_TIMEOUT_MS, remainingMs(deadlineAt, now) - DEADLINE_GUARD_MS));
}

function fenceEvent(operation: CommandActiveOperationInfo, fenceId: string, sourceSequence: number): BrowserOperationEvent | undefined {
	return operation.events.find((event) => (event.type === "checkpoint" || event.type === "dispatch")
		&& event.sourceSequence === sourceSequence
		&& event.data?.fenceId === fenceId);
}

function sourceFenceFromEvent(event: BrowserOperationEvent | undefined): SourceFence | undefined {
	if (!event || event.sourceSequence === undefined || typeof event.data?.fenceId !== "string") return undefined;
	const deliveryFailures = Number(event.data.deliveryFailures ?? 0);
	return {
		fenceId: event.data.fenceId,
		sourceSequence: event.sourceSequence,
		revision: event.ledgerRevision,
		checkedAt: typeof event.data.checkedAt === "number" ? event.data.checkedAt : event.timestamp,
		observerFound: event.data.mutationObserverFound === true,
		deliveryReliable: Number.isFinite(deliveryFailures) && deliveryFailures === 0 && event.data.deliveryReliable !== false,
	};
}

function sourceWindowEvents(operation: CommandActiveOperationInfo, start: number, end: number): BrowserOperationEvent[] {
	return operation.events
		.filter((event) => event.sourceSequence !== undefined && event.sourceSequence >= start && event.sourceSequence <= end)
		.sort((left, right) => Number(left.sourceSequence) - Number(right.sourceSequence));
}

function hasContiguousSourceWindow(events: BrowserOperationEvent[], start: number, end: number): boolean {
	if (events.length !== end - start + 1) return false;
	return events.every((event, index) => event.sourceSequence === start + index);
}

function captureWindowDescriptor(input: {
	startedAt: number;
	endedAt: number;
	attempts: number;
	start: SourceFence;
	end: SourceFence;
	fingerprint: PageFingerprint;
	entityCount: number;
}): BrowserOperationSemanticWindow {
	return {
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		attempts: input.attempts,
		startSourceSequence: input.start.sourceSequence,
		endSourceSequence: input.end.sourceSequence,
		changeSeq: input.fingerprint.changeSeq,
		pageEpoch: input.fingerprint.pageEpoch!,
		entityCount: input.entityCount,
	};
}

function pageWindowReason(input: {
	beforeFingerprint?: PageFingerprint;
	afterFingerprint?: PageFingerprint;
	beforeIdentity?: PageIdentity;
	afterIdentity?: PageIdentity;
	baselineIdentity?: PageIdentity;
}): string | undefined {
	const { beforeFingerprint, afterFingerprint, beforeIdentity, afterIdentity, baselineIdentity } = input;
	if (!beforeFingerprint || !afterFingerprint) return "fingerprint_unavailable";
	if (!beforeFingerprint.pageEpoch || !afterFingerprint.pageEpoch) return "page_epoch_unavailable";
	if (!beforeIdentity || !afterIdentity) return "page_identity_unavailable";
	if (beforeFingerprint.changeSeq !== afterFingerprint.changeSeq) return "page_changed_during_capture";
	if (!samePageIdentity(beforeIdentity, afterIdentity)) return "page_identity_changed_during_capture";
	if (baselineIdentity && !samePageIdentity(baselineIdentity, afterIdentity)) return "page_identity_changed_since_dispatch";
	if ([beforeFingerprint.readyState, afterFingerprint.readyState].some((state) => state && state !== "complete")) return "document_not_complete";
	return undefined;
}

function sourceWindowReason(operation: CommandActiveOperationInfo, start: SourceFence, end: SourceFence): string | undefined {
	const startEvent = fenceEvent(operation, start.fenceId, start.sourceSequence);
	const endEvent = fenceEvent(operation, end.fenceId, end.sourceSequence);
	if (!startEvent || !endEvent) return "checkpoint_history_unavailable";
	if (!start.observerFound || !end.observerFound) return "mutation_observer_unavailable";
	if (!start.deliveryReliable || !end.deliveryReliable) return "mutation_delivery_lost";
	const events = sourceWindowEvents(operation, start.sourceSequence, end.sourceSequence);
	if (!hasContiguousSourceWindow(events, start.sourceSequence, end.sourceSequence)) return "checkpoint_source_gap";
	if (events.some((event) => event.type !== "checkpoint" && event.progress !== false)) return "progress_during_capture";
	const temporalEvents = operation.events.filter((event) => event.timestamp >= start.checkedAt && event.timestamp <= end.checkedAt);
	if (temporalEvents.some((event) => event.type === "observer_lost" || event.type === "target_lost")) return "observer_or_target_lost";
	if (temporalEvents.some((event) => event.sourceSequence === undefined && event.progress !== false)) return "unsequenced_progress_during_capture";
	return undefined;
}

function pendingOperationWork(events: BrowserOperationEvent[]): boolean {
	const count = (type: string) => events.filter((event) => event.type === type).length;
	return count("network_started") > count("network_completed")
		|| count("download_started") > count("download_completed");
}

function semanticDiagnostic(code: string, message: string, details: Record<string, unknown> = {}): Record<string, unknown> {
	return { code, message, ...details };
}

async function waitForOperationChange(server: BrowserCommandRuntimePort, operation: CommandActiveOperationInfo, timeoutMs: number, signal: AbortSignal): Promise<CommandActiveOperationInfo | undefined> {
	if (signal.aborted) throw signal.reason ?? new DOMException("Semantic settlement aborted", "AbortError");
	if (timeoutMs <= 0) return operation;
	if (server.waitForOperationChange) return await server.waitForOperationChange(operation.operationId, operation.revision, timeoutMs, signal);
	await new Promise<void>((resolve, reject) => {
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			resolve();
		};
		const timer = setTimeout(finish, timeoutMs);
		const onAbort = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason ?? new DOMException("Semantic settlement aborted", "AbortError"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
	return server.getOperation?.(operation.operationId) ?? operation;
}

async function waitForQuiet(server: BrowserCommandRuntimePort, operationId: string, dispatchFinishedAt: number, deadlineAt: number, signal: AbortSignal, now: () => number, afterSourceSequence = 0, allowPending = false): Promise<CommandActiveOperationInfo> {
	const initial = server.getOperation?.(operationId);
	if (!initial) throw new Error("semantic settlement operation ledger is unavailable");
	let operation: CommandActiveOperationInfo = initial;
	while (remainingMs(deadlineAt, now) > DEADLINE_GUARD_MS) {
		const actionEvents: BrowserOperationEvent[] = operation.events.filter((event: BrowserOperationEvent) => event.sourceSequence === undefined || event.sourceSequence > afterSourceSequence);
		const lastProgressAt: number = actionEvents.filter((event: BrowserOperationEvent) => event.progress !== false).reduce((latest: number, event: BrowserOperationEvent) => Math.max(latest, event.timestamp), dispatchFinishedAt);
		const quietAt: number = Math.max(dispatchFinishedAt, lastProgressAt) + QUIET_WINDOW_MS;
		const completionObserved = allowPending || actionEvents.some((event) => event.type === "navigation_completed" || event.type === "download_completed");
		const pending = !completionObserved && pendingOperationWork(actionEvents);
		if (!pending && now() >= quietAt) return operation;
		const boundary: number = pending ? deadlineAt - DEADLINE_GUARD_MS : Math.min(quietAt, deadlineAt - DEADLINE_GUARD_MS);
		operation = await waitForOperationChange(server, operation, Math.max(0, boundary - now()), signal) ?? operation;
	}
	return operation;
}

async function waitForSourceFence(server: BrowserCommandRuntimePort, operationId: string, fenceId: string, sourceSequence: number, deadlineAt: number, signal: AbortSignal, now: () => number): Promise<{ operation: CommandActiveOperationInfo; event: BrowserOperationEvent }> {
	let operation = server.getOperation?.(operationId);
	if (!operation) throw new Error("semantic settlement operation ledger is unavailable");
	while (remainingMs(deadlineAt, now) > DEADLINE_GUARD_MS) {
		const event = fenceEvent(operation, fenceId, sourceSequence);
		if (event) return { operation, event };
		operation = await waitForOperationChange(server, operation, Math.max(0, deadlineAt - DEADLINE_GUARD_MS - now()), signal) ?? operation;
	}
	throw new Error("semantic settlement checkpoint did not enter the operation ledger before deadline");
}

function createDefaultDependencies(server: BrowserCommandRuntimePort, target: BrowserOperationTarget): Required<SettlementDependencies> {
	const now = () => Date.now();
	return {
		now,
		readStructure: async ({ baseline, timeoutMs, signal }) => {
			const integration = createBrowserAbmlIntegration(server, {
				browserSessionId: target.browserSessionId,
				tabId: target.tabId,
				timeoutMs,
				maxChars: SETTLEMENT_CAPTURE_MAX_CHARS,
				captureProfile: "settlement",
				signal,
			});
			return await integration.readStructure({ baseline }) ?? { ok: false };
		},
		readFingerprint: async ({ timeoutMs, signal }) => await readPageFingerprint(server, {
			browserSessionId: target.browserSessionId,
			tabId: target.tabId,
			timeoutMs,
			signal,
		}),
		readIdentity: (fingerprint) => currentPageIdentity(server, { browserSessionId: target.browserSessionId, tabId: target.tabId }, fingerprint),
	};
}

class AbmlExecutionSettlementProvider implements SemanticExecutionProvider {
	private operationId?: string;
	private baseline?: CaptureAttempt;
	private dispatchFence?: SourceFence;
	private readonly diagnostics: Array<Record<string, unknown>> = [];

	constructor(
		private readonly server: BrowserCommandRuntimePort,
		private readonly target: BrowserOperationTarget,
		private readonly action: AbmlActionContext,
		private readonly dependencies: Required<SettlementDependencies>,
	) {}

	async prepare(input: SemanticExecutionPrepareInput): Promise<void> {
		this.operationId = input.operationId;
		for (let attempt = 1; attempt <= 2 && remainingMs(input.deadlineAt, this.dependencies.now) > DEADLINE_GUARD_MS; attempt += 1) {
			let captured: CaptureAttempt;
			try {
				captured = await this.capture(input, attempt);
			} catch (error) {
				if (input.signal.aborted) throw error;
				this.recordCaptureFailure("SEMANTIC_BASELINE_CAPTURE_FAILED", error instanceof Error ? error.message : String(error), attempt);
				continue;
			}
			this.baseline = captured;
			if (captured.stability === "stable") return;
			this.recordCaptureFailure("SEMANTIC_BASELINE_UNSTABLE", captured.reason, attempt);
			if (attempt < 2) await this.waitForBaselineRetry(input);
		}
	}

	async beforeDispatch(input: SemanticExecutionPrepareInput): Promise<void> {
		this.operationId = input.operationId;
		this.dispatchFence = undefined;
		let invalidReason: string | undefined;
		for (let attempt = 1; attempt <= 2 && remainingMs(input.deadlineAt, this.dependencies.now) > DEADLINE_GUARD_MS; attempt += 1) {
			const timeoutMs = captureTimeout(input.deadlineAt, this.dependencies.now);
			const fingerprint = await this.dependencies.readFingerprint({ timeoutMs, signal: input.signal });
			const identity = this.dependencies.readIdentity(fingerprint);
			const fence = await this.checkpoint(input, `dispatch-${attempt}`);
			this.dispatchFence = fence;
			const baseline = this.baseline;
			if (baseline?.stability !== "stable" || !baseline.endFence || !baseline.fingerprint || !baseline.identity) return;
			const operation = this.server.getOperation?.(input.operationId);
			invalidReason = operation
				? sourceWindowReason(operation, baseline.endFence, fence) ?? pageWindowReason({
					beforeFingerprint: baseline.fingerprint,
					afterFingerprint: fingerprint,
					beforeIdentity: baseline.identity,
					afterIdentity: identity,
				})
				: "operation_history_unavailable";
			if (!invalidReason) return;
			this.recordCaptureFailure("SEMANTIC_DISPATCH_FENCE_INVALID", invalidReason, attempt);
			if (attempt < 2) {
				try {
					this.baseline = await this.capture(input, attempt + 2);
				} catch (error) {
					if (input.signal.aborted) throw error;
					this.recordCaptureFailure("SEMANTIC_BASELINE_CAPTURE_FAILED", error instanceof Error ? error.message : String(error), attempt + 2);
					this.baseline = undefined;
				}
			}
		}
		if (this.baseline?.stability === "stable") this.baseline = { ...this.baseline, stability: "changing", reason: invalidReason ?? "dispatch_fence_unavailable" };
	}

	actionEventBoundary(): number | undefined {
		return this.actualDispatchFence()?.sourceSequence ?? this.dispatchFence?.sourceSequence;
	}

	async settle(input: SemanticExecutionSettleInput): Promise<SemanticExecutionSettlement> {
		const dispatchReason = this.dispatchAttributionReason(input.operationId);
		if (dispatchReason) {
			this.recordCaptureFailure("SEMANTIC_ACTUAL_DISPATCH_FENCE_INVALID", dispatchReason, 1);
			if (this.baseline) this.baseline = { ...this.baseline, stability: "changing", reason: dispatchReason };
			return await this.settleWithoutBaseline(input, dispatchReason);
		}
		const baseline = this.baseline;
		if (!isStableCaptureAttempt(baseline)) {
			return await this.settleWithoutBaseline(input, "baseline_unavailable");
		}
		return await this.settleAgainstBaseline(input, baseline);
	}

	private async settleAgainstBaseline(input: SemanticExecutionSettleInput, baseline: StableCaptureAttempt): Promise<SemanticExecutionSettlement> {
		let last: CaptureAttempt | undefined;
		let attempt = 0;
		while (remainingMs(input.deadlineAt, this.dependencies.now) > DEADLINE_GUARD_MS) {
			attempt += 1;
			await waitForQuiet(this.server, input.operationId, input.dispatchFinishedAt, input.deadlineAt, input.signal, this.dependencies.now, this.actionEventBoundary(), input.terminalHint === "verified");
			if (remainingMs(input.deadlineAt, this.dependencies.now) <= DEADLINE_GUARD_MS) break;
			last = await this.captureSettlementAttempt(input, attempt, baseline);
			if (!last) continue;
			const settled = await this.resolveCaptureSettlement(input, last, attempt, baseline);
			if (settled) return settled;
		}
		return { ...this.unstableSettlement(input.operationId, last), deadlineReached: true };
	}

	private async captureSettlementAttempt(input: SemanticExecutionSettleInput, attempt: number, baseline: StableCaptureAttempt): Promise<CaptureAttempt | undefined> {
		try {
			return await this.capture(input, attempt, baseline.entities, baseline.identity);
		} catch (error) {
			if (input.signal.aborted) throw error;
			this.recordCaptureFailure("SEMANTIC_CAPTURE_FAILED", error instanceof Error ? error.message : String(error), attempt);
			const current = this.server.getOperation?.(input.operationId);
			if (current) await this.waitForCaptureRetry(input, current.revision);
			return undefined;
		}
	}

	private async resolveCaptureSettlement(input: SemanticExecutionSettleInput, capture: CaptureAttempt, attempt: number, baseline: CaptureAttempt & { entities: Entity[] }): Promise<SemanticExecutionSettlement | undefined> {
		if (capture.stability !== "stable" || !capture.entities || !capture.diff) {
			this.recordCaptureFailure("SEMANTIC_CAPTURE_UNSTABLE", capture.reason, attempt);
			if (input.terminalHint === "verified" || this.completionEventObserved(input.operationId)) return this.unstableSettlement(input.operationId, capture);
			await this.waitForCaptureRetry(input, capture.revision);
			return undefined;
		}
		const outcome = buildAbmlActionOutcome({
			action: this.action,
			beforeEntities: baseline.entities,
			afterEntities: capture.entities,
			diff: capture.diff,
			stability: "stable",
			elapsedMs: capture.window && baseline.window ? capture.window.endedAt - baseline.window.startedAt : undefined,
		});
		const settlement = this.settlementFromOutcome(capture, outcome);
		if (outcome.verification.status === "verified") return settlement;
		if (outcome.verification.status !== "failed" && (outcome.effect.summary.hasSemanticEffect || input.terminalHint !== "unverified-mutation")) return settlement;
		return await this.waitForPostCaptureChange(input, capture.revision) ? undefined : { ...settlement, deadlineReached: true };
	}

	private actualDispatchFence(): SourceFence | undefined {
		if (!this.dispatchFence || !this.operationId) return undefined;
		const operation = this.server.getOperation?.(this.operationId);
		const event = [...(operation?.events ?? [])].reverse().find((candidate) => candidate.type === "dispatch"
			&& candidate.sourceSequence !== undefined
			&& candidate.sourceSequence > this.dispatchFence!.sourceSequence);
		return sourceFenceFromEvent(event);
	}

	private dispatchAttributionReason(operationId: string): string | undefined {
		if (!this.dispatchFence) return "dispatch_fence_unavailable";
		const actual = this.actualDispatchFence();
		if (!actual) return "actual_dispatch_fence_unavailable";
		const operation = this.server.getOperation?.(operationId);
		return operation ? sourceWindowReason(operation, this.dispatchFence, actual) : "operation_history_unavailable";
	}

	private async settleWithoutBaseline(input: SemanticExecutionSettleInput, reason: string): Promise<SemanticExecutionSettlement> {
		let lastFence: SourceFence | undefined;
		let attempt = 0;
		while (remainingMs(input.deadlineAt, this.dependencies.now) > DEADLINE_GUARD_MS) {
			attempt += 1;
			await waitForQuiet(this.server, input.operationId, input.dispatchFinishedAt, input.deadlineAt, input.signal, this.dependencies.now, this.actionEventBoundary(), input.terminalHint === "verified");
			if (remainingMs(input.deadlineAt, this.dependencies.now) <= DEADLINE_GUARD_MS) break;
			lastFence = await this.checkpoint(input, `unavailable-${attempt}`);
			if (input.terminalHint !== "unverified-mutation") return this.unavailableSettlement(input.operationId, reason, lastFence.revision);
			const changed = await this.waitForPostCaptureChange(input, lastFence.revision);
			if (!changed) return { ...this.unavailableSettlement(input.operationId, reason, lastFence.revision), deadlineReached: true };
		}
		return { ...this.unavailableSettlement(input.operationId, reason, lastFence?.revision), deadlineReached: true };
	}

	private async checkpoint(input: SemanticExecutionPrepareInput, label: string): Promise<SourceFence> {
		const fenceId = `semantic-${input.operationId}-${label}-${randomUUID()}`;
		const timeoutMs = captureTimeout(input.deadlineAt, this.dependencies.now);
		const result = await this.server.sendCommand({ cmd: "operation.checkpoint", operationId: input.operationId, fenceId }, {
			browserSessionId: this.target.browserSessionId,
			...(this.target.targetRef ? { targetRef: this.target.targetRef } : this.target.tabId !== undefined ? { tabId: this.target.tabId } : {}),
			timeoutMs,
			accessMode: "read",
			internal: true,
			signal: input.signal,
		});
		const data = isRecord(result.data) ? result.data : {};
		const sourceSequence = Number(data.sourceSequence);
		if (!result.acknowledged || !Number.isInteger(sourceSequence) || sourceSequence <= 0) throw new Error("semantic checkpoint was not acknowledged with a source sequence");
		const ledger = await waitForSourceFence(this.server, input.operationId, fenceId, sourceSequence, input.deadlineAt, input.signal, this.dependencies.now);
		const deliveryFailures = Number(data.deliveryFailures ?? ledger.event.data?.deliveryFailures ?? 0);
		return {
			fenceId,
			sourceSequence,
			revision: ledger.event.ledgerRevision,
			checkedAt: typeof data.checkedAt === "number" ? data.checkedAt : this.dependencies.now(),
			observerFound: ledger.event.data?.mutationObserverFound === true,
			deliveryReliable: Number.isFinite(deliveryFailures) && deliveryFailures === 0 && ledger.event.data?.deliveryReliable !== false,
		};
	}

	private async capture(input: SemanticExecutionPrepareInput, attempt: number, baseline?: Entity[], baselineIdentity?: PageIdentity): Promise<CaptureAttempt> {
		const startedAt = this.dependencies.now();
		const start = await this.checkpoint(input, `start-${attempt}`);
		const timeoutMs = captureTimeout(input.deadlineAt, this.dependencies.now);
		const beforeFingerprint = await this.dependencies.readFingerprint({ timeoutMs, signal: input.signal });
		const beforeIdentity = this.dependencies.readIdentity(beforeFingerprint);
		const structure = await this.dependencies.readStructure({ baseline, timeoutMs, signal: input.signal });
		const afterFingerprint = await this.dependencies.readFingerprint({ timeoutMs, signal: input.signal });
		const afterIdentity = this.dependencies.readIdentity(afterFingerprint);
		const end = await this.checkpoint(input, `end-${attempt}`);
		const operation = this.server.getOperation?.(input.operationId);
		if (!operation) return { stability: "unknown", reason: "operation_history_unavailable", startFence: start, endFence: end, revision: end.revision };
		const reason = sourceWindowReason(operation, start, end) ?? pageWindowReason({ beforeFingerprint, afterFingerprint, beforeIdentity, afterIdentity, baselineIdentity });
		if (reason || !structure.ok || !structure.entities || (baseline && !structure.diff)) {
			return {
				stability: reason ? "changing" : "unknown",
				reason: reason ?? "abml_structure_unavailable",
				fingerprint: afterFingerprint,
				identity: afterIdentity,
				startFence: start,
				endFence: end,
				revision: end.revision,
			};
		}
		const window = captureWindowDescriptor({
			startedAt,
			endedAt: this.dependencies.now(),
			attempts: attempt,
			start,
			end,
			fingerprint: afterFingerprint!,
			entityCount: structure.entities.length,
		});
		return {
			stability: "stable",
			window,
			entities: structure.entities,
			diff: structure.diff,
			identity: afterIdentity,
			fingerprint: afterFingerprint,
			startFence: start,
			endFence: end,
			revision: end.revision,
		};
	}

	private settlementFromOutcome(capture: CaptureAttempt, outcome: ReturnType<typeof buildAbmlActionOutcome>): SemanticExecutionSettlement {
		return {
			expectedRevision: capture.revision,
			semantic: {
				provider: "abml",
				stability: "stable",
				baseline: this.baseline?.window,
				capture: capture.window,
				effect: outcome.effect,
				verification: outcome.verification,
				...(this.diagnostics.length ? { diagnostics: this.diagnostics.slice(-MAX_DIAGNOSTICS) } : {}),
			},
		};
	}

	private async waitForPostCaptureChange(input: SemanticExecutionSettleInput, revision: number): Promise<boolean> {
		const operation = this.server.getOperation?.(input.operationId);
		if (!operation || operation.revision !== revision) return true;
		const timeoutMs = Math.max(0, input.deadlineAt - DEADLINE_GUARD_MS - this.dependencies.now());
		const changed = await waitForOperationChange(this.server, operation, timeoutMs, input.signal);
		return changed !== undefined && changed.revision !== revision;
	}

	private async waitForCaptureRetry(input: SemanticExecutionSettleInput, revision: number): Promise<void> {
		const operation = this.server.getOperation?.(input.operationId);
		if (!operation || operation.revision !== revision) return;
		const timeoutMs = Math.max(0, Math.min(QUIET_WINDOW_MS, input.deadlineAt - DEADLINE_GUARD_MS - this.dependencies.now()));
		await waitForOperationChange(this.server, operation, timeoutMs, input.signal);
	}

	private async waitForBaselineRetry(input: SemanticExecutionPrepareInput): Promise<void> {
		const operation = this.server.getOperation?.(input.operationId);
		if (!operation) return;
		const timeoutMs = Math.max(0, Math.min(500, input.deadlineAt - DEADLINE_GUARD_MS - this.dependencies.now()));
		await waitForOperationChange(this.server, operation, timeoutMs, input.signal);
	}

	private completionEventObserved(operationId: string): boolean {
		const boundary = this.actionEventBoundary() ?? 0;
		return this.server.getOperation?.(operationId)?.events.some((event) => (event.sourceSequence === undefined || event.sourceSequence > boundary)
			&& (event.type === "navigation_completed" || event.type === "download_completed")) === true;
	}

	private unavailableSettlement(operationId: string, reason: string, expectedRevision?: number): SemanticExecutionSettlement {
		const operation = this.server.getOperation?.(operationId);
		return {
			expectedRevision: expectedRevision ?? operation?.revision ?? 0,
			semantic: {
				provider: "abml",
				stability: "unknown",
				baseline: this.baseline?.window,
				diagnostics: [...this.diagnostics, semanticDiagnostic("SEMANTIC_EVIDENCE_UNAVAILABLE", "ABML could not establish a stable pre-action model.", { reason })].slice(-MAX_DIAGNOSTICS),
			},
		};
	}

	private unstableSettlement(operationId: string, capture: CaptureAttempt | undefined): SemanticExecutionSettlement {
		const operation = this.server.getOperation?.(operationId);
		return {
			expectedRevision: capture?.revision ?? operation?.revision ?? 0,
			semantic: {
				provider: "abml",
				stability: capture?.stability ?? "unknown",
				baseline: this.baseline?.window,
				capture: capture?.window,
				diagnostics: [...this.diagnostics, semanticDiagnostic("SEMANTIC_SETTLEMENT_INCONCLUSIVE", "ABML could not establish a stable post-action capture before settlement ended.", { reason: capture?.reason ?? "capture_unavailable" })].slice(-MAX_DIAGNOSTICS),
			},
		};
	}

	private recordCaptureFailure(code: string, reason: string | undefined, attempt: number): void {
		this.diagnostics.push(semanticDiagnostic(code, "A fenced ABML capture was discarded because its page window was not stable.", { reason: reason ?? "unknown", attempt }));
		if (this.diagnostics.length > MAX_DIAGNOSTICS) this.diagnostics.splice(0, this.diagnostics.length - MAX_DIAGNOSTICS);
	}
}

export function createAbmlExecutionSettlementProvider(input: Parameters<SemanticExecutionProviderFactory>[0], dependencies: SettlementDependencies = {}): SemanticExecutionProvider | undefined {
	if (!input.target.tabId || !input.target.browserSessionId || !input.server.getOperation || !input.server.finishOperationIfRevision) return undefined;
	const defaults = createDefaultDependencies(input.server, input.target);
	return new AbmlExecutionSettlementProvider(input.server, input.target, input.action, { ...defaults, ...dependencies });
}

export type { SettlementDependencies };
