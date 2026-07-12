import { resolveArtifactPath, saveTextArtifact } from "../artifacts/artifactFiles.js";
import { ArtifactReaderError, MAX_ARTIFACT_READ_BYTES } from "../artifacts/artifactReaderShared.js";
import type { BrowserOperationOutcome } from "../kernels/session/browserOperation.js";
import { stableJson } from "../utils/json.js";
import type { BrowserTextCommandResult } from "../utils/toolResult.js";
import type { ToolResultBudgetName } from "./budgets.js";
import { inlineJsonCommandResult, type CommandResultContext } from "./commandRuntime.js";

type OperationContinuation = {
	next: "inspect_artifact" | "observe" | "reacquire_target" | "inspect_diagnostics" | "verify_command_state";
	reason: string;
	replay: "not_needed" | "do_not_retry";
};

type OperationArtifactHints = {
	kind: "BrowserOperation";
	schemaVersion: 1;
	jsonPaths: Record<string, string>;
	preferredReads: Array<{ label: string; jsonPath: string; kind: string }>;
	saved: Record<string, unknown>;
};

type OperationResultOptions = {
	budgetName: ToolResultBudgetName;
	maxChars: number;
	ctx?: CommandResultContext;
	details: Record<string, unknown>;
};

function uncertainContinuationNext(outcome: BrowserOperationOutcome): OperationContinuation["next"] {
	if (Number(outcome.signals.newTabs || 0) > 0 || outcome.signals.targetChanged) return "reacquire_target";
	if (outcome.commandName === "browser_tabs") return "reacquire_target";
	if (Number(outcome.signals.downloadsStarted || 0) > 1) return outcome.diagnostics?.length ? "inspect_diagnostics" : "verify_command_state";
	if (["browser_execute", "browser_download", "browser_upload", "browser_frame"].includes(outcome.commandName)) return "observe";
	if (outcome.signals.navigation || outcome.signals.mutationCount || outcome.signals.dialogs) return "observe";
	return outcome.diagnostics?.length ? "inspect_diagnostics" : "verify_command_state";
}

function effectContinuation(outcome: BrowserOperationOutcome): OperationContinuation {
	const next = uncertainContinuationNext(outcome);
	let reason = "command_state_unverified";
	if (next === "observe") reason = "business_state_unverified";
	else if (next === "reacquire_target") reason = "target_state_unverified";
	else if (next === "inspect_diagnostics") reason = "diagnostics_available";
	return { next, reason, replay: "do_not_retry" };
}

function completedContinuation(outcome: BrowserOperationOutcome, compacted: boolean): OperationContinuation | undefined {
	const source = String(outcome.completion?.source || "");
	if (["tab-close", "new-tab-ready"].includes(source)) return { next: "reacquire_target", reason: "target_no_longer_current", replay: "not_needed" };
	if (["tab-create", "tab-switch"].includes(source)) return { next: "observe", reason: "target_state_changed", replay: "not_needed" };
	if (outcome.signals.newTabs || outcome.signals.targetChanged) return { next: "reacquire_target", reason: "target_state_changed", replay: "not_needed" };
	if (outcome.signals.navigation || outcome.signals.mutationCount) return { next: "observe", reason: "target_state_changed", replay: "not_needed" };
	return compacted ? { next: "inspect_artifact", reason: "result_compacted", replay: "not_needed" } : undefined;
}

function continuationFor(outcome: BrowserOperationOutcome, compacted: boolean): OperationContinuation | undefined {
	switch (outcome.status) {
		case "target_lost": return { next: "reacquire_target", reason: "target_lost", replay: "do_not_retry" };
		case "failed": return { next: outcome.diagnostics?.length ? "inspect_diagnostics" : "verify_command_state", reason: "dispatch_failed", replay: "do_not_retry" };
		case "effect_observed": return effectContinuation(outcome);
		case "no_effect":
		case "stalled":
		case "ambiguous":
		case "deadline": return { next: uncertainContinuationNext(outcome), reason: outcome.status, replay: "do_not_retry" };
		case "completed": return completedContinuation(outcome, compacted);
	}
}

