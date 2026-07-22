import { randomUUID } from "node:crypto";
import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";
import { BrowserBridgeError, errorToPlain } from "../utils/errors.js";
import { normalizeNativeErrorCode } from "../types/nativeErrorCodes.js";
import { normalizeTabId } from "../utils/params.js";
import { isRecord } from "../utils/records.js";
import { urlOrigin } from "../utils/url.js";
import { errorResult, type BrowserTextCommandResult } from "../utils/toolResult.js";
import { stableJson } from "../utils/json.js";
import { classifyRefScope } from "../kernels/refs/refPolicy.js";
import { pageReanchorReason } from "../kernels/session/pageIdentity.js";
import type { ExecutionRefTarget } from "../browser-command-runtime/executionRef.js";
import { pageIdentityFromUnknown } from "./observe/pageIdentity.js";
import { asPositiveInt, optionalTargetRef } from "./commandShared.js";
import type { BrowserCommandDefinition, BrowserCommandSink } from "./commandDefinition.js";

/** Hard ceiling for any command timeout to prevent unbounded hangs. */
const MAX_COMMAND_TIMEOUT_MS = 300_000;

export type CommandResultContext = { cwd?: string; omitTransportDetails?: boolean } | undefined;

export type CommandOnUpdate = ((result: BrowserTextCommandResult) => void | Promise<void>) | undefined;

export type TrackedOperationInfo = {
	operationId: string;
	commandName: string;
	command?: string;
	browserSessionId?: string;
	tabId?: number;
	phase: string;
	progress?: number;
	queueDepth?: number;
	leaseOwnerHash?: string;
	conflictReason?: string;
	snapshotId?: string;
	sourceMode?: string;
	details?: Record<string, unknown>;
	state: "active" | "terminal";
	startedAt: number;
	updatedAt: number;
};

type TrackedOperationInput = Omit<TrackedOperationInfo, "operationId" | "state" | "startedAt" | "updatedAt"> & { operationId?: string };

export type TrackedOperationHandle = {
	operation: TrackedOperationInfo;
	update: (patch: Partial<Omit<TrackedOperationInfo, "operationId" | "startedAt">>, options?: { content?: boolean }) => Promise<TrackedOperationInfo>;
	finish: () => TrackedOperationInfo;
};

export function defineBrowserCommand(commands: BrowserCommandSink, spec: BrowserCommandDefinition) {
	commands.define(spec);
	return spec;
}

export function sharedTabScopedToolParams(targetRefDescription?: string) {
	return { targetRef: optionalTargetRef(targetRefDescription) };
}

export function commandTimeoutMs(value: unknown, fallback: number, options: { allowZero?: boolean } = {}): number {
	const n = Number(value);
	if (options.allowZero && Number.isFinite(n) && n === 0) return 0;
	if (!Number.isFinite(n) || n <= 0) return Math.min(fallback, MAX_COMMAND_TIMEOUT_MS);
	return Math.min(asPositiveInt(value, fallback), MAX_COMMAND_TIMEOUT_MS);
}

export function artifactFallbackName(prefix: string, extension = "json"): string {
	return `${prefix}-${Date.now()}.${extension}`;
}

export function targetTabId(params: { targetRef?: string }, body?: Record<string, unknown>): unknown {
	return params.targetRef ?? body?.targetRef ?? body?.tabHandle ?? body?.tabId;
}

export function resolveLocalTargetTabId(server: Partial<Pick<BrowserCommandRuntimePort, "resolveTargetTabId">>, value: unknown, browserSessionId?: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof server.resolveTargetTabId === "function") return server.resolveTargetTabId(value, browserSessionId);
	return normalizeTabId(value);
}

function soleRefOwner<T extends string | number>(refs: ExecutionRefTarget[], field: "browserSessionId" | "tabId"): T | undefined {
	const values = new Set(refs.map((ref) => ref.owner[field]).filter((value): value is T => value !== undefined));
	if (values.size > 1) throw new BrowserBridgeError("REF_SCOPE_VIOLATION", `Referenced elements belong to different ${field === "tabId" ? "tabs" : "browser sessions"}`, { refs: refs.map((ref) => ref.refId) });
	return values.values().next().value;
}

