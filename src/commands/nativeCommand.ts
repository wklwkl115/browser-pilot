import { Type } from "typebox";
import { resolveExecutionRef, type ExecutionRefTarget } from "../browser-command-runtime/executionRef.js";
import { recordAbmlActionContext } from "../browser-command-runtime/abml/verification.js";
import { BrowserBridgeError } from "../utils/errors.js";
import { jsonResult } from "../utils/toolResult.js";
import type { CommandEffect } from "./commandEffect.js";
import { commandExpectationSchema, prepareCommandExpectation } from "./commandExpectation.js";
import { runVerifiedWrite, verifiedWriteValue } from "./verifiedWrite.js";
import {
	defineBrowserCommand,
	pinTabExecutionTarget,
	resolveRefExecutionTarget,
	runCommandHandler,
	sharedTabScopedToolParams,
	targetTabId,
} from "./commandRuntime.js";
import { nativeCommandTimeoutMs, strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";
import { validateBridgeCommand, type BridgeCommand } from "../types/nativeProtocol.js";
import {
	coreNativeCommandNames,
	isNativeTabScopedCommand,
	isNativeWriteCommand,
	isPublicNativeCommand,
	nativeCommandOwner,
	nativeCommandTier,
	publicNativeCommandNames,
} from "./nativeCommandAccess.js";
import { isRecord } from "../utils/records.js";
import { registerVisualTargetRef } from "./visualEvidence.js";
import { captureVisualScreenshot, visualFingerprintMatches, type VisualScreenshotCapture } from "./visualEvidence.js";
import { readPageFingerprint } from "./pageSignals.js";
import {
	artifactFallbackName,
	artifactResourceUri,
	pruneObservationArtifacts,
	resolveArtifactPath,
	saveBuffer,
} from "../artifacts/artifactFiles.js";
import type { RefVisualBinding } from "../kernels/refs/types.js";

const coreCommandNames = coreNativeCommandNames();

/** Summarize advanced commands as `family.*` when the whole family is advanced, else name them individually. */
function advancedCommandSummary(): string[] {
	const byFamily = new Map<string, { advanced: string[]; total: number }>();
	for (const cmd of publicNativeCommandNames()) {
		const family = cmd.split(".")[0]!;
		const entry = byFamily.get(family) ?? { advanced: [], total: 0 };
		entry.total += 1;
		if (nativeCommandTier(cmd) === "advanced") entry.advanced.push(cmd);
		byFamily.set(family, entry);
	}
	return [...byFamily.entries()].flatMap(([family, { advanced, total }]) =>
		!advanced.length ? [] : advanced.length === total ? [`${family}.*`] : advanced,
	);
}
const advancedCommandFamilies = advancedCommandSummary();

/** Actions a DOM/AX-grounded input.ref accepts on the daemon side; must mirror the extension's LIVE_REF_ACTIONS. */
const LIVE_REF_ACTIONS = new Set(["click", "hover", "type", "focus", "check", "select"]);

function validateLiveRefAction(command: BridgeCommand): void {
	const action = String(command.action || "");
	if (!LIVE_REF_ACTIONS.has(action))
		throw new BrowserBridgeError(
			"INVALID_RULE",
			`Non-visual input.ref targets support ${[...LIVE_REF_ACTIONS].join(", ")}; use browser_observe visual.ref for pointer gestures`,
			{ action },
		);
	if (action === "type" && typeof command.text !== "string")
		throw new BrowserBridgeError("INVALID_RULE", "input.ref type requires text", { ref: command.ref });
	if (
		action === "select" &&
		command.value === undefined &&
		command.label === undefined &&
		command.index === undefined
	)
		throw new BrowserBridgeError("INVALID_RULE", "input.ref select requires value, label, or index", {
			ref: command.ref,
		});
}

/**
 * Native waits run until their own deadline; give them a slightly shorter budget than the bridge
 * transport so a timed-out wait returns its diagnostics instead of a bare BRIDGE_TIMEOUT.
 */
const WAIT_TIMEOUT_MARGIN_MS = 1_500;

function withNativeTimeoutBudget(command: BridgeCommand, timeoutMs: number): BridgeCommand {
	if (!String(command.cmd || "").startsWith("wait.")) return command;
	return { ...command, timeoutMs: Math.max(500, timeoutMs - WAIT_TIMEOUT_MARGIN_MS) };
}

type NativeWriteEvidence = {
	capture?: VisualScreenshotCapture;
	effect?: NonNullable<CommandEffect["visual"]>;
};

/**
 * Post-dispatch bookkeeping that only native commands need: pixel evidence for visual
 * refs and the perception-ledger action record that lets the next observe attribute causality.
 */
async function captureNativeWriteEvidence(options: {
	server: Awaited<ReturnType<CommandRegistrarContext["ensureStarted"]>>;
	command: BridgeCommand;
	commandName: string;
	target: { browserSessionId?: string; tabId: number };
	timeoutMs: number;
	signal: AbortSignal;
	visualBinding?: RefVisualBinding;
	beforeVisual?: VisualScreenshotCapture;
	actionAt?: number;
}): Promise<NativeWriteEvidence | undefined> {
	const { server, command, commandName, target, timeoutMs, signal, visualBinding, beforeVisual } = options;
	if (command.cmd === "input.ref" && typeof command.ref === "string") {
		recordAbmlActionContext({
			server,
			browserSessionId: target.browserSessionId,
			tabId: target.tabId,
			ref: command.ref,
			verb: commandName,
			at: options.actionAt ?? Date.now(),
		});
	}
	if (!visualBinding) return undefined;
	const afterVisual = await captureVisualScreenshot(server, {
		browserSessionId: target.browserSessionId,
		tabId: target.tabId,
		timeoutMs,
		signal,
	}).catch(() => {
		signal.throwIfAborted();
		return undefined;
	});
	return {
		capture: afterVisual,
		effect: {
			observed: !!afterVisual,
			changed: afterVisual ? afterVisual.sha256 !== beforeVisual?.sha256 : null,
			...(beforeVisual ? { beforeSha256: beforeVisual.sha256 } : {}),
			...(afterVisual ? { afterSha256: afterVisual.sha256 } : {}),
		},
	};
}

async function preflightVisualInput(options: {
	server: Awaited<ReturnType<CommandRegistrarContext["ensureStarted"]>>;
	binding: RefVisualBinding;
	browserSessionId?: string;
	tabId: number;
	timeoutMs: number;
	signal: AbortSignal;
}): Promise<VisualScreenshotCapture> {
	if (!options.binding.actionableGrounding)
		throw new BrowserBridgeError("INVALID_RULE", "This visual observation is not trusted for live actions", {
			captureMethod: options.binding.captureMethod,
		});
	const fingerprint = await readPageFingerprint(options.server, {
		browserSessionId: options.browserSessionId,
		tabId: options.tabId,
		timeoutMs: options.timeoutMs,
		signal: options.signal,
	});
	if (!visualFingerprintMatches(options.binding, fingerprint))
		throw new BrowserBridgeError("REF_STALE", "Visual observation basis changed before input dispatch", {
			refObservationId: options.binding.anchor?.hostRef,
		});
	const screenshot = await captureVisualScreenshot(options.server, {
		browserSessionId: options.browserSessionId,
		tabId: options.tabId,
		timeoutMs: options.timeoutMs,
		signal: options.signal,
	});
	if (
		!screenshot ||
		screenshot.sha256 !== options.binding.sha256 ||
		screenshot.width !== options.binding.width ||
		screenshot.height !== options.binding.height
	) {
		// Tuning note: strict full-frame equality; add ROI decoding only if rejection telemetry proves this too conservative.
		throw new BrowserBridgeError("REF_STALE", "Visual pixels changed before input dispatch", {
			observationId: options.binding.anchor?.hostRef,
		});
	}
	const finalFingerprint = await readPageFingerprint(options.server, {
		browserSessionId: options.browserSessionId,
		tabId: options.tabId,
		timeoutMs: options.timeoutMs,
		signal: options.signal,
	});
	if (!visualFingerprintMatches(options.binding, finalFingerprint))
		throw new BrowserBridgeError("REF_STALE", "Visual observation basis changed during input preflight", {
			refObservationId: options.binding.anchor?.hostRef,
		});
	return screenshot;
}

function prepareNativeRef(command: BridgeCommand): { command: BridgeCommand; refs: ExecutionRefTarget[] } {
	if (command.cmd !== "input.ref") return { command, refs: [] };
	if (typeof command.ref !== "string" || !command.ref.startsWith("bp-ref://")) {
		throw new BrowserBridgeError("INVALID_REF_TARGET", "input.ref requires a bp-ref URI in ref", {
			ref: command.ref,
		});
	}
	let resolved = resolveExecutionRef(command.ref);
	if (!resolved.target.fresh)
		throw new BrowserBridgeError("REF_STALE", "Referenced evidence was modified after observation", {
			ref: command.ref,
		});
	const visualInput = isRecord(command.visual) ? command.visual : undefined;
	if (resolved.descriptor.visual) {
		const point = isRecord(visualInput?.point)
			? { x: Number(visualInput.point.x), y: Number(visualInput.point.y) }
			: undefined;
		const to = isRecord(visualInput?.to) ? { x: Number(visualInput.to.x), y: Number(visualInput.to.y) } : undefined;
		if (!visualInput || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
			throw new BrowserBridgeError("INVALID_REF_TARGET", "Visual input.ref requires a normalized point", {
				ref: command.ref,
			});
		}
		const action = String(command.action || "");
		if (action === "drag" && !to)
			throw new BrowserBridgeError("INVALID_RULE", "Visual input.ref drag requires visual.to", {
				ref: command.ref,
			});
		if (action === "type" && typeof command.text !== "string")
			throw new BrowserBridgeError("INVALID_RULE", "Visual input.ref type requires text", { ref: command.ref });
		const visualRef = registerVisualTargetRef(resolved.descriptor, point, to);
		resolved = resolveExecutionRef(visualRef);
		command = { ...command, ref: visualRef };
	} else {
		if (visualInput)
			throw new BrowserBridgeError("INVALID_REF_TARGET", "visual input requires a visual observation ref", {
				ref: command.ref,
			});
		validateLiveRefAction(command);
	}
	const { refId, kind, backendNodeId, targetId, point, locators, semantic, visual } = resolved.target;
	const target = {
		refId,
		kind,
		...(backendNodeId !== undefined ? { backendNodeId } : {}),
		...(targetId ? { targetId } : {}),
		...(point ? { point } : {}),
		locators,
		...(semantic ? { semantic } : {}),
		...(visual ? { visual } : {}),
	};
	return { command: { ...command, target }, refs: [resolved.target] };
}

export function defineNativeCommand({ commands, ensureStarted }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_command",
		label: "Browser Command",
		description:
			"Run one validated native browser command in the selected or ref-owning tab. Writes may return effect and verification evidence.",
		promptGuidelines: [
			"Read browser-pilot://native-command/<cmd> only when an unfamiliar native command's fields are needed.",
			"For raw CDP, pass command={cmd:'cdp',method:'Domain.method',params:{...}}; Browser Pilot owns attach, reuse, recovery, and cleanup.",
			"For trusted input on an observed control, use command={cmd:'input.ref',ref:'bp-ref://...',action:'click'|'hover'|'focus'|'type'|'check'|'select'}: type takes text (clear:true replaces the current value), check takes checked (default true), select takes value, label, or index. Browser Pilot resolves the tab and private CDP target.",
			"For screenshot-grounded input, use browser_observe visual.ref with a normalized visual.point; do not convert it to raw input.pointer coordinates.",
			"For tab-scoped writes, expect may declare a JavaScript truth expression or structured ref/state postcondition; Browser Pilot owns settlement and verification.",
			"When the next step depends on the page settling, use wait.loadState, wait.selector, wait.networkIdle, or wait.navigation (with url or urlContains) instead of polling from browser_execute.",
		],
		parameters: strictCommandParameters({
			command: Type.Object(
				{
					cmd: Type.String({
						minLength: 1,
						description: `Native command name. Core: ${coreCommandNames.join(", ")}. Advanced (${advancedCommandFamilies.join(", ")}) are documented in browser-pilot://native-commands.`,
					}),
				},
				{ additionalProperties: true, description: "Validated native bridge command object." },
			),
			expect: Type.Optional(commandExpectationSchema),
			...sharedTabScopedToolParams(),
		}),
		async execute(params, signal, ctx) {
			return await runCommandHandler(async () => {
				if (!params.command || typeof params.command !== "object" || Array.isArray(params.command))
					throw new BrowserBridgeError("INVALID_RULE", "browser_command requires command object", {
						commandName: "browser_command",
					});
				const protocol = validateBridgeCommand(params.command, { allowMissingTabId: true, publicCall: true });
				if (!protocol.ok)
					throw new BrowserBridgeError("INVALID_BROWSER_COMMAND", protocol.error, protocol.details);
				const owner = nativeCommandOwner(protocol.command);
				if (owner)
					throw new BrowserBridgeError(
						"INVALID_RULE",
						`${String(protocol.command.cmd)} must be invoked through ${owner}`,
						{ commandName: "browser_command", useTool: owner },
					);
				if (!isPublicNativeCommand(protocol.command))
					throw new BrowserBridgeError(
						"INVALID_RULE",
						`${String(protocol.command.cmd)} is not a public native command`,
						{ commandName: "browser_command", catalog: "browser-pilot://native-commands" },
					);
				const prepared = prepareNativeRef(protocol.command);
				const command = prepared.command;
				const write = isNativeWriteCommand(command);
				const expect = prepareCommandExpectation(params.expect, "browser_command");
				if (expect && !write)
					throw new BrowserBridgeError("INVALID_RULE", "browser_command expect is only valid for writes", {
						commandName: "browser_command",
					});
				const server = await ensureStarted();
				const timeoutMs = nativeCommandTimeoutMs(String(command.cmd || ""));
				const rawTarget = targetTabId(params, command);
				const expectationRefs =
					expect?.kind === "abml" ? [resolveExecutionRef(expect.expectation.ref).target] : [];
				const resolvedTarget = resolveRefExecutionTarget(server, prepared.refs, {
					rawTarget,
					observedRefs: expectationRefs,
				});
				const target = isNativeTabScopedCommand(command)
					? pinTabExecutionTarget(server, resolvedTarget)
					: resolvedTarget;
				if (expect && target.tabId === undefined)
					throw new BrowserBridgeError("INVALID_RULE", "browser_command expect requires a tab-scoped write", {
						commandName: "browser_command",
					});
				const commandName = String(command.cmd || "");
				const dispatchable = withNativeTimeoutBudget(command, timeoutMs);
				const dispatch = ({ signal: dispatchSignal }: { signal?: AbortSignal }) =>
					server.sendCommand(dispatchable, {
						browserSessionId: target.browserSessionId,
						tabId: target.rawTarget,
						timeoutMs,
						accessMode: write ? "write" : "read",
						signal: dispatchSignal,
					});
				const visualBinding = prepared.refs[0]?.visual;
				let beforeVisual: VisualScreenshotCapture | undefined;
				let actionAt: number | undefined;
				const outcome = write
					? await runVerifiedWrite({
							server,
							verb: commandName,
							target,
							timeoutMs,
							signal,
							expect,
							verifyScript:
								expect?.kind === "javascript"
									? `return Boolean(await (${expect.expression}));`
									: undefined,
							before: async ({ signal: operationSignal }) => {
								if (!visualBinding) return;
								beforeVisual = await preflightVisualInput({
									server,
									binding: visualBinding,
									browserSessionId: target.browserSessionId,
									tabId: target.tabId!,
									timeoutMs,
									signal: operationSignal,
								});
							},
							dispatch: (context) => {
								if (command.cmd === "input.ref") actionAt = Date.now();
								return dispatch(context);
							},
							after: async ({ signal: operationSignal }) =>
								await captureNativeWriteEvidence({
									server,
									command,
									commandName,
									target: { browserSessionId: target.browserSessionId, tabId: target.tabId! },
									timeoutMs,
									signal: operationSignal,
									visualBinding,
									beforeVisual,
									actionAt,
								}),
						})
					: { result: await dispatch({ signal }) };
				const visual = outcome.extra;
				const visualSaved = visual?.capture
					? await saveBuffer(
							visual.capture.buffer,
							resolveArtifactPath(ctx, undefined, artifactFallbackName("visual-effect", "png")),
							visual.capture.mime,
						)
					: undefined;
				if (visualSaved) void pruneObservationArtifacts(visualSaved.path);
				const visualResourceUri = visualSaved
					? artifactResourceUri(visualSaved.path, ctx?.cwd ?? process.cwd())
					: undefined;
				const effect =
					outcome.effect && visual?.effect
						? {
								...outcome.effect,
								visual: {
									...visual.effect,
									...(visualResourceUri ? { resourceUri: visualResourceUri } : {}),
								},
							}
						: outcome.effect;
				return jsonResult(
					verifiedWriteValue(outcome, effect),
					{ mode: "command", command: commandName, ...(visualSaved ? { saved: visualSaved } : {}) },
					{ preserveBodyFields: commandName === "network.body" },
				);
			});
		},
	});
}