function boundedText(value: string, maxChars = 160): string {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

function serializedChars(value: unknown): number | undefined {
	const serialized = stableJson(value) as string | undefined;
	return typeof serialized === "string" ? serialized.length : undefined;
}

function hasSerializableResult(evidence: Record<string, unknown>): boolean {
	return Object.prototype.hasOwnProperty.call(evidence, "result") && serializedChars(evidence.result) !== undefined;
}

function compactSample(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return boundedText(value, 64);
	if (value === null || typeof value !== "object") return value;
	if (depth >= 2) return Array.isArray(value) ? { type: "array", count: value.length } : { type: "object", keyCount: Object.keys(value).length };
	if (Array.isArray(value)) return { type: "array", count: value.length, sample: value.slice(0, 1).map((item) => compactSample(item, depth + 1)) };
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	return {
		type: "object",
		keyCount: keys.length,
		sample: Object.fromEntries(keys.slice(0, 3).map((key) => [key, compactSample(record[key], depth + 1)])),
	};
}

function compactCompletionResult(value: unknown): Record<string, unknown> {
	const chars = serializedChars(value) ?? 0;
	if (typeof value === "string") return { type: "string", chars: value.length, preview: boundedText(value), truncated: true };
	if (Array.isArray(value)) return { type: "array", count: value.length, chars, sample: value.slice(0, 3).map((item) => compactSample(item)), truncated: true };
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record);
		return {
			type: "object",
			keyCount: keys.length,
			keys: keys.slice(0, 12),
			chars,
			sample: Object.fromEntries(keys.slice(0, 3).map((key) => [key, compactSample(record[key])])),
			truncated: true,
		};
	}
	return { type: value === null ? "null" : typeof value, value, chars, truncated: true };
}

function compactDiagnostics(diagnostics: unknown[] | undefined): unknown[] | undefined {
	if (!diagnostics?.length) return undefined;
	return diagnostics.slice(0, 3).map((item) => {
		if (!item || typeof item !== "object") return typeof item === "string" ? boundedText(item) : item;
		const record = item as Record<string, unknown>;
		return Object.fromEntries(["name", "code", "message", "kind", "retryable"].flatMap((key) => record[key] === undefined ? [] : [[key, typeof record[key] === "string" ? boundedText(String(record[key])) : record[key]] as const]));
	});
}

function compactLateEffects(outcome: BrowserOperationOutcome): BrowserOperationOutcome["lateEffects"] {
	return outcome.lateEffects?.slice(-3).map((item) => ({
		type: item.type,
		operationId: item.operationId,
		commandName: item.commandName,
		terminalStatus: item.terminalStatus,
		event: {
			operationId: item.event.operationId,
			sequence: item.event.sequence,
			type: item.event.type,
			timestamp: item.event.timestamp,
			...(item.event.targetRef ? { targetRef: item.event.targetRef } : {}),
			...(item.event.tabId !== undefined ? { tabId: item.event.tabId } : {}),
			...(item.event.generation !== undefined ? { generation: item.event.generation } : {}),
			...(item.event.late === true ? { late: true } : {}),
		},
	}));
}

function compactPageEffect(outcome: BrowserOperationOutcome): BrowserOperationOutcome["pageEffect"] {
	if (!outcome.pageEffect) return undefined;
	const compactArray = (items: unknown[] | undefined) => items?.slice(-3).map((item) => compactSample(item));
	return {
		...(outcome.pageEffect.appeared ? { appeared: compactArray(outcome.pageEffect.appeared) } : {}),
		...(outcome.pageEffect.disappeared ? { disappeared: compactArray(outcome.pageEffect.disappeared) } : {}),
		...(outcome.pageEffect.changed ? { changed: compactArray(outcome.pageEffect.changed) } : {}),
		...(outcome.pageEffect.newActionables ? { newActionables: compactArray(outcome.pageEffect.newActionables) } : {}),
	};
}

