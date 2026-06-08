/**
 * Protocol middleware (hook-style, FastMCP-inspired naming).
 *
 * Cross-cutting protocol concerns in a fixed order:
 *   auth/profile → raw argument validation → handle resolution → tool execute → result presentation → logging
 *
 * Hook interface is intentionally minimal — each hook receives a context and
 * may return early with an error result. Hooks run synchronously in order;
 * async hooks are awaited. Order is fixed: earlier hooks cannot be reordered by
 * callers.
 *
 * Middleware does NOT:
 * - Auto-select targets or chain tools
 * - Override tool semantics
 * - Bypass validation or security guards in tool implementations
 */

export type MiddlewareContext = {
	method: string;
	toolName?: string;
	startedAt: number;
	/** Raw tool args, captured for opt-in usage logging (redacted at log time). */
	args?: unknown;
	/** CLI-facing route metadata for opt-in usage logging; never affects execution semantics. */
	cli?: unknown;
	/** Serialized result size in bytes, for opt-in usage logging. */
	resultBytes?: number;
};

export type MiddlewareResult =
	| { pass: true }
	| { pass: false; error: string; code: string };

export type MiddlewareHook = (ctx: MiddlewareContext, params: unknown) => Promise<MiddlewareResult> | MiddlewareResult;

export type LoggingHook = (ctx: MiddlewareContext, durationMs: number, result: "ok" | "error", details?: Record<string, unknown>) => void;

type HookRegistry = {
	on_initialize: MiddlewareHook[];
	on_list_tools: MiddlewareHook[];
	on_call_tool: MiddlewareHook[];
	on_list_prompts: MiddlewareHook[];
	on_get_prompt: MiddlewareHook[];
	on_read_resource: MiddlewareHook[];
	on_message: MiddlewareHook[];
	on_log: LoggingHook[];
};

const hooks: HookRegistry = {
	on_initialize: [],
	on_list_tools: [],
	on_call_tool: [],
	on_list_prompts: [],
	on_get_prompt: [],
	on_read_resource: [],
	on_message: [],
	on_log: [],
};

type HookName = keyof HookRegistry;

/**
 * Register a middleware hook. Hooks are invoked in registration order.
 * on_log is a special logging hook that receives timing/result info.
 */
export function registerHook(name: "on_log", hook: LoggingHook): void;
export function registerHook(name: Exclude<HookName, "on_log">, hook: MiddlewareHook): void;
export function registerHook(name: HookName, hook: MiddlewareHook | LoggingHook): void {
	if (name === "on_log") (hooks.on_log as LoggingHook[]).push(hook as LoggingHook);
	else (hooks[name as Exclude<HookName, "on_log">] as MiddlewareHook[]).push(hook as MiddlewareHook);
}

/**
 * Run all registered hooks for a given lifecycle point.
 * Returns the first failing hook result, or {pass:true} if all pass.
 */
export async function runHooks(
	name: Exclude<HookName, "on_log">,
	ctx: MiddlewareContext,
	params: unknown,
): Promise<MiddlewareResult> {
	for (const hook of hooks[name] as MiddlewareHook[]) {
		const result = await hook(ctx, params);
		if (!result.pass) return result;
	}
	return { pass: true };
}

/**
 * Emit a log event to all registered on_log hooks.
 */
export function emitLog(ctx: MiddlewareContext, durationMs: number, result: "ok" | "error", details?: Record<string, unknown>): void {
	for (const hook of hooks.on_log) hook(ctx, durationMs, result, details);
}

/**
 * Clear all registered hooks (for testing / shutdown).
 */
export function clearHooks(): void {
	for (const name of Object.keys(hooks) as HookName[]) {
		if (name === "on_log") hooks.on_log.length = 0;
		else (hooks[name as Exclude<HookName, "on_log">] as MiddlewareHook[]).length = 0;
	}
}

// ─── Built-in hooks ──────────────────────────────────────────────────────────

/** Built-in timing+logging hook. Registered by default. */
export const timingLogHook: LoggingHook = (ctx, durationMs, result, details) => {
	const detail = details ? ` ${JSON.stringify(details)}` : "";
	console.error(`[pi-browser] ${ctx.method}${ctx.toolName ? ` ${ctx.toolName}` : ""} ${result} +${durationMs}ms${detail}`);
};
