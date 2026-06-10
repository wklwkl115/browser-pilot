import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BrowserBridgeServer } from "../driver/BrowserBridgeServer.js";
import type { BrowserActiveOperationInfo } from "../driver/types.js";
import type { FactGranularity } from "../distill-core/fact.js";
import { BrowserBridgeError, errorToPlain } from "../driver/errors.js";
import { normalizeNativeErrorCode } from "../protocol/nativeErrorCodes.js";
import type { DetailLevel } from "../utils/params.js";
import { normalizeTabId } from "../utils/params.js";
import { isRecord } from "../utils/records.js";
import { errorResult, jsonResult, type PiTextToolResult } from "../utils/toolResult.js";
import { stableJson } from "../utils/json.js";
import { defaultResultBudget, type ToolResultBudgetName } from "./budgets.js";
import { distilledJsonResult, distilledTextResult } from "./resultMiddleware.js";
import { asPositiveInt, DETAIL_LEVEL_DESCRIPTION, MAX_CHARS_DESCRIPTION, optionalTargetTabId, OUTPUT_PATH_DESCRIPTION } from "./toolShared.js";

export type ToolResultContext = { cwd?: string; hasUI?: boolean; omitTransportDetails?: boolean } | undefined;

export type StandardToolParams = {
	browserSessionId?: string;
	tabId?: number | string;
	detailLevel?: string;
	outputPath?: string;
	timeoutMs?: number;
	maxChars?: number;
	redact?: boolean;
};

type SharedToolParamOptions = {
	tabIdDescription?: string;
	timeoutDescription?: string;
	outputPathDescription?: string;
	maxCharsDescription?: string;
	includeBrowserSessionId?: boolean;
	includeTabId?: boolean;
	includeDetailLevel?: boolean;
	includeOutputPath?: boolean;
	includeTimeout?: boolean;
	includeMaxChars?: boolean;
	includeRedact?: boolean;
};

type DistillFn = (value: unknown) => Record<string, unknown>;
type TextDistillFn = (text: string) => Record<string, unknown>;

type JsonToolResultOptions = {
	toolName: ToolResultBudgetName | string;
	budgetName?: ToolResultBudgetName;
	command?: string;
	browserSessionId?: string;
	defaultDetailLevel?: DetailLevel;
	fallbackName: string;
	details?: Record<string, unknown>;
	operation?: Record<string, unknown>;
	snapshot?: Record<string, unknown>;
	artifactValue?: unknown;
	distill?: DistillFn;
	artifactThreshold?: number;
	maxChars?: number;
};

type TextToolResultOptions = {
	toolName: ToolResultBudgetName | string;
	budgetName?: ToolResultBudgetName;
	command?: string;
	browserSessionId?: string;
	defaultDetailLevel?: DetailLevel;
	fallbackName: string;
	details?: Record<string, unknown>;
	operation?: Record<string, unknown>;
	snapshot?: Record<string, unknown>;
	artifactValue?: unknown;
	entities?: Array<Record<string, unknown>>;
	summary?: Record<string, unknown>;
	distill?: TextDistillFn;
	artifactThreshold?: number;
	maxChars?: number;
	granularityCeiling?: Exclude<FactGranularity, "omit">;
	onAllocation?: (allocation: { budgetUsedRatio: number; omittedCount: number }) => void;
};

export type ToolOnUpdate = ((result: PiTextToolResult) => void | Promise<void>) | undefined;

export type TrackedOperationHandle = {
	operation: BrowserActiveOperationInfo;
	update: (patch: Partial<Omit<BrowserActiveOperationInfo, "operationId" | "startedAt">>) => Promise<BrowserActiveOperationInfo | undefined>;
	finish: () => BrowserActiveOperationInfo | undefined;
};

type BrowserToolOperationResolver<TParams, TPrepared, TValue> = TValue | ((params: TParams, prepared: TPrepared) => TValue);

type BrowserToolOperationConfig<TParams, TPrepared> = false | {
	command: BrowserToolOperationResolver<TParams, TPrepared, string>;
	tabId?: (params: TParams, prepared: TPrepared) => unknown;
	initialProgress?: number;
	phase?: BrowserActiveOperationInfo["phase"];
	sourceMode?: BrowserToolOperationResolver<TParams, TPrepared, string | undefined>;
	snapshotId?: BrowserToolOperationResolver<TParams, TPrepared, string | undefined>;
};

