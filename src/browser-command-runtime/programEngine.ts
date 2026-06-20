/**
 * Program Engine — frame scheduler, ref precheck, and op handlers.
 *
 * Executes a program array element-by-element with:
 * - Ref precheck: all bp-ref:// URIs validated before any frame executes
 * - Fail-fast: first frame failure aborts remaining frames
 * - Navigation detection: URL change between frames aborts execution
 * - Frame-level observability: each frame returns kind/duration/ok/resolved/eventCount
 * - Expand: eval elements with expand=true splice their array result into the program
 * - Total timeout: accumulated delays + per-frame budget enforced via AbortSignal
 */
import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";
import type { BrowserBridgeExecutionResult } from "../ports/BrowserRuntimeTypes.js";
import type { ResourceRefDescriptor as RefDescriptor } from "../ports/ResourceRefStorePort.ts";
import { resolveRefUriDetailed, resolveRefUri } from "../resources/resourceRefs.js";
import { prepareExecuteStdlib } from "./executeStdlib.js";
import { dispatchProgramElement } from "./programDispatcher.js";
import { isRecord } from "../utils/records.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ProgramContext {
	server: BrowserCommandRuntimePort;
	tabId: number | undefined;
	browserSessionId: string | undefined;
	targetRef: string | undefined;
	refRegistry: Record<string, unknown>;
	contextVars: Map<string, unknown>;
	lastEvalResult: unknown;
	signal: AbortSignal;
	/** Per-eval-frame timeout. Physical input frames keep the short FRAME_TIMEOUT_MS; eval frames can
	 * run real async JS, so they use this budget (the command timeout) instead of the 2s input cap. */
	evalTimeoutMs?: number;
}

export interface ProgramFrameResult {
	step: number;
	kind: string;
	ok: boolean;
	durationMs: number;
	result?: unknown;
	resolved?: { x: number; y: number };
	eventCount?: number;
	error?: string;
}

export interface ProgramResult {
	frames: ProgramFrameResult[];
	result: unknown;
	aborted?: { reason: string; atStep: number; newUrl?: string };
	refCheckResults?: Record<string, "alive" | "stale-but-relocatable" | "dead">;
}

// ── Constants ─────────────────────────────────────────────────────────────

const FRAME_TIMEOUT_MS = 2_000;
const MAX_FRAMES = 60;
const DEFAULT_TOTAL_TIMEOUT_MS = 55_000; // leaves 5s headroom from 60s tool limit

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function isBrowserPilotRef(value: unknown): boolean {
	return typeof value === "string" && value.startsWith("bp-ref://");
}

function isTempRef(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("__temp/");
}

function hasRelocatableLocator(ref: unknown): boolean {
	if (!isRecord(ref)) return false;
	const descriptor = isRecord(ref.descriptor) ? ref.descriptor : ref;
	const locators = Array.isArray(descriptor.locators) ? descriptor.locators : [];
	return locators.some((loc: unknown) => {
		const r = isRecord(loc) ? loc : {};
		return r.by === "css" || r.by === "xpath" || r.by === "textAnchor";
	});
}

function safeDescriptor(descriptor: RefDescriptor): RefDescriptor {
	return {
		refId: descriptor.refId,
		kind: descriptor.kind,
		locators: descriptor.locators || [],
		owner: descriptor.owner || {},
		policy: descriptor.policy,
		snapshot: descriptor.snapshot,
		semantic: descriptor.semantic,
		geometry: descriptor.geometry,
		observationId: descriptor.observationId,
		documentEpoch: descriptor.documentEpoch,
		createdAt: descriptor.createdAt,
		ttlMs: descriptor.ttlMs,
		stabilityScore: descriptor.stabilityScore,
	};
}