export function resolveRefExecutionTarget(
	server: Pick<BrowserCommandRuntimePort, "resolveTargetTabId" | "snapshot">,
	refs: ExecutionRefTarget[],
	options: { browserSessionId?: string; rawTarget?: unknown },
): { browserSessionId?: string; rawTarget?: string | number; tabId?: number } {
	if (!refs.length) {
		const tabId = resolveLocalTargetTabId(server, options.rawTarget, options.browserSessionId);
		return { browserSessionId: options.browserSessionId, rawTarget: options.rawTarget as string | number | undefined, tabId };
	}
	const stale = refs.find((ref) => !ref.fresh);
	if (stale) throw new BrowserBridgeError("REF_STALE", "Referenced browser state is stale", { ref: stale.refId });
	const blocked = refs.find((ref) => ref.policy.liveActionsAllowed !== true);
	if (blocked) throw new BrowserBridgeError("INVALID_RULE", "Referenced browser state does not allow live actions", { ref: blocked.refId });
	const unowned = refs.find((ref) => ref.owner.tabId === undefined);
	if (unowned) throw new BrowserBridgeError("REF_SCOPE_VIOLATION", "Executable refs must own a browser tab", { ref: unowned.refId });

	const ownerSession = soleRefOwner<string>(refs, "browserSessionId");
	const ownerTabId = soleRefOwner<number>(refs, "tabId");
	if (options.browserSessionId && ownerSession && options.browserSessionId !== ownerSession) {
		throw new BrowserBridgeError("REF_SCOPE_VIOLATION", "Explicit browserSessionId conflicts with ref ownership", { browserSessionId: options.browserSessionId, ownerBrowserSessionId: ownerSession, refs: refs.map((ref) => ref.refId) });
	}
	const browserSessionId = ownerSession ?? options.browserSessionId;
	let canonicalOwnerTabId: number | undefined;
	try {
		canonicalOwnerTabId = ownerTabId === undefined ? undefined : resolveLocalTargetTabId(server, ownerTabId, browserSessionId);
	} catch {
		throw new BrowserBridgeError("REF_STALE", "Referenced browser tab no longer exists", { ownerTabId, refs: refs.map((ref) => ref.refId) });
	}
	if (ownerTabId !== undefined && canonicalOwnerTabId !== ownerTabId) {
		throw new BrowserBridgeError("REF_STALE", "Referenced browser tab was replaced", { ownerTabId, canonicalOwnerTabId, refs: refs.map((ref) => ref.refId) });
	}
	const explicitTabId = options.rawTarget === undefined ? undefined : resolveLocalTargetTabId(server, options.rawTarget, browserSessionId);
	if (options.rawTarget !== undefined && (!Number.isInteger(explicitTabId) || explicitTabId! <= 0)) {
		throw new BrowserBridgeError("INVALID_TAB_ID", "A valid targetRef is required", { targetRef: options.rawTarget });
	}
	if (explicitTabId !== undefined && canonicalOwnerTabId !== undefined && explicitTabId !== canonicalOwnerTabId) {
		throw new BrowserBridgeError("REF_SCOPE_VIOLATION", "Explicit targetRef conflicts with ref ownership", { tabId: explicitTabId, ownerTabId: canonicalOwnerTabId, refs: refs.map((ref) => ref.refId) });
	}
	const tabId = canonicalOwnerTabId ?? explicitTabId;
	const snapshot = server.snapshot({ browserSessionId });
	const effectiveBrowserSessionId = browserSessionId ?? snapshot.browserSessionId;
	const currentTab = snapshot.tabs.find((tab) => tab.tabId === tabId);
	const currentOrigin = urlOrigin(currentTab?.url);
	const currentIdentity = pageIdentityFromUnknown({ ...currentTab, browserSessionId: effectiveBrowserSessionId });
	for (const ref of refs) {
		const scope = classifyRefScope(ref, { browserSessionId: effectiveBrowserSessionId, tabId, topLevelOrigin: currentOrigin });
		if (!scope.ok) throw new BrowserBridgeError(scope.code, `Ref scope violation: ${scope.reason}`, { ref: ref.refId, browserSessionId: effectiveBrowserSessionId, tabId, topLevelOrigin: currentOrigin });
		const reason = pageReanchorReason(ref.pageIdentity, currentIdentity);
		if (reason) throw new BrowserBridgeError("REF_STALE", "Referenced page identity cannot be proven current", { ref: ref.refId, reason, observed: ref.pageIdentity, current: currentIdentity });
	}
	return { browserSessionId: effectiveBrowserSessionId, rawTarget: options.rawTarget === undefined ? tabId : options.rawTarget as string | number, tabId };
}

export function pinTabExecutionTarget(
	server: Pick<BrowserCommandRuntimePort, "snapshot">,
	target: { browserSessionId?: string; rawTarget?: string | number; tabId?: number },
): { browserSessionId?: string; rawTarget?: string | number; tabId?: number } {
	const snapshot = server.snapshot({ browserSessionId: target.browserSessionId });
	const tabId = target.tabId ?? snapshot.defaultTabId ?? snapshot.latestTabId;
	return {
		browserSessionId: target.browserSessionId ?? snapshot.browserSessionId,
		rawTarget: target.rawTarget ?? tabId,
		tabId,
	};
}

