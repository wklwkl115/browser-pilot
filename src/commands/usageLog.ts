/**
 * Temporary development usage logger.
 *
 * Persists one JSON line per command call so we can study how real agents
 * actually drive the tools (which tools, what params, success/error, latency)
 * and improve the project. It hangs off the existing `on_log` middleware hook —
 * NOT the tool-call hot path — so it cannot change command behavior, and every
 * write is best-effort (a logging failure never breaks a command call).
 *
 * Opt-in via env (off by default):
 *   BROWSER_PILOT_USAGE_LOG=1                  -> .browser-pilot/usage/usage-YYYYMMDD.jsonl
 *   BROWSER_PILOT_USAGE_LOG=/abs/path.jsonl    -> that file
 *   BROWSER_PILOT_USAGE_LOG_RAW=1              -> log unredacted args (default: redacted)
 *
 * Args are redacted with the shared redaction util by default — the structural
 * signal (tool, mode, selector, target, param shape) is preserved while
 * cookies/tokens/passwords are stripped before they ever touch disk.
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { LoggingHook, MiddlewareContext } from "./middleware.js";
import { redactSensitiveValue } from "../utils/redaction.js";

export type UsageLogOptions = {
	enabled: boolean;
	filePath: string;
	raw: boolean;
	sessionId: string;
	runId?: string;
};

function looksLikePath(value: string): boolean {
	return /[\\/]/.test(value) || value.toLowerCase().endsWith(".jsonl");
}

function defaultLogPath(cwd: string, stamp: string): string {
	return path.resolve(cwd, ".browser-pilot", "usage", `usage-${stamp}.jsonl`);
}

export function resolveUsageLogOptions(
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
	now: Date = new Date(),
	pid: number = process.pid,
): UsageLogOptions {
	const raw = (env["BROWSER_PILOT_USAGE_LOG"] || "").trim();
	const enabled = raw !== "" && raw !== "0" && raw.toLowerCase() !== "false";
	const iso = now.toISOString();
	const stamp = iso.slice(0, 10).replace(/-/g, "");
	const filePath = enabled
		? looksLikePath(raw) ? path.resolve(cwd, raw) : defaultLogPath(cwd, stamp)
		: "";
	return {
		enabled,
		filePath,
		raw: env["BROWSER_PILOT_USAGE_LOG_RAW"] === "1",
		sessionId: `${iso.replace(/[:.]/g, "-")}-${pid}`,
		runId: env["BROWSER_PILOT_USAGE_RUN_ID"]?.trim() || undefined,
	};
}

export function buildUsageRecord(
	options: UsageLogOptions,
	ctx: MiddlewareContext,
	durationMs: number,
	result: "ok" | "error",
	details: Record<string, unknown> | undefined,
	nowIso: string,
): Record<string, unknown> {
	const record: Record<string, unknown> = {
		ts: nowIso,
		session: options.sessionId,
		method: ctx.method,
		result,
		ms: durationMs,
	};
	if (options.runId) record.runId = options.runId;
	if (ctx.commandName) record.tool = ctx.commandName;
	if (ctx.args !== undefined) record.args = options.raw ? ctx.args : redactSensitiveValue(ctx.args);
	if (typeof ctx.resultBytes === "number") record.bytes = ctx.resultBytes;
	if (details && Object.keys(details).length > 0) {
		record.details = options.raw ? details : (redactSensitiveValue(details) as Record<string, unknown>);
	}
	return record;
}

const ensuredDirs = new Set<string>();

/** Append one JSON line. Best-effort: never throws (logging must not break a command call). */
export async function appendUsageRecord(filePath: string, record: Record<string, unknown>): Promise<void> {
	const dir = path.dirname(filePath);
	try {
		if (!ensuredDirs.has(dir)) {
			await mkdir(dir, { recursive: true });
			ensuredDirs.add(dir);
		}
		await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
	} catch {
		/* best-effort: usage logging must never break a command call */
	}
}

export function createUsageLogHook(options: UsageLogOptions): LoggingHook {
	return (ctx, durationMs, result, details) => {
		void appendUsageRecord(options.filePath, buildUsageRecord(options, ctx, durationMs, result, details, new Date().toISOString()));
	};
}