function backendTargetFromDescriptor(descriptor: RefDescriptor): { backendNodeId?: number; targetId?: string } {
	let backendNodeId: number | undefined;
	let targetId = typeof descriptor.owner?.targetId === "string" && descriptor.owner.targetId.trim() ? descriptor.owner.targetId.trim() : undefined;
	for (const locator of descriptor.locators) {
		if (locator.by !== "backendNodeId") continue;
		if (Number.isFinite(Number(locator.value))) backendNodeId = Number(locator.value);
		if (!targetId && typeof locator.targetId === "string" && locator.targetId.trim()) targetId = locator.targetId.trim();
		if (backendNodeId !== undefined) break;
	}
	return { backendNodeId, targetId };
}

function anchorOffset(anchor: string | undefined, box: { x: number; y: number; w: number; h: number } | undefined): { x: number; y: number } | undefined {
	if (!box) return undefined;
	switch (anchor) {
		case "topLeft": return { x: box.x, y: box.y };
		case "bottomRight": return { x: box.x + box.w, y: box.y + box.h };
		case "center":
		default: return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
	}
}

function extractBridgeData(result: BrowserBridgeExecutionResult): Record<string, unknown> {
	return isRecord(result.data) ? result.data : {};
}

function extractEventCount(data: Record<string, unknown>): number | undefined {
	// input.pointer/input.keys response includes a 'sent' array of dispatched events
	const sent = Array.isArray(data.sent) ? data.sent : [];
	const input = isRecord(data.input) ? data.input : {};
	const coords = isRecord(input.coordinates) ? input.coordinates : {};
	const x = typeof coords.x === "number" ? coords.x : undefined;
	const y = typeof coords.y === "number" ? coords.y : undefined;
	return {
		eventCount: sent.length || undefined,
		resolved: x !== undefined && y !== undefined ? { x, y } : undefined,
	}.eventCount;
}

function extractResolvedCoords(data: Record<string, unknown>): { x: number; y: number } | undefined {
	const input = isRecord(data.input) ? data.input : {};
	const coords = isRecord(input.coordinates) ? input.coordinates : {};
	const x = typeof coords.x === "number" ? coords.x : undefined;
	const y = typeof coords.y === "number" ? coords.y : undefined;
	return x !== undefined && y !== undefined ? { x, y } : undefined;
}

// ── Ref Precheck ─────────────────────────────────────────────────────────

interface RefCheckResult {
	results: Record<string, "alive" | "stale-but-relocatable" | "dead">;
	deadRefs: string[];
}

function precheckRefs(program: unknown[], ctx: ProgramContext): RefCheckResult {
	const refUris = new Set<string>();
	for (const element of program) {
		if (!isRecord(element)) continue;
		if (typeof element.ref === "string" && isBrowserPilotRef(element.ref)) {
			refUris.add(element.ref);
		}
	}

	const results: Record<string, "alive" | "stale-but-relocatable" | "dead"> = {};
	const deadRefs: string[] = [];

	for (const uri of refUris) {
		const resolved = resolveRefUriDetailed(uri);
		if (resolved.ok) {
			results[uri] = "alive";
			ctx.refRegistry[uri] = {
				ok: true,
				fresh: resolved.ref.fresh !== false,
				descriptor: safeDescriptor(resolved.ref.descriptor),
			};
		} else {
			const stored = resolveRefUri(uri);
			if (stored && hasRelocatableLocator(stored)) {
				results[uri] = "stale-but-relocatable";
			} else {
				results[uri] = "dead";
				deadRefs.push(uri);
			}
		}
	}

	return { results, deadRefs };
}

/**
 * Re-resolve a stale-but-relocatable ref immediately before use.
 * Returns a fresh descriptor if css/xpath locator still finds the element.
 */