export async function runCommandHandler(handler: () => Promise<BrowserTextCommandResult>, onError: (error: unknown) => BrowserTextCommandResult | Promise<BrowserTextCommandResult> = errorResult): Promise<BrowserTextCommandResult> {
	try {
		return await handler();
	} catch (error) {
		return await onError(error);
	}
}

export function bridgeNestedErrorResult(error: unknown, options: { command?: string; defaultMessage: string; includeCommandInDetails?: boolean }): BrowserTextCommandResult {
	const details = error && typeof error === "object" && "details" in error ? (error as { details?: unknown }).details : undefined;
	const detailsRecord = isRecord(details) ? details : undefined;
	const result = detailsRecord?.result;
	if (isRecord(result)) {
		const record = result;
		if (typeof record.error_code === "string" && record.error_code) {
			const resultDetails = isRecord(record.details) ? record.details : {};
			return errorResult(new BrowserBridgeError(normalizeNativeErrorCode(record.error_code), typeof record.error === "string" ? record.error : options.defaultMessage, {
				...(options.includeCommandInDetails && options.command ? { command: options.command } : {}),
				...resultDetails,
			}));
		}
	}
	return errorResult(error);
}

function compactOperationForEnvelope(operation: TrackedOperationInfo): Record<string, unknown> {
	return {
		operationId: operation.operationId,
		commandName: operation.commandName,
		command: operation.command,
		browserSessionId: operation.browserSessionId,
		tabId: operation.tabId,
		phase: operation.phase,
		progress: operation.progress,
		queueDepth: operation.queueDepth,
		leaseOwnerHash: operation.leaseOwnerHash,
		conflictReason: operation.conflictReason,
		snapshotId: operation.snapshotId,
		sourceMode: operation.sourceMode,
		details: operation.details,
		state: operation.state,
		startedAt: operation.startedAt,
		updatedAt: operation.updatedAt,
	};
}

async function emitTrackedProgress(onUpdate: CommandOnUpdate, operation: TrackedOperationInfo, options: { content?: boolean } = {}): Promise<void> {
	if (!onUpdate) return;
	const payload = compactOperationForEnvelope(operation);
	if (options.content === false) {
		await onUpdate({ content: [], details: { progress: payload } });
		return;
	}
	await onUpdate({ content: [{ type: "text", text: stableJson({ progress: payload }) }], details: { progress: payload } });
}

function attachOperationToError(error: unknown, operation: TrackedOperationInfo): unknown {
	const operationDetails = { operation: compactOperationForEnvelope(operation) };
	if (error instanceof BrowserBridgeError) {
		return new BrowserBridgeError(error.code, error.message, { ...error.details, ...operationDetails });
	}
	if (error instanceof Error) {
		const details = isRecord((error as Error & { details?: unknown }).details) ? ((error as Error & { details?: Record<string, unknown> }).details || {}) : {};
		const plain = errorToPlain(error);
		const code = typeof plain.code === "string" && plain.code ? normalizeNativeErrorCode(plain.code) : "INTERNAL_ERROR";
		return new BrowserBridgeError(code, error.message, { ...details, ...operationDetails, causeName: error.name });
	}
	return error;
}

export async function startTrackedOperation(meta: TrackedOperationInput, onUpdate?: CommandOnUpdate): Promise<TrackedOperationHandle> {
	const startedAt = Date.now();
	let current: TrackedOperationInfo = { ...meta, operationId: meta.operationId ?? randomUUID(), state: "active", startedAt, updatedAt: startedAt };
	await emitTrackedProgress(onUpdate, current);
	return {
		get operation() { return current; },
		update: async (patch, options) => {
			current = { ...current, ...patch, operationId: current.operationId, startedAt: current.startedAt, updatedAt: Date.now() };
			await emitTrackedProgress(onUpdate, current, options);
			return current;
		},
		finish: () => (current = { ...current, state: "terminal", updatedAt: Date.now() }),
	};
}

export async function withTrackedOperation<T>(meta: TrackedOperationInput, onUpdate: CommandOnUpdate, run: (handle: TrackedOperationHandle) => Promise<T>): Promise<{ result: T; operation: TrackedOperationInfo }> {
	const handle = await startTrackedOperation(meta, onUpdate);
	let heartbeat: NodeJS.Timeout | undefined;
	try {
		heartbeat = setInterval(() => {
			void handle.update({ details: { heartbeatAt: Date.now() } }, { content: false });
		}, 1_000);
		heartbeat.unref?.();
		const result = await run(handle);
		await handle.update({ phase: "completed", progress: 100 });
		return { result, operation: handle.finish() };
	} catch (error) {
		const failed = await handle.update({ phase: "failed", conflictReason: error instanceof Error ? error.message : String(error) });
		handle.finish();
		throw attachOperationToError(error, failed);
	} finally {
		if (heartbeat) clearInterval(heartbeat);
	}
}