type BrowserToolErrorConfig<TParams> = {
	map?: (error: unknown, params: TParams) => unknown;
	result?: (error: unknown) => PiTextToolResult;
};

export type BrowserToolRunArgs<TParams, TPrepared> = {
	server: BrowserBridgeServer;
	params: TParams;
	prepared: TPrepared;
	ctx: ToolResultContext;
	onUpdate: ToolOnUpdate;
	timeoutMs: number;
	maxChars: number;
	browserSessionId?: string;
	rawTabId: unknown;
	tabId?: number;
	handle?: TrackedOperationHandle;
};

type RunBrowserToolSpec<TParams extends Partial<StandardToolParams>, TPrepared extends TParams = TParams, TResult = unknown> = {
	ensureStarted: () => Promise<BrowserBridgeServer>;
	toolName: string;
	params: TParams;
	ctx: ToolResultContext;
	onUpdate?: ToolOnUpdate;
	budgetName?: ToolResultBudgetName;
	defaultTimeoutMs: number;
	fallbackMaxChars?: number;
	prepare?: (args: Omit<BrowserToolRunArgs<TParams, TPrepared>, "prepared" | "rawTabId" | "tabId" | "handle">) => Promise<TPrepared> | TPrepared;
	operation?: BrowserToolOperationConfig<TParams, TPrepared>;
	error?: BrowserToolErrorConfig<TParams>;
	run: (args: BrowserToolRunArgs<TParams, TPrepared>) => Promise<TResult>;
	finalize: (args: BrowserToolRunArgs<TParams, TPrepared> & { result: TResult; operation?: BrowserActiveOperationInfo }) => Promise<PiTextToolResult>;
};

type RunWebSecurityToolSpec<TParams extends StandardToolParams, TRunParams extends TParams, TResult> = {
	ensureStarted: () => Promise<BrowserBridgeServer>;
	params: TParams;
	ctx: ToolResultContext;
	onUpdate?: ToolOnUpdate;
	toolName: ToolResultBudgetName;
	command: string;
	fallbackPrefix: string;
	defaultMaxBodyBytes?: number;
	defaultTimeoutMs?: number;
	includeTimeout?: boolean;
	includeCookieProvider?: boolean;
	augmentParams?: (params: TParams) => Partial<TRunParams>;
	createCookieProvider?: (params: TParams, timeoutMs: number) => unknown;
	run: (params: TRunParams) => Promise<TResult>;
	details: (result: TResult) => Record<string, unknown>;
	distill: (result: TResult) => Record<string, unknown>;
	error?: BrowserToolErrorConfig<TParams>;
};

export function defineBrowserTool(pi: ExtensionAPI, spec: Parameters<ExtensionAPI["registerTool"]>[0]) {
	pi.registerTool(spec);
	return spec;
}

export function maxCharsParam(description = MAX_CHARS_DESCRIPTION) {
	return Type.Optional(Type.Number({ description }));
}

export function sharedTabScopedToolParams(options: SharedToolParamOptions = {}) {
	const params: Record<string, unknown> = {};
	if (options.includeBrowserSessionId === true) params.browserSessionId = Type.Optional(Type.String({ description: "Advanced: browser session id used for scoped browser state/routing. Ordinary agents should omit this; runtime defaults to the default session." }));
	if (options.includeTabId !== false) params.tabId = optionalTargetTabId(options.tabIdDescription);
	if (options.includeDetailLevel === true) params.detailLevel = Type.Optional(Type.String({ description: DETAIL_LEVEL_DESCRIPTION }));
	if (options.includeOutputPath === true) params.outputPath = Type.Optional(Type.String({ description: options.outputPathDescription ?? OUTPUT_PATH_DESCRIPTION }));
	if (options.includeTimeout === true) params.timeoutMs = Type.Optional(Type.Number({ description: options.timeoutDescription ?? "Bridge timeout in milliseconds" }));
	if (options.includeMaxChars === true) params.maxChars = Type.Optional(Type.Number({ description: options.maxCharsDescription ?? MAX_CHARS_DESCRIPTION }));
	if (options.includeRedact === true) params.redact = Type.Optional(Type.Boolean({ description: "Deprecated compatibility only; model-facing output is redacted by default and targeted raw reads use browser_artifact jsonPath/pick." }));
	return params;
}