async function resolveStaleRef(uri: string, ctx: ProgramContext): Promise<boolean> {
	const stored = resolveRefUri(uri);
	if (!stored || !hasRelocatableLocator(stored)) return false;

	// Try css locator first, then xpath
	for (const locator of stored.descriptor?.locators ?? []) {
		if (locator.by !== "css" && locator.by !== "xpath") continue;
		const selector = locator.by === "css" ? locator.value : undefined;
		if (!selector) continue;

		try {
			const result = await ctx.server.executeJavaScript(
				`(function(){
					const el = document.querySelector(${JSON.stringify(selector)});
					if(!el) return null;
					const r = el.getBoundingClientRect();
					const rect = {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)};
					// Try to get backendNodeId via CDP exposed in window
					const bnid = window.__browserPilotTempNodeId;
					return {box:rect,backendNodeId:typeof bnid==='number'?bnid:undefined};
				})()`,
				{ browserSessionId: ctx.browserSessionId, tabId: ctx.tabId, timeoutMs: 1000 },
			);
			const data = extractBridgeData(result);
			if (data && typeof data === "object") {
				const box = isRecord(data.box) ? data.box : undefined;
				const bnid = typeof data.backendNodeId === "number" ? data.backendNodeId : undefined;
				if (box) {
					const bx = Number(box.x), by = Number(box.y), bw = Number(box.w), bh = Number(box.h);
					// Update registry with fresh geometry
					const entry = ctx.refRegistry[uri];
					if (isRecord(entry) && isRecord(entry.descriptor)) {
						(entry.descriptor as Record<string, unknown>).geometry = { box: { x: bx, y: by, w: bw, h: bh }, point: { x: bx + bw / 2, y: by + bh / 2 } };
						if (bnid !== undefined) {
							const locators = (entry.descriptor as Record<string, unknown>).locators as Array<Record<string, unknown>>;
							locators.unshift({ by: "backendNodeId", value: bnid });
						}
					}
					return true;
				}
			}
		} catch {
			// CSS query failed, try next locator
		}
	}
	return false;
}

// ── Op Handlers ────────────────────────────────────────────────────────────