function compactOutcome(outcome: BrowserOperationOutcome): { value: Record<string, unknown>; omitted: string[] } {
	const omitted: string[] = [];
	let completion = outcome.completion;
	if (completion && hasSerializableResult(completion.evidence)) {
		completion = { ...completion, evidence: { ...completion.evidence, result: compactCompletionResult(completion.evidence.result) } };
		omitted.push("completion.evidence.result");
	}
	if (outcome.pageEffect) omitted.push("pageEffect");
	if (outcome.lateEffects?.length) omitted.push("lateEffects[].event.data");
	if (outcome.diagnostics?.length) omitted.push("diagnostics[].details");
	return {
		value: {
			...outcome,
			...(completion ? { completion } : {}),
			...(outcome.pageEffect ? { pageEffect: compactPageEffect(outcome) } : {}),
			...(outcome.lateEffects?.length ? { lateEffects: compactLateEffects(outcome) } : {}),
			...(outcome.diagnostics?.length ? { diagnostics: compactDiagnostics(outcome.diagnostics) } : {}),
		},
		omitted,
	};
}

function artifactHints(outcome: BrowserOperationOutcome, saved: Record<string, unknown>): OperationArtifactHints {
	const jsonPaths: Record<string, string> = { signals: "signals" };
	const preferredReads: OperationArtifactHints["preferredReads"] = [];
	const add = (key: string, label: string, jsonPath: string, kind: string, preferred = true) => {
		jsonPaths[key] = jsonPath;
		if (preferred) preferredReads.push({ label, jsonPath, kind });
	};
	const hasCompletionResult = outcome.completion && hasSerializableResult(outcome.completion.evidence);
	if (outcome.completion) add("completionEvidence", "completion evidence", "completion.evidence", "operation-completion", !hasCompletionResult);
	if (outcome.completion && hasSerializableResult(outcome.completion.evidence)) add("completionResult", "resolved result", "completion.evidence.result", "execute-result");
	if (outcome.pageEffect) add("pageEffect", "page effect", "pageEffect", "operation-effect");
	if (outcome.lateEffects?.length) add("lateEffects", "late effects", "lateEffects", "operation-late-effects");
	if (outcome.diagnostics?.length) add("diagnostics", "operation diagnostics", "diagnostics", "operation-diagnostics");
	return { kind: "BrowserOperation", schemaVersion: 1, jsonPaths, preferredReads, saved: compactSavedDescriptor(saved) };
}

function compactSavedDescriptor(saved: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(["path", "chars", "bytes", "mime"].flatMap((key) => saved[key] === undefined ? [] : [[key, saved[key]] as const]));
}

function minimalResultPointer(value: unknown, artifactAvailable: boolean): Record<string, unknown> {
	return {
		type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value === "object" ? "object" : typeof value,
		chars: serializedChars(value) ?? 0,
		truncated: true,
		...(!artifactAvailable ? { evidenceUnavailable: true } : {}),
	};
}

function minimalCompletion(outcome: BrowserOperationOutcome, artifactAvailable: boolean): Record<string, unknown> | undefined {
	if (!outcome.completion) return undefined;
	const evidence = outcome.completion.evidence;
	return {
		source: outcome.completion.source,
		...(hasSerializableResult(evidence) ? { evidence: { result: minimalResultPointer(evidence.result, artifactAvailable) } } : {}),
	};
}

function minimalSignals(outcome: BrowserOperationOutcome): BrowserOperationOutcome["signals"] {
	return {
		...outcome.signals,
		...(typeof outcome.signals.navigation === "string" ? { navigation: boundedText(outcome.signals.navigation, 64) } : {}),
	};
}

function minimalOmittedPaths(outcome: BrowserOperationOutcome, base: string[], artifactAvailable: boolean): string[] {
	const omitted = new Set(base);
	if (outcome.pageEffect) omitted.add("pageEffect");
	if (outcome.lateEffects?.length) omitted.add("lateEffects");
	if (outcome.diagnostics?.length) omitted.add("diagnostics");
	if (outcome.target.url !== undefined) omitted.add("target.url");
	if (outcome.target.scriptable !== undefined) omitted.add("target.scriptable");
	if (outcome.target.cdpAvailable !== undefined) omitted.add("target.cdpAvailable");
	if (typeof outcome.signals.navigation === "string" && outcome.signals.navigation.length > 64) omitted.add("signals.navigation");
	if (outcome.completion && !hasSerializableResult(outcome.completion.evidence) && Object.keys(outcome.completion.evidence).length) omitted.add("completion.evidence");
	if (artifactAvailable) {
		omitted.add("artifact_metadata");
	}
	return Array.from(omitted);
}

