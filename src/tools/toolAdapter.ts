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
import { fitInlineJsonToBudgetMeasured } from "../distill-core/fit.js";
import { defaultResultBudget, type ToolResultBudgetName } from "./budgets.js";
import { distilledJsonResult, distilledTextResult } from "./resultMiddleware.js";
import { asPositiveInt, DETAIL_LEVEL_DESCRIPTION, MAX_CHARS_DESCRIPTION, optionalTargetRef, optionalTargetTabId, OUTPUT_PATH_DESCRIPTION } from "./toolShared.js";
import type { MemoryAugmentationPlan } from "../memory-core/types.js";

// Mandatory-read pair with resultMiddleware.ts: this file normalizes params/operation/errors,
// while resultMiddleware.ts shapes the returned envelope, budgets, redaction, and artifacts.
export { fitInlineJsonToBudget } from "../distill-core/fit.js";

export type ToolResultContext = { cwd?: string; hasUI?: boolean; omitTransportDetails?: boolean } | undefined;

export type StandardToolParams = {
	browserSessionId?: string;
	tabId?: number | string;
	targetRef?: string;
	detailLevel?: string;
	outputPath?: string;
	timeoutMs?: number;
	maxChars?: number;
	redact?: boolean;
};

type SharedToolParamOptions = {
	tabIdDescription?: string;
	targetRefDescription?: string;
	timeoutDescription?: string;
	outputPathDescription?: string;
	maxCharsDescription?: string;
	includeBrowserSessionId?: boolean;
	includeTabId?: boolean;
	includeTargetRef?: boolean;
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
	diagnostics?: Record<string, unknown>;
	artifactValue?: unknown;
	distill?: DistillFn;
	artifactThreshold?: number;
	maxChars?: number;
	memoryAugmentationPlan?: MemoryAugmentationPlan;
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
	diagnostics?: Record<string, unknown>;
	artifactValue?: unknown;
	entities?: Array<Record<string, unknown>>;
	summary?: Record<string, unknown>;
	distill?: TextDistillFn;
	artifactThreshold?: number;
	maxChars?: number;
	granularityCeiling?: Exclude<FactGranularity, "omit">;
	stableRefs?: Set<string>;
	onAllocation?: (allocation: { budgetUsedRatio: number; omittedCount: number }) => void;
	memoryAugmentationPlan?: MemoryAugmentationPlan;
};

export type ToolOnUpdate = ((result: PiTextToolResult) => void | Promise<void>) | undefined;

export type TrackedOperationHandle = {
	operation: BrowserActiveOperationInfo;
	update: (patch: Partial<Omit<BrowserActiveOperationInfo, "operationId" | "startedAt">>, options?: { content?: boolean }) => Promise<BrowserActiveOperationInfo | undefined>;
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
	if (options.includeBrowserSessionId === true) params.browserSessionId = Type.Optional(Type.String({ description: "Deprecated compatibility only; stripped before tool validation. Browser-session routing defaults to the selected session." }));
	if (options.includeTabId !== false) params.tabId = optionalTargetTabId(options.tabIdDescription);
	if (options.includeTargetRef !== false) params.targetRef = optionalTargetRef(options.targetRefDescription);
	if (options.includeDetailLevel === true) params.detailLevel = Type.Optional(Type.String({ description: DETAIL_LEVEL_DESCRIPTION }));
	if (options.includeOutputPath === true) params.outputPath = Type.Optional(Type.String({ description: options.outputPathDescription ?? OUTPUT_PATH_DESCRIPTION }));
	if (options.includeTimeout === true) params.timeoutMs = Type.Optional(Type.Number({ description: options.timeoutDescription ?? "Deprecated compatibility only; stripped before tool validation. Tools use their built-in timeout contracts." }));
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

export function targetTabId(params: Pick<StandardToolParams, "tabId" | "targetRef">, body?: Record<string, unknown>): unknown {
	return params.targetRef ?? params.tabId ?? body?.targetRef ?? body?.tabHandle ?? body?.tabId;
}

export function resolveLocalTargetTabId(server: Partial<Pick<BrowserBridgeServer, "resolveTargetTabId">>, value: unknown, browserSessionId?: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof server.resolveTargetTabId === "function") return server.resolveTargetTabId(value, browserSessionId);
	return normalizeTabId(value);
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
		diagnostics: options.diagnostics,
		artifactValue: options.artifactValue,
		distill: options.distill,
		artifactThreshold: options.artifactThreshold,
		memoryAugmentationPlan: options.memoryAugmentationPlan,
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
		diagnostics: options.diagnostics,
		artifactValue: options.artifactValue,
		entities: options.entities,
		summary: options.summary,
		distill: options.distill,
		artifactThreshold: options.artifactThreshold,
		granularityCeiling: options.granularityCeiling,
		stableRefs: options.stableRefs,
		onAllocation: options.onAllocation,
		memoryAugmentationPlan: options.memoryAugmentationPlan,
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
		details: operation.details,
		startedAt: operation.startedAt,
		updatedAt: operation.updatedAt,
	};
}

async function emitTrackedProgress(onUpdate: ToolOnUpdate, operation: BrowserActiveOperationInfo, options: { content?: boolean } = {}): Promise<void> {
	if (!onUpdate) return;
	const payload = compactOperationForEnvelope(operation);
	if (options.content === false) {
		await onUpdate({ details: { progress: payload } } as unknown as PiTextToolResult);
		return;
	}
	await onUpdate({ content: [{ type: "text", text: stableJson({ progress: payload }) }], details: { progress: payload } });
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
		update: async (patch, options) => {
			const next = server.updateOperation(current.operationId, patch);
			if (next) {
				current = next;
				await emitTrackedProgress(onUpdate, next, options);
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
			void handle.update({ details: { heartbeatAt: Date.now() } }, { content: false });
		}, 1_000);
		heartbeat.unref?.();
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
		const tabId = resolveLocalTargetTabId(server, rawTabId, browserSessionId);
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
			tabId: (params) => targetTabId(params),
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