async function executeEvalFrame(
	element: Record<string, unknown>,
	ctx: ProgramContext,
	step: number,
): Promise<ProgramFrameResult> {
	const startedAt = Date.now();
	const script = String(element.eval ?? "");

	try {
		// Build context prelude: inject named context variables as JSON
		// $ is handled directly by reading ctx.lastEvalResult at eval time, not via prelude
		const contextLines: string[] = [];
		for (const [name, value] of ctx.contextVars) {
			try {
				const serialized = JSON.stringify(value);
				contextLines.push(`const ${name} = ${serialized};`);
			} catch {
				contextLines.push(`const ${name} = undefined;`);
			}
		}
		const contextPrelude = contextLines.length > 0 ? contextLines.join("\n") + "\n" : "";

		// Inject stdlib helpers for ref resolution and DOM-aware value/wait helpers.
		const prepared = prepareExecuteStdlib(script, { enabled: true });
		const fullScript = `${contextPrelude}${prepared.script}`;

		const result = await ctx.server.executeJavaScript(fullScript, {
			browserSessionId: ctx.browserSessionId,
			tabId: ctx.tabId as number | string | undefined,
			timeoutMs: ctx.evalTimeoutMs ?? FRAME_TIMEOUT_MS,
		});

		const evalResult = result.data;

		// Handle 'as' binding: store eval result in context vars
		if (typeof element.as === "string" && element.as) {
			ctx.contextVars.set(element.as, evalResult);
		}

		// Register temp ref for DOM elements: extract backendNodeId and store
		if (typeof element.register === "string" && element.register && evalResult !== undefined && evalResult !== null) {
			try {
				// Use CDP to get backendNodeId for the returned DOM element
				const regResult = await ctx.server.executeJavaScript(
					`(function(){
						try {
							// Store globally so CDP can find it
							window.__browserPilotTempNodeId = undefined;
							const el = $;
							if (!el || !el.getBoundingClientRect) return null;
							// Try to find backendNodeId via JS handle — in browser context we can't get it directly
							// Instead, return a sentinel that signals "element exists, coords known"
							const r = el.getBoundingClientRect();
							return {
								backendNodeId: undefined, // resolved at bridge level
								box: {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}
							};
						} catch(e) { return null; }
					})()`,
					{ browserSessionId: ctx.browserSessionId, tabId: ctx.tabId as number | string | undefined, timeoutMs: 500 },
				);
				const regData = extractBridgeData(regResult);
				const regBox = isRecord(regData.box) ? regData.box : undefined;
				const tempRef = `__temp/${element.register}`;
				ctx.contextVars.set(tempRef, {
					box: regBox,
					point: regBox ? { x: Number(regBox.x) + Number(regBox.w) / 2, y: Number(regBox.y) + Number(regBox.h) / 2 } : undefined,
				});
			} catch {
				// registration failed — element may be stale, continue without it
			}
		}

		return {
			step,
			kind: "eval",
			ok: true,
			durationMs: Date.now() - startedAt,
			result: evalResult,
		};
	} catch (error) {
		return {
			step,
			kind: "eval",
			ok: false,
			durationMs: Date.now() - startedAt,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Center/anchor coordinates from a stored ref descriptor's geometry. */
function coordsFromDescriptor(desc: Record<string, unknown>, anchor: string | undefined): { x: number; y: number } | undefined {
	const geometry = isRecord(desc.geometry) ? desc.geometry : {};
	const box = isRecord(geometry.box) ? geometry.box : undefined;
	const point = isRecord(geometry.point) ? geometry.point : undefined;
	const resolved = point ?? anchorOffset(anchor, box as { x: number; y: number; w: number; h: number } | undefined);
	return resolved ? { x: Number(resolved.x), y: Number(resolved.y) } : undefined;
}

/** Resolve coordinates from a bp-ref:// URI in the registry, re-resolving stale-but-relocatable refs. */
async function resolveRefCoords(uri: string, anchor: string | undefined, ctx: ProgramContext): Promise<{ coords?: { x: number; y: number }; error?: string }> {
	const entry = ctx.refRegistry[uri];
	if (isRecord(entry) && entry.ok === true && isRecord(entry.descriptor)) {
		return { coords: coordsFromDescriptor(entry.descriptor as Record<string, unknown>, anchor) };
	}
	if (isRecord(entry) && entry.ok === "stale-but-relocatable") {
		const ok = await resolveStaleRef(uri, ctx);
		if (!ok) return { error: `ref re-resolution failed for stale ref: ${uri}` };
		const refreshed = ctx.refRegistry[uri];
		if (!isRecord(refreshed) || !isRecord(refreshed.descriptor)) return { error: `ref re-resolution returned no descriptor: ${uri}` };
		return { coords: coordsFromDescriptor(refreshed.descriptor as Record<string, unknown>, anchor) };
	}
	return { error: `ref not in registry: ${uri}` };
}

/** Coordinates from a refFrom context var: a __temp/<name> handle or a plain {box, point} descriptor from eval. */
function coordsFromRefFrom(refFromVal: unknown, anchor: string | undefined, ctx: ProgramContext): { x: number; y: number } | undefined {
	const source = isTempRef(refFromVal) ? ctx.contextVars.get(String(refFromVal)) : refFromVal;
	if (!isRecord(source)) return undefined;
	const box = isRecord(source.box) ? source.box : undefined;
	const point = isRecord(source.point) ? source.point : undefined;
	const resolved = point ?? anchorOffset(anchor, box as { x: number; y: number; w: number; h: number } | undefined);
	return resolved ? { x: Number(resolved.x), y: Number(resolved.y) } : undefined;
}

/** Resolve a mouse point from the first available of ref / refFrom / explicit x,y. */
async function resolveMouseCoords(
	ref: unknown, refFrom: unknown, x: unknown, y: unknown, anchor: string | undefined, ctx: ProgramContext,
): Promise<{ coords?: { x: number; y: number }; error?: string }> {
	if (typeof ref === "string") return await resolveRefCoords(ref, anchor, ctx);
	if (typeof refFrom === "string") {
		const refFromVal = ctx.contextVars.get(refFrom);
		if (refFromVal === undefined) return { error: `context var not found: ${refFrom}` };
		return { coords: coordsFromRefFrom(refFromVal, anchor, ctx) };
	}
	if (x !== undefined || y !== undefined) return { coords: { x: Number(x ?? 0), y: Number(y ?? 0) } };
	return { coords: undefined };
}

async function executeMouseFrame(
	element: Record<string, unknown>,
	ctx: ProgramContext,
	step: number,
): Promise<ProgramFrameResult> {
	const startedAt = Date.now();
	const action = String(element.mouse ?? "");
	const kind = `mouse:${action}`;
	const anchor = element.anchor as string | undefined;

	try {
		// Resolve the start point from ref / refFrom / explicit x,y (requiredAny guarantees one is present).
		const start = await resolveMouseCoords(element.ref, element.refFrom, element.x, element.y, anchor, ctx);
		if (start.error) return { step, kind, ok: false, durationMs: Date.now() - startedAt, error: start.error };
		const coords = start.coords ?? { x: 0, y: 0 };

		const buttonVal = (element.button as string) ?? "left";

		let gesture: string;
		if (action === "move") gesture = "moveonly";
		else if (action === "press") gesture = "pressonly";
		else if (action === "release") gesture = "releaseonly";
		else if (action === "drag") gesture = "drag";
		else gesture = "wheel";

		// Drag needs an end point: toRef (a second bp-ref) or explicit toX/toY. The bridge interpolates
		// a straight line of mouseMoved events between start and end (trusted), which is what HTML5
		// drag-and-drop and slider/canvas drags require.
		let end: { x: number; y: number } | undefined;
		if (action === "drag") {
			const dest = await resolveMouseCoords(element.toRef, undefined, element.toX, element.toY, anchor, ctx);
			if (dest.error) return { step, kind, ok: false, durationMs: Date.now() - startedAt, error: dest.error };
			end = dest.coords;
			if (!end) return { step, kind, ok: false, durationMs: Date.now() - startedAt, error: "mouse drag requires an end point: toRef or toX/toY" };
		}

		const bridgeCmd: Record<string, unknown> = {
			cmd: "input.pointer",
			gesture,
			x: coords.x,
			y: coords.y,
			...(buttonVal ? { button: buttonVal } : {}),
			...(action === "wheel" ? { deltaX: Number(element.dx ?? 0), deltaY: Number(element.dy ?? 0) } : {}),
			...(action === "drag" && end ? { toX: end.x, toY: end.y } : {}),
			...(ctx.tabId !== undefined ? { tabId: ctx.tabId } : {}),
		};

		const result = await ctx.server.sendCommand(bridgeCmd as Parameters<BrowserCommandRuntimePort["sendCommand"]>[0], {
			browserSessionId: ctx.browserSessionId,
			tabId: ctx.tabId,
			timeoutMs: FRAME_TIMEOUT_MS,
			accessMode: "write",
		});

		const data = extractBridgeData(result);
		const resolved = extractResolvedCoords(data);
		const eventCount = extractEventCount(data);

		return {
			step,
			kind,
			ok: true,
			durationMs: Date.now() - startedAt,
			...(resolved ? { resolved } : {}),
			...(eventCount !== undefined ? { eventCount } : {}),
		};
	} catch (error) {
		return { step, kind, ok: false, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
	}
}

async function executeKeyFrame(
	element: Record<string, unknown>,
	ctx: ProgramContext,
	step: number,
): Promise<ProgramFrameResult> {
	const startedAt = Date.now();
	const action = String(element.key ?? "");
	const code = String(element.code ?? "");
	const kind = `key:${action}`;

	try {
		const modifiers = (element.modifiers as string[] | undefined) ?? [];
		const modMask = modifiers.reduce((mask, m) => {
			const bit: Record<string, number> = { ctrl: 2, alt: 1, meta: 4, shift: 8 };
			return mask | (bit[m] ?? 0);
		}, 0);

		const bridgeCmd: Record<string, unknown> = {
			cmd: "input.keys",
			keys: [{ key: code, type: action === "down" ? "keyDown" : "keyUp", modifiers: modMask }],
			...(ctx.tabId !== undefined ? { tabId: ctx.tabId } : {}),
		};

		const result = await ctx.server.sendCommand(bridgeCmd as Parameters<BrowserCommandRuntimePort["sendCommand"]>[0], {
			browserSessionId: ctx.browserSessionId,
			tabId: ctx.tabId,
			timeoutMs: FRAME_TIMEOUT_MS,
			accessMode: "write",
		});

		const data = extractBridgeData(result);
		const eventCount = extractEventCount(data);

		return {
			step,
			kind,
			ok: true,
			durationMs: Date.now() - startedAt,
			...(eventCount !== undefined ? { eventCount } : {}),
		};
	} catch (error) {
		return { step, kind, ok: false, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
	}
}

async function executeTextFrame(
	element: Record<string, unknown>,
	ctx: ProgramContext,
	step: number,
): Promise<ProgramFrameResult> {
	const startedAt = Date.now();
	try {
		const bridgeCmd: Record<string, unknown> = {
			cmd: "input.keys",
			text: String(element.text ?? ""),
			...(ctx.tabId !== undefined ? { tabId: ctx.tabId } : {}),
		};

		const result = await ctx.server.sendCommand(bridgeCmd as Parameters<BrowserCommandRuntimePort["sendCommand"]>[0], {
			browserSessionId: ctx.browserSessionId,
			tabId: ctx.tabId,
			timeoutMs: FRAME_TIMEOUT_MS,
			accessMode: "write",
		});

		const data = extractBridgeData(result);
		const eventCount = extractEventCount(data);

		return {
			step,
			kind: "text",
			ok: true,
			durationMs: Date.now() - startedAt,
			...(eventCount !== undefined ? { eventCount } : {}),
		};
	} catch (error) {
		return { step, kind: "text", ok: false, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
	}
}

async function executeWaitFrame(
	element: Record<string, unknown>,
	ctx: ProgramContext,
	step: number,
): Promise<ProgramFrameResult> {
	const startedAt = Date.now();
	const ms = Number(element.wait ?? 0);
	try {
		// Use settled() stdlib for DOM-aware waiting
		const script = `browserPilot.settled(${ms}, ${Math.min(ms * 2 + 1000, 5000)})`;
		const prepared = prepareExecuteStdlib(script, { enabled: true });
		const result = await ctx.server.executeJavaScript(prepared.script, {
			browserSessionId: ctx.browserSessionId,
			tabId: ctx.tabId as number | string | undefined,
			timeoutMs: Math.min(ms * 2 + 1000, 5000),
		});

		return { step, kind: "wait", ok: true, durationMs: Date.now() - startedAt, result: result.data };
	} catch (error) {
		return { step, kind: "wait", ok: false, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) };
	}
}

// ── Frame Dispatcher ───────────────────────────────────────────────────────

async function executeFrame(
	element: Record<string, unknown>,
	discriminator: string,
	ctx: ProgramContext,
	step: number,
): Promise<ProgramFrameResult> {
	switch (discriminator) {
		case "eval": return await executeEvalFrame(element, ctx, step);
		case "mouse": return await executeMouseFrame(element, ctx, step);
		case "key": return await executeKeyFrame(element, ctx, step);
		case "text": return await executeTextFrame(element, ctx, step);
		case "wait": return await executeWaitFrame(element, ctx, step);
		default: return { step, kind: discriminator, ok: false, durationMs: 0, error: `unknown discriminator: ${discriminator}` };
	}
}

// ── URL tracking for navigation detection ──────────────────────────────────

/**
 * Whether a frame could plausibly trigger a navigation, so we know when to poll location.href.
 * eval and key (Enter submits) can navigate; for mouse only clicks (press/release) can — wheel/move
 * never do. Skipping text/wait/move/wheel avoids a JS round-trip per non-navigating frame.
 */
function frameCanNavigate(discriminator: string, element: Record<string, unknown>): boolean {
	if (discriminator === "eval" || discriminator === "key") return true;
	if (discriminator === "mouse") {
		const action = String(element.mouse ?? "");
		return action === "press" || action === "release";
	}
	return false;
}

async function getCurrentUrl(ctx: ProgramContext): Promise<string | undefined> {
	try {
		const result = await ctx.server.executeJavaScript("location.href", {
			browserSessionId: ctx.browserSessionId,
			tabId: ctx.tabId as number | string | undefined,
			timeoutMs: 500,
		});
		return typeof result.data === "string" ? result.data : undefined;
	} catch {
		return undefined;
	}
}

// ── Main Execution Loop ────────────────────────────────────────────────────

export async function executeProgram(
	program: unknown[],
	ctx: ProgramContext,
): Promise<ProgramResult> {
	const frames: ProgramFrameResult[] = [];

	// Wrap with total timeout AbortSignal if not already provided
	const timeoutSignal = ctx.signal ?? AbortSignal.timeout(DEFAULT_TOTAL_TIMEOUT_MS);
	const combinedSignal = (ctx.signal && ctx.signal !== AbortSignal.timeout(DEFAULT_TOTAL_TIMEOUT_MS))
		? ctx.signal
		: timeoutSignal;

	// Ref precheck
	const refCheck = precheckRefs(program, ctx);
	if (refCheck.deadRefs.length > 0) {
		return {
			frames,
			result: undefined,
			aborted: { reason: `ref precheck failed — dead refs: ${refCheck.deadRefs.join(", ")}`, atStep: -1 },
			refCheckResults: refCheck.results,
		};
	}

	// Expand phase
	const expanded: Array<{ element: Record<string, unknown>; discriminator: string; modifiers: Record<string, unknown> }> = [];
	for (let i = 0; i < program.length; i++) {
		const dispatched = dispatchProgramElement(program[i], i);
		if (!dispatched.ok) {
			return { frames, result: undefined, aborted: { reason: dispatched.error, atStep: i }, refCheckResults: refCheck.results };
		}

		if (dispatched.discriminator === "eval" && dispatched.element.expand === true) {
			const evalResult = await executeEvalFrame(dispatched.element, ctx, i);
			frames.push(evalResult);
			if (!evalResult.ok) {
				return { frames, result: undefined, aborted: { reason: evalResult.error ?? "expand eval failed", atStep: i }, refCheckResults: refCheck.results };
			}
			if (!Array.isArray(evalResult.result)) {
				return { frames, result: undefined, aborted: { reason: `Step ${i}: expand=true but eval result is not an array`, atStep: i }, refCheckResults: refCheck.results };
			}
			for (let j = 0; j < evalResult.result.length; j++) {
				if (expanded.length >= MAX_FRAMES) {
					return { frames, result: undefined, aborted: { reason: `program exceeded ${MAX_FRAMES} frame limit after expansion`, atStep: i }, refCheckResults: refCheck.results };
				}
				const subDispatched = dispatchProgramElement(evalResult.result[j], i);
				if (!subDispatched.ok) {
					return { frames, result: undefined, aborted: { reason: `Step ${i} expanded[${j}]: ${subDispatched.error}`, atStep: i }, refCheckResults: refCheck.results };
				}
				expanded.push({ element: subDispatched.element, discriminator: subDispatched.discriminator, modifiers: subDispatched.modifiers });
			}
			ctx.lastEvalResult = evalResult.result;
		} else {
			expanded.push({ element: dispatched.element, discriminator: dispatched.discriminator, modifiers: dispatched.modifiers });
		}
	}

	// Execute expanded sequence. Navigation detection is checked only AFTER frames that can
	// actually navigate (clicks, key events, eval) instead of polling location.href before every
	// frame — the old pre-frame poll cost one extra JS round-trip per frame (~2N round-trips for an
	// N-frame program). We still execute the triggering frame, then abort the remaining frames so
	// later refs never act on a navigated-away page.
	let lastUrl = await getCurrentUrl(ctx);
	for (let i = 0; i < expanded.length; i++) {
		if (combinedSignal.aborted) {
			return { frames, result: ctx.lastEvalResult, aborted: { reason: "timeout", atStep: i }, refCheckResults: refCheck.results };
		}

		const { element, discriminator, modifiers } = expanded[i];

		if (modifiers.delay !== undefined) {
			const delayMs = Number(modifiers.delay);
			if (delayMs > 0) {
				// Wait but respect abort signal
				await sleep(delayMs);
				if (combinedSignal.aborted) {
					return { frames, result: ctx.lastEvalResult, aborted: { reason: "timeout", atStep: i }, refCheckResults: refCheck.results };
				}
			}
		}

		const frameResult = await executeFrame(element, discriminator, ctx, frames.length);
		frames.push(frameResult);

		if (!frameResult.ok) {
			return { frames, result: ctx.lastEvalResult, aborted: { reason: frameResult.error ?? "frame failed", atStep: i }, refCheckResults: refCheck.results };
		}

		if (discriminator === "eval") {
			ctx.lastEvalResult = frameResult.result;
		}

		// Only poll for navigation after frames that could have triggered it.
		if (frameCanNavigate(discriminator, element)) {
			const currentUrl = await getCurrentUrl(ctx);
			if (currentUrl !== undefined && lastUrl !== undefined && currentUrl !== lastUrl) {
				return { frames, result: ctx.lastEvalResult, aborted: { reason: "navigation", atStep: i, newUrl: currentUrl }, refCheckResults: refCheck.results };
			}
			lastUrl = currentUrl ?? lastUrl;
		}
	}

	return { frames, result: ctx.lastEvalResult, refCheckResults: refCheck.results };
}

// ── collectProgramTargetRefs ───────────────────────────────────────────────

export function collectProgramTargetRefs(program: unknown[]): Array<{
	refId: string;
	observedAt: number;
	observationId: string;
	url?: string;
	mutationEpoch?: number;
	backendNodeId?: number;
	targetId?: string;
	point?: { x: number; y: number };
	cssRoots: never[];
	locators: Array<Record<string, unknown>>;
}> {
	const refs: Array<{
		refId: string;
		observedAt: number;
		observationId: string;
		url?: string;
		mutationEpoch?: number;
		backendNodeId?: number;
		targetId?: string;
		point?: { x: number; y: number };
		cssRoots: never[];
		locators: Array<Record<string, unknown>>;
	}> = [];

	for (const element of program) {
		if (!isRecord(element)) continue;
		if (typeof element.ref !== "string" || !isBrowserPilotRef(element.ref)) continue;
		const resolved = resolveRefUriDetailed(element.ref);
		if (!resolved.ok) continue;
		const desc = resolved.ref.descriptor;
		const bt = backendTargetFromDescriptor(desc);
		const point = desc.geometry?.point;
		refs.push({
			refId: desc.refId,
			observedAt: desc.documentEpoch?.capturedAt ?? desc.createdAt,
			observationId: desc.observationId,
			url: desc.documentEpoch?.url,
			mutationEpoch: desc.documentEpoch?.mutationEpoch,
			...(bt.backendNodeId !== undefined ? { backendNodeId: bt.backendNodeId } : {}),
			...(bt.targetId ? { targetId: bt.targetId } : {}),
			...(point ? { point: { x: point.x, y: point.y } } : {}),
			cssRoots: [],
			locators: desc.locators,
		});
	}
	return refs;
}