function minimalOperationCore(outcome: BrowserOperationOutcome, artifactAvailable: boolean): Record<string, unknown> {
	return {
		version: outcome.version,
		operationId: outcome.operationId,
		commandName: outcome.commandName,
		status: outcome.status,
		target: Object.fromEntries(["browserSessionId", "targetRef", "tabId", "generation"].flatMap((key) => outcome.target[key as keyof typeof outcome.target] === undefined ? [] : [[key, outcome.target[key as keyof typeof outcome.target]] as const])),
		dispatch: {
			acknowledged: outcome.dispatch.acknowledged,
			started: outcome.dispatch.started,
			finished: outcome.dispatch.finished,
			startedAt: outcome.dispatch.startedAt,
			...(outcome.dispatch.finishedAt !== undefined ? { finishedAt: outcome.dispatch.finishedAt } : {}),
		},
		signals: minimalSignals(outcome),
		...(outcome.completion ? { completion: minimalCompletion(outcome, artifactAvailable) } : {}),
	};
}

function minimalOperationResponse(input: {
	outcome: BrowserOperationOutcome;
	artifact: { saved: Record<string, unknown>; hints: OperationArtifactHints };
	continuation?: OperationContinuation;
	maxChars: number;
	originalChars: number;
	omitted: string[];
}): Record<string, unknown> {
	const { outcome, artifact } = input;
	const keysByContinuation: Record<OperationContinuation["next"], string[]> = {
		inspect_artifact: ["completionResult", "completionEvidence"],
		inspect_diagnostics: ["diagnostics"],
		observe: ["pageEffect", "signals"],
		reacquire_target: ["signals", "lateEffects"],
		verify_command_state: ["signals", "diagnostics", "completionEvidence"],
	};
	const preferredKey = [
		...(input.continuation ? keysByContinuation[input.continuation.next] : []),
		...Object.keys(artifact.hints.jsonPaths),
	].find((key, index, keys) => keys.indexOf(key) === index && artifact.hints.jsonPaths[key] !== undefined);
	const preferredPath = preferredKey ? { [preferredKey]: artifact.hints.jsonPaths[preferredKey]! } : {};
	return {
		...minimalOperationCore(outcome, true),
		...(input.continuation ? { continuation: input.continuation } : {}),
		limits: { maxChars: input.maxChars, originalChars: input.originalChars, truncated: true, omitted: minimalOmittedPaths(outcome, input.omitted, true) },
		artifact_hints: { jsonPaths: preferredPath },
		saved: { path: artifact.saved.path },
	};
}

function artifactSaveFailureDiagnostic(error: unknown): Record<string, unknown> {
	const causeCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
	return {
		code: "ARTIFACT_SAVE_FAILED",
		message: boundedText(error instanceof Error ? error.message : String(error), 96),
		...(causeCode ? { causeCode } : {}),
		evidenceUnavailable: true,
	};
}

function markCompletionEvidenceUnavailable(value: Record<string, unknown>): Record<string, unknown> {
	if (!value.completion || typeof value.completion !== "object" || Array.isArray(value.completion)) return value;
	const completion = value.completion as Record<string, unknown>;
	if (!completion.evidence || typeof completion.evidence !== "object" || Array.isArray(completion.evidence)) return value;
	const evidence = completion.evidence as Record<string, unknown>;
	if (!evidence.result || typeof evidence.result !== "object" || Array.isArray(evidence.result)) return value;
	return {
		...value,
		completion: {
			...completion,
			evidence: { ...evidence, result: { ...(evidence.result as Record<string, unknown>), evidenceUnavailable: true } },
		},
	};
}

