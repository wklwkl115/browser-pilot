import { Type } from "typebox";
import { BrowserBridgeError } from "../utils/errors.js";
import { buildPickCleanupScript, buildPickScript } from "../pick/buildPickScript.js";
import { summarizePickData } from "./summaries/index.js";
import { artifactFallbackName, defineBrowserCommand, jsonCommandResult, runCommandHandler, sharedTabScopedToolParams, targetTabId, commandMaxChars, commandTimeoutMs } from "./commandRuntime.js";
import { TAB_SCOPED_TOOL_GUIDELINE, strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";
import { isRecord } from "../utils/params.js";

function unwrapRuntimeEvaluateValue(result: unknown): unknown {
	if (!isRecord(result)) return result;
	const data = isRecord(result.data) ? result.data : result;
	if (data.exceptionDetails) throw new BrowserBridgeError("BROWSER_EXECUTION_ERROR", `browser_pick Runtime.evaluate failed: ${JSON.stringify(data.exceptionDetails)}`, { command: "browser_pick", exceptionDetails: data.exceptionDetails });
	const remote = isRecord(data.result) ? data.result : data;
	if (remote.value !== undefined) return remote.value;
	if (remote.unserializableValue !== undefined) return remote.unserializableValue;
	if (remote.description !== undefined) return remote.description;
	return data;
}

const PICK_FOCUS_FALSE_CDP_GRACE_MS = 60_000;
const PICK_CLEANUP_TIMEOUT_MS = 5_000;
const PICK_TIMEOUT = Symbol("browser_pick_timeout");

function makePickDeadline(ms: number): { promise: Promise<typeof PICK_TIMEOUT>; cancel: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<typeof PICK_TIMEOUT>((resolve) => {
		timer = setTimeout(() => resolve(PICK_TIMEOUT), Math.max(0, ms));
		const handle = timer as ReturnType<typeof setTimeout> & { unref?: () => void };
		handle.unref?.();
	});
	return {
		promise,
		cancel: () => {
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}

function buildTimedOutPickResult(message: string, timeoutMs: number, cleanup: unknown): Record<string, unknown> {
	return {
		cancelled: true,
		reason: "timeout",
		message,
		selectedCount: 0,
		selections: [],
		selectors: [],
		timeoutMs,
		cleanup,
	};
}

async function cleanupPick(server: Awaited<ReturnType<CommandRegistrarContext["ensureStarted"]>>, browserSessionId: string | undefined, tabId: unknown, pickId: string): Promise<unknown> {
	try {
		return await server.sendCommand({
			cmd: "cdp",
			method: "Runtime.evaluate",
			params: { expression: buildPickCleanupScript(pickId), awaitPromise: false, returnByValue: true, userGesture: true },
			timeoutMs: PICK_CLEANUP_TIMEOUT_MS,
		}, { browserSessionId, tabId: tabId as string | number | undefined, timeoutMs: PICK_CLEANUP_TIMEOUT_MS + 1_000 });
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export function definePickCommand({ commands, ensureStarted }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_pick",
		label: "Browser Pick",
		description: "Interactively pick DOM elements in the real browser and return stable CSS selectors plus element summaries.",
		promptSnippet: "Ask the user to click elements in the browser; returns CSS selectors for selected elements.",
		promptGuidelines: [TAB_SCOPED_TOOL_GUIDELINE, "Use browser_pick when the user needs to identify a specific visible element; it blocks until click/Enter/Escape/timeout."],
		parameters: strictCommandParameters({
			message: Type.String({ description: "Instruction shown to the user in the page picker overlay" }),
			...sharedTabScopedToolParams({ timeoutDescription: "Interactive picker timeout in milliseconds" }),
			multiple: Type.Optional(Type.Boolean({ description: "Allow Cmd/Ctrl+click multi-select; default true" })),
			focus: Type.Optional(Type.Boolean({ description: "Focus/switch to tabId before picking; default true when tabId is provided" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return await runCommandHandler(async () => {
				const message = String(params.message || "").trim();
				if (!message) throw new BrowserBridgeError("INVALID_RULE", "browser_pick requires message", { commandName: "browser_pick" });
				const server = await ensureStarted();
				const timeoutMs = commandTimeoutMs(params.timeoutMs, 120_000);
				const maxChars = commandMaxChars(params, "browser_pick");
				const rawTargetRef = targetTabId(params);
				await server.acquireUiLock(params.browserSessionId, "browser_pick");
				try {
				if (rawTargetRef !== undefined && params.focus !== false) await server.switchTab(rawTargetRef as string | number, 5_000, { browserSessionId: params.browserSessionId });
				const pickId = `pick-${Date.now()}-${Math.random().toString(16).slice(2)}`;
				const script = buildPickScript({ message, multiple: params.multiple, timeoutMs, pickId });
				const cdpTimeoutMs = params.focus === false ? timeoutMs + PICK_FOCUS_FALSE_CDP_GRACE_MS : timeoutMs;
				const rawPromise = server.sendCommand({
					cmd: "cdp",
					method: "Runtime.evaluate",
					params: { expression: script, awaitPromise: true, returnByValue: true, userGesture: true },
					timeoutMs: cdpTimeoutMs,
				}, { browserSessionId: params.browserSessionId, tabId: rawTargetRef as string | number | undefined, timeoutMs: cdpTimeoutMs + 1_000 });
				let raw: unknown;
				let timedOut = false;
				if (params.focus === false) {
					const deadline = makePickDeadline(timeoutMs);
					try {
						const raced = await Promise.race([rawPromise, deadline.promise]);
						if (raced === PICK_TIMEOUT) {
							timedOut = true;
							void rawPromise.catch(() => {});
							const cleanup = await cleanupPick(server, params.browserSessionId, rawTargetRef, pickId);
							raw = { data: { result: { value: buildTimedOutPickResult(message, timeoutMs, cleanup) } } };
						} else {
							deadline.cancel();
							raw = raced;
						}
					} finally {
						if (!timedOut) deadline.cancel();
					}
				} else {
					raw = await rawPromise;
				}
				const value = unwrapRuntimeEvaluateValue(raw);
				return await jsonCommandResult(value, params, ctx, {
					commandName: "browser_pick",
					command: "pick",
					maxChars,
					fallbackName: artifactFallbackName("pick"),
					details: { command: "Runtime.evaluate", message, focus: params.focus !== false, timedOut, pickId },
					distill: summarizePickData,
				});
				} finally {
					server.releaseUiLock(params.browserSessionId);
				}
			});
		},
	});
}