export function toolMaxChars(params: Pick<StandardToolParams, "maxChars">, budgetName: ToolResultBudgetName): number {
	return asPositiveInt(params.maxChars, defaultResultBudget(budgetName));
}

export function toolPositiveInt(value: unknown, fallback: number): number {
	return asPositiveInt(value, fallback);
}

export function toolTimeoutMs(value: unknown, fallback: number, options: { allowZero?: boolean } = {}): number {
	const n = Number(value);
	if (options.allowZero && Number.isFinite(n) && n === 0) return 0;
	return asPositiveInt(value, fallback);
}

export function artifactFallbackName(prefix: string, extension = "json"): string {
	return `${prefix}-${Date.now()}.${extension}`;
}

export function applyDefaultTimeout(body: Record<string, unknown>, timeoutMs: number): void {
	if (body.timeoutMs === undefined && body.timeout_ms === undefined) body.timeoutMs = timeoutMs;
}

export function targetTabId(params: Pick<StandardToolParams, "tabId">, body?: Record<string, unknown>): unknown {
	return params.tabId ?? body?.tabId;
}

export async function runTool(handler: () => Promise<PiTextToolResult>, onError: (error: unknown) => PiTextToolResult | Promise<PiTextToolResult> = errorResult): Promise<PiTextToolResult> {
	try {
		return await handler();
	} catch (error) {
		return await onError(error);
	}
}

export function bridgeNestedErrorResult(error: unknown, options: { command?: string; defaultMessage: string; includeCommandInDetails?: boolean }): PiTextToolResult {
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

/**
 * Structurally shrink an inline json read result so it serializes within budget as VALID JSON.
 *
 * The artifact json read builds a compacted, windowable value (an `{type:"array", items, …}`
 * window or a key-bounded object), but a large window can still serialize past the budget. The
 * old path then ran the serialized JSON through the TEXT head/tail truncator, which cut mid-token
 * and inserted a raw `[truncated …]` marker — producing UNPARSEABLE JSON for the exact read the
 * tool's own `nextActions` suggest (`mode=json jsonPath=data.items`). Instead, reduce the windowed
 * array items / object keys (preserving `nextOffset`/`truncatedKeys` so the agent can page) until
 * the result fits; callers floor the serialize budget at the fitted size so the truncator never
 * cuts a structurally-minimal value. Small reads (already within budget) are returned untouched.
 */
type FittedInlineJson = { value: unknown; length: number };

function fitInlineJsonToBudgetMeasured(result: unknown, maxChars: number): FittedInlineJson {
	const initialLength = stableJson(result).length;
	if (!isRecord(result) || initialLength <= maxChars) return { value: result, length: initialLength };
	const payload = result.value;
	if (isRecord(payload) && payload.type === "array" && Array.isArray(payload.items) && payload.items.length > 1) {
		const original = payload.items.slice();
		const offset = Number(payload.offset ?? 0);
		const count = Number(payload.count ?? original.length);
		const applyArray = (n: number) => {
			payload.items = original.slice(0, n);
			payload.limit = n;
			payload.nextOffset = offset + n < count ? offset + n : null;
			payload.budgetTrimmed = n < original.length;
		};
		// Largest prefix length that still fits (binary search → optimal window, not a coarse step).
		let lo = 1, hi = original.length, best = 1;
		let bestLength = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			applyArray(mid);
			const length = stableJson(result).length;
			if (length <= maxChars) { best = mid; bestLength = length; lo = mid + 1; } else hi = mid - 1;
		}
		applyArray(best);
		if (bestLength < 0) bestLength = stableJson(result).length;
		return { value: result, length: bestLength };
	}
	if (isRecord(payload) && payload.type !== "array") {
		const keys = Object.keys(payload).filter((k) => k !== "truncatedKeys");
		if (keys.length <= 1) return { value: result, length: initialLength };
		const applyKeys = (k: number) => {
			const reduced: Record<string, unknown> = {};
			for (const key of keys.slice(0, k)) reduced[key] = payload[key];
			if (k < keys.length) reduced.truncatedKeys = keys.length - k;
			result.value = reduced;
		};
		let lo = 1, hi = keys.length, best = 1;
		let bestLength = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			applyKeys(mid);
			const length = stableJson(result).length;
			if (length <= maxChars) { best = mid; bestLength = length; lo = mid + 1; } else hi = mid - 1;
		}
		applyKeys(best);
		if (bestLength < 0) bestLength = stableJson(result).length;
		return { value: result, length: bestLength };
	}
	return { value: result, length: initialLength };
}