function artifactSaveFailureResponse(outcome: BrowserOperationOutcome, error: unknown, maxChars: number, originalChars: number): Record<string, unknown> {
	const compacted = compactOutcome(outcome);
	const baseContinuation = continuationFor(outcome, false);
	const continuation: OperationContinuation = baseContinuation
		? { ...baseContinuation, replay: "do_not_retry" }
		: { next: "inspect_diagnostics", reason: "artifact_save_failed", replay: "do_not_retry" };
	const failure = artifactSaveFailureDiagnostic(error);
	const diagnostics = [...(compactDiagnostics(outcome.diagnostics) ?? []), failure];
	const limits = { maxChars, originalChars, truncated: true, omitted: [...compacted.omitted, "artifact"] };
	const value = { ...markCompletionEvidenceUnavailable(compacted.value), continuation, diagnostics, limits };
	if (stableJson(value).length <= Math.max(1_000, maxChars)) return value;
	return { ...minimalOperationCore(outcome, false), continuation, diagnostics: [failure], limits: { ...limits, omitted: minimalOmittedPaths(outcome, limits.omitted, false) } };
}

function safeArtifactName(value: string): string {
	return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "operation";
}

async function saveOperationArtifact(outcome: BrowserOperationOutcome, ctx: CommandResultContext | undefined): Promise<{ saved: Record<string, unknown>; hints: OperationArtifactHints }> {
	const fallbackName = `${safeArtifactName(outcome.commandName)}-${safeArtifactName(outcome.operationId)}.json`;
	const artifactPath = resolveArtifactPath(ctx, undefined, fallbackName);
	const pathOnly = { path: artifactPath };
	const hints = artifactHints(outcome, pathOnly);
	const continuation = continuationFor(outcome, false);
	const content = stableJson({ ...outcome, ...(continuation ? { continuation } : {}), artifact_hints: hints, saved: pathOnly });
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > MAX_ARTIFACT_READ_BYTES) {
		throw new ArtifactReaderError("ARTIFACT_TOO_LARGE", `Operation artifact exceeds readable byte limit (${bytes} bytes, max ${MAX_ARTIFACT_READ_BYTES})`, {
			path: artifactPath,
			bytes,
			maxBytes: MAX_ARTIFACT_READ_BYTES,
		});
	}
	const saved = await saveTextArtifact(ctx, artifactPath, fallbackName, content);
	return { saved, hints: artifactHints(outcome, saved) };
}

export async function browserOperationCommandResult(outcome: BrowserOperationOutcome, options: OperationResultOptions): Promise<BrowserTextCommandResult> {
	const continuation = continuationFor(outcome, false);
	const inlineValue = { ...outcome, ...(continuation ? { continuation } : {}) };
	const originalChars = stableJson(inlineValue).length;
	if (originalChars <= options.maxChars) {
		return inlineJsonCommandResult(inlineValue, options.details, { maxChars: options.maxChars }, options.budgetName);
	}
	let artifact: Awaited<ReturnType<typeof saveOperationArtifact>>;
	try {
		artifact = await saveOperationArtifact(outcome, options.ctx);
	} catch (error) {
		const value = artifactSaveFailureResponse(outcome, error, options.maxChars, originalChars);
		return inlineJsonCommandResult(value, options.details, { maxChars: options.maxChars }, options.budgetName);
	}
	const compacted = compactOutcome(outcome);
	const compactContinuation = continuationFor(outcome, true);
	let value: Record<string, unknown> = {
		...compacted.value,
		...(compactContinuation ? { continuation: compactContinuation } : {}),
		limits: { maxChars: options.maxChars, originalChars, truncated: true, omitted: compacted.omitted },
		artifact_hints: artifact.hints,
		saved: artifact.saved,
	};
	if (stableJson(value).length > Math.max(1_000, options.maxChars)) {
		value = minimalOperationResponse({ outcome, artifact, continuation: compactContinuation, maxChars: options.maxChars, originalChars, omitted: compacted.omitted });
	}
	return inlineJsonCommandResult(value, { ...options.details, saved: artifact.saved }, { maxChars: options.maxChars }, options.budgetName);
}