export function fitInlineJsonToBudget(result: unknown, maxChars: number): unknown {
	return fitInlineJsonToBudgetMeasured(result, maxChars).value;
}

export function inlineJsonToolResult(value: unknown, details: Record<string, unknown>, params: Pick<StandardToolParams, "maxChars">, budgetName: ToolResultBudgetName): PiTextToolResult {
	const maxChars = toolMaxChars(params, budgetName);
	const fitted = fitInlineJsonToBudgetMeasured(value, maxChars);
	// Floor the serialize budget at the fitted size: a structurally-minimal value (e.g. a single
	// large item) must still emit as VALID JSON rather than be text-truncated mid-token.
	const serializeBudget = Math.max(maxChars, fitted.length);
	return jsonResult(fitted.value, details, serializeBudget);
}

export async function jsonToolResult(value: unknown, params: Pick<StandardToolParams, "browserSessionId" | "detailLevel" | "outputPath" | "maxChars" | "redact">, ctx: ToolResultContext, options: JsonToolResultOptions): Promise<PiTextToolResult> {
	const budgetName = options.budgetName ?? (options.toolName as ToolResultBudgetName);
	return await distilledJsonResult(value, {
		toolName: String(options.toolName),
		command: options.command,
		browserSessionId: options.browserSessionId ?? params.browserSessionId,
		detailLevel: params.detailLevel ?? options.defaultDetailLevel,
		maxChars: options.maxChars ?? toolMaxChars(params, budgetName),
		ctx,
		outputPath: params.outputPath,
		fallbackName: options.fallbackName,
		details: options.details,
		operation: options.operation,
		snapshot: options.snapshot,
		artifactValue: options.artifactValue,
		distill: options.distill,
		artifactThreshold: options.artifactThreshold,
		redact: params.redact,
	});
}

export async function textToolResult(text: string, params: Pick<StandardToolParams, "browserSessionId" | "detailLevel" | "outputPath" | "maxChars" | "redact">, ctx: ToolResultContext, options: TextToolResultOptions): Promise<PiTextToolResult> {
	const budgetName = options.budgetName ?? (options.toolName as ToolResultBudgetName);
	return await distilledTextResult(text, {
		toolName: String(options.toolName),
		command: options.command,
		browserSessionId: options.browserSessionId ?? params.browserSessionId,
		detailLevel: params.detailLevel ?? options.defaultDetailLevel,
		maxChars: options.maxChars ?? toolMaxChars(params, budgetName),
		ctx,
		outputPath: params.outputPath,
		fallbackName: options.fallbackName,
		details: options.details,
		operation: options.operation,
		snapshot: options.snapshot,
		artifactValue: options.artifactValue,
		entities: options.entities,
		summary: options.summary,
		distill: options.distill,
		artifactThreshold: options.artifactThreshold,
		granularityCeiling: options.granularityCeiling,
		onAllocation: options.onAllocation,
		redact: params.redact,
	});
}

function compactOperationForEnvelope(operation: BrowserActiveOperationInfo): Record<string, unknown> {
	return {
		operationId: operation.operationId,
		toolName: operation.toolName,
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
		startedAt: operation.startedAt,
		updatedAt: operation.updatedAt,
	};
}

async function emitTrackedProgress(onUpdate: ToolOnUpdate, operation: BrowserActiveOperationInfo): Promise<void> {
	if (!onUpdate) return;
	const payload = compactOperationForEnvelope(operation);
	await onUpdate({
		content: [{ type: "text", text: stableJson({ progress: payload }) }],
		details: { progress: payload },
	});
}

function attachOperationToError(error: unknown, operation: BrowserActiveOperationInfo): unknown {
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

export async function startTrackedOperation(server: BrowserBridgeServer, meta: Omit<BrowserActiveOperationInfo, "operationId" | "startedAt" | "updatedAt">, onUpdate?: ToolOnUpdate): Promise<TrackedOperationHandle> {
	let current = server.beginOperation(meta);
	await emitTrackedProgress(onUpdate, current);
	return {
		get operation() { return current; },
		update: async (patch) => {
			const next = server.updateOperation(current.operationId, patch);
			if (next) {
				current = next;
				await emitTrackedProgress(onUpdate, next);
			}
			return next;
		},
		finish: () => server.finishOperation(current.operationId),
	};
}

export async function withTrackedOperation<T>(server: BrowserBridgeServer, meta: Omit<BrowserActiveOperationInfo, "operationId" | "startedAt" | "updatedAt">, onUpdate: ToolOnUpdate, run: (handle: TrackedOperationHandle) => Promise<T>): Promise<{ result: T; operation: BrowserActiveOperationInfo }> {
	const handle = await startTrackedOperation(server, meta, onUpdate);
	let heartbeat: NodeJS.Timeout | undefined;
	try {
		heartbeat = setInterval(() => {
			void handle.update({ details: { heartbeatAt: Date.now() } });
		}, 1_000);
		const result = await run(handle);
		const completed = await handle.update({ phase: "completed", progress: 100 });
		const finalOperation = handle.finish() || completed || handle.operation;
		return { result, operation: finalOperation };
	} catch (error) {
		const failed = await handle.update({ phase: "failed", conflictReason: error instanceof Error ? error.message : String(error) });
		handle.finish();
		throw attachOperationToError(error, failed || handle.operation);
	} finally {
		if (heartbeat) clearInterval(heartbeat);
	}
}

function budgetedMaxChars<TParams extends Partial<StandardToolParams>>(params: TParams, budgetName: ToolResultBudgetName | undefined, fallbackMaxChars: number | undefined): number {
	if (budgetName) return toolMaxChars(params as Pick<StandardToolParams, "maxChars">, budgetName);
	return toolPositiveInt((params as { maxChars?: unknown }).maxChars, fallbackMaxChars ?? 50_000);
}

function resolveOperationValue<TParams, TPrepared, TValue>(value: BrowserToolOperationResolver<TParams, TPrepared, TValue> | undefined, params: TParams, prepared: TPrepared): TValue | undefined {
	if (typeof value === "function") return (value as (params: TParams, prepared: TPrepared) => TValue)(params, prepared);
	return value;
}

export async function runBrowserTool<TParams extends Partial<StandardToolParams>, TPrepared extends TParams = TParams, TResult = unknown>(spec: RunBrowserToolSpec<TParams, TPrepared, TResult>): Promise<PiTextToolResult> {
	const onError = (error: unknown) => {
		const mapped = spec.error?.map ? spec.error.map(error, spec.params) : error;
		return spec.error?.result ? spec.error.result(mapped) : errorResult(mapped);
	};
	return await runTool(async () => {
		const server = await spec.ensureStarted();
		const timeoutMs = toolTimeoutMs((spec.params as { timeoutMs?: unknown }).timeoutMs, spec.defaultTimeoutMs);
		const maxChars = budgetedMaxChars(spec.params, spec.budgetName, spec.fallbackMaxChars);
		const browserSessionId = typeof (spec.params as { browserSessionId?: unknown }).browserSessionId === "string"
			? (spec.params as { browserSessionId?: string }).browserSessionId
			: undefined;
		const baseArgs = {
			server,
			params: spec.params,
			ctx: spec.ctx,
			onUpdate: spec.onUpdate,
			timeoutMs,
			maxChars,
			browserSessionId,
		} as Omit<BrowserToolRunArgs<TParams, TPrepared>, "prepared" | "rawTabId" | "tabId" | "handle">;
		const prepared = spec.prepare ? await spec.prepare(baseArgs) : (spec.params as TPrepared);
		if (!spec.operation) {
			const runArgs: BrowserToolRunArgs<TParams, TPrepared> = { ...baseArgs, prepared, rawTabId: undefined, tabId: undefined, handle: undefined };
			const result = await spec.run(runArgs);
			return await spec.finalize({ ...runArgs, result, operation: undefined });
		}
		const rawTabId = spec.operation.tabId?.(spec.params, prepared);
		const tabId = normalizeTabId(rawTabId);
		const command = resolveOperationValue(spec.operation.command, spec.params, prepared) || spec.toolName;
		const sourceMode = resolveOperationValue(spec.operation.sourceMode, spec.params, prepared);
		const snapshotId = resolveOperationValue(spec.operation.snapshotId, spec.params, prepared);
		const { result, operation } = await withTrackedOperation(server, {
			toolName: spec.toolName,
			command,
			browserSessionId,
			tabId,
			phase: spec.operation.phase ?? "running",
			progress: spec.operation.initialProgress ?? 10,
			queueDepth: server.queueDepth(browserSessionId, tabId),
			leaseOwnerHash: server.leaseOwnerHash(browserSessionId, tabId),
			...(sourceMode ? { sourceMode } : {}),
			...(snapshotId ? { snapshotId } : {}),
		}, spec.onUpdate, async (handle) => await spec.run({ ...baseArgs, prepared, rawTabId, tabId, handle }));
		return await spec.finalize({ ...baseArgs, prepared, rawTabId, tabId, result, operation });
	}, onError);
}

export async function runWebSecurityTool<TParams extends StandardToolParams & { maxBodyBytes?: unknown }, TRunParams extends TParams, TResult>(spec: RunWebSecurityToolSpec<TParams, TRunParams, TResult>): Promise<PiTextToolResult> {
	return await runBrowserTool<TParams, TRunParams, TResult>({
		ensureStarted: spec.ensureStarted,
		toolName: spec.toolName,
		budgetName: spec.toolName,
		params: spec.params,
		ctx: spec.ctx,
		onUpdate: spec.onUpdate,
		defaultTimeoutMs: spec.defaultTimeoutMs ?? 15_000,
		operation: {
			command: spec.command,
			tabId: (params) => params.tabId,
			initialProgress: 5,
		},
		error: spec.error,
		prepare: ({ params, timeoutMs, ctx }) => {
			const runParams: Record<string, unknown> = {
				...params,
				...(spec.augmentParams?.(params) || {}),
			};
			if (spec.includeTimeout !== false) runParams.timeoutMs = timeoutMs;
			if (spec.defaultMaxBodyBytes !== undefined) runParams.maxBodyBytes = toolPositiveInt(params.maxBodyBytes, spec.defaultMaxBodyBytes);
			if (spec.includeCookieProvider && spec.createCookieProvider) runParams.cookieProvider = spec.createCookieProvider(params, timeoutMs);
			// Propagate the caller cwd so request-scoped paths (nuclei/sqlmap/crawl/oast
			// artifact + session roots) resolve under the caller's .pi/, not the daemon's.
			if (ctx?.cwd) runParams.cwd = ctx.cwd;
			return runParams as TRunParams;
		},
		run: async ({ prepared, handle }) => {
			await handle?.update({ progress: 35 });
			const result = await spec.run(prepared);
			await handle?.update({ progress: 85, details: spec.details(result) });
			return result;
		},
		finalize: async ({ params, ctx, maxChars, operation, result }) => {
			const resultDetails = spec.details(result);
			return await jsonToolResult(result, params, ctx, {
				toolName: spec.toolName,
				command: spec.command,
				maxChars,
				fallbackName: artifactFallbackName(spec.fallbackPrefix),
				details: { command: spec.command, ...resultDetails },
				operation,
				artifactValue: { ...(result as Record<string, unknown>), ...(operation ? { operation } : {}) },
				distill: (value: unknown) => ({ ...spec.distill(value as TResult), ...(operation ? { operationId: operation.operationId, sourceMode: operation.sourceMode } : {}) }),
			});
		},
	});
}
