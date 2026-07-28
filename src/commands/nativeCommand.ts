import { Type } from "typebox";
import { resolveExecutionRef, type ExecutionRefTarget } from "../browser-command-runtime/executionRef.js";
import { prepareAbmlVerification, recordAbmlActionContext } from "../browser-command-runtime/abml/verification.js";
import { BrowserBridgeError } from "../utils/errors.js";
import { jsonResult } from "../utils/toolResult.js";
import { withBrowserOperation } from "./browserOperation.js";
import { withCommandEffect, type CommandEffect } from "./commandEffect.js";
import { commandExpectationSchema, javascriptVerificationResult, prepareCommandExpectation } from "./commandExpectation.js";
import { defineBrowserCommand, pinTabExecutionTarget, resolveRefExecutionTarget, runCommandHandler, sharedTabScopedToolParams, targetTabId } from "./commandRuntime.js";
import { DEFAULT_TOOL_TIMEOUT_MS, strictCommandParameters } from "./commandShared.js";
import type { CommandRegistrarContext } from "./commandShared.js";
import { validateBridgeCommand, type BridgeCommand } from "../types/nativeProtocol.js";
import { isNativeTabScopedCommand, isNativeWriteCommand, isPublicNativeCommand, nativeCommandOwner, publicNativeCommandNames } from "./nativeCommandAccess.js";
import { isRecord } from "../utils/records.js";
import { registerVisualTargetRef } from "./visualEvidence.js";
import { captureVisualScreenshot, visualFingerprintMatches, type VisualScreenshotCapture } from "./visualEvidence.js";
import { readPageFingerprint } from "./pageSignals.js";
import { artifactFallbackName, artifactResourceUri, pruneObservationArtifacts, resolveArtifactPath, saveBuffer } from "../artifacts/artifactFiles.js";
import type { RefVisualBinding } from "../kernels/refs/types.js";
import type { VerificationResult } from "../kernels/abml/types.js";
import type { BrowserBridgeExecutionResult } from "../ports/BrowserRuntimeTypes.js";

const nativeCommandNames = publicNativeCommandNames();

type NativeCommandOutcome = {
	result: BrowserBridgeExecutionResult;
	effect?: CommandEffect;
	verification?: VerificationResult;
	visualCapture?: VisualScreenshotCapture;
	visualEffect?: NonNullable<CommandEffect["visual"]>;
};

async function preflightVisualInput(options: {
	server: Awaited<ReturnType<CommandRegistrarContext["ensureStarted"]>>;
	binding: RefVisualBinding;
	browserSessionId?: string;
	tabId: number;
	timeoutMs: number;
	signal: AbortSignal;
}): Promise<VisualScreenshotCapture> {
	if (!options.binding.actionableGrounding) throw new BrowserBridgeError("INVALID_RULE", "This visual observation is not trusted for live actions", { captureMethod: options.binding.captureMethod });
	const fingerprint = await readPageFingerprint(options.server, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs, signal: options.signal });
	if (!visualFingerprintMatches(options.binding, fingerprint)) throw new BrowserBridgeError("REF_STALE", "Visual observation basis changed before input dispatch", { refObservationId: options.binding.anchor?.hostRef });
	const screenshot = await captureVisualScreenshot(options.server, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs, signal: options.signal });
	if (!screenshot || screenshot.sha256 !== options.binding.sha256 || screenshot.width !== options.binding.width || screenshot.height !== options.binding.height) {
		// ponytail: strict full-frame equality; add ROI decoding only if rejection telemetry proves this too conservative.
		throw new BrowserBridgeError("REF_STALE", "Visual pixels changed before input dispatch", { observationId: options.binding.anchor?.hostRef });
	}
	const finalFingerprint = await readPageFingerprint(options.server, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs, signal: options.signal });
	if (!visualFingerprintMatches(options.binding, finalFingerprint)) throw new BrowserBridgeError("REF_STALE", "Visual observation basis changed during input preflight", { refObservationId: options.binding.anchor?.hostRef });
	return screenshot;
}

function prepareNativeRef(command: BridgeCommand): { command: BridgeCommand; refs: ExecutionRefTarget[] } {
	if (command.cmd !== "input.ref") return { command, refs: [] };
	if (typeof command.ref !== "string" || !command.ref.startsWith("bp-ref://")) {
		throw new BrowserBridgeError("INVALID_REF_TARGET", "input.ref requires a bp-ref URI in ref", { ref: command.ref });
	}
	let resolved = resolveExecutionRef(command.ref);
	if (!resolved.target.fresh) throw new BrowserBridgeError("REF_STALE", "Referenced evidence was modified after observation", { ref: command.ref });
	const visualInput = isRecord(command.visual) ? command.visual : undefined;
	if (resolved.descriptor.visual) {
		const point = isRecord(visualInput?.point) ? { x: Number(visualInput.point.x), y: Number(visualInput.point.y) } : undefined;
		const to = isRecord(visualInput?.to) ? { x: Number(visualInput.to.x), y: Number(visualInput.to.y) } : undefined;
		if (!visualInput || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
			throw new BrowserBridgeError("INVALID_REF_TARGET", "Visual input.ref requires a normalized point", { ref: command.ref });
		}
		const action = String(command.action || "");
		if (action === "drag" && !to) throw new BrowserBridgeError("INVALID_RULE", "Visual input.ref drag requires visual.to", { ref: command.ref });
		if (action === "type" && typeof command.text !== "string") throw new BrowserBridgeError("INVALID_RULE", "Visual input.ref type requires text", { ref: command.ref });
		const visualRef = registerVisualTargetRef(resolved.descriptor, point, to);
		resolved = resolveExecutionRef(visualRef);
		command = { ...command, ref: visualRef };
	} else {
		if (visualInput) throw new BrowserBridgeError("INVALID_REF_TARGET", "visual input requires a visual observation ref", { ref: command.ref });
		if (command.action !== "click") throw new BrowserBridgeError("INVALID_RULE", "Non-visual input.ref targets currently support click only", { action: command.action });
	}
	const { refId, kind, backendNodeId, targetId, point, locators, semantic, visual } = resolved.target;
	const target = { refId, kind, ...(backendNodeId !== undefined ? { backendNodeId } : {}), ...(targetId ? { targetId } : {}), ...(point ? { point } : {}), locators, ...(semantic ? { semantic } : {}), ...(visual ? { visual } : {}) };
	return { command: { ...command, target }, refs: [resolved.target] };
}

export function defineNativeCommand({ commands, ensureStarted }: CommandRegistrarContext) {
	defineBrowserCommand(commands, {
		name: "browser_command",
		label: "Browser Command",
		description: "Run one validated native browser command in the selected or ref-owning tab. Writes may return effect and verification evidence.",
		promptGuidelines: [
			"Read browser-pilot://native-command/<cmd> only when an unfamiliar native command's fields are needed.",
			"For raw CDP, pass command={cmd:'cdp',method:'Domain.method',params:{...}}; Browser Pilot owns attach, reuse, recovery, and cleanup.",
			"For a trusted physical click, use command={cmd:'input.ref',action:'click',ref:'bp-ref://...'}; Browser Pilot resolves its tab and private CDP target.",
			"For screenshot-grounded input, use browser_observe visual.ref with a normalized visual.point; do not convert it to raw input.pointer coordinates.",
			"For tab-scoped writes, expect may declare a JavaScript truth expression or structured ref/state postcondition; Browser Pilot owns settlement and verification.",
		],
		parameters: strictCommandParameters({
			command: Type.Object({
				cmd: Type.String({ enum: nativeCommandNames, description: "Canonical native command name from browser-pilot://native-commands." }),
			}, { additionalProperties: true, description: "Validated native bridge command object." }),
			expect: Type.Optional(commandExpectationSchema),
			...sharedTabScopedToolParams(),
		}),
		async execute(params, signal, ctx) {
			return await runCommandHandler(async () => {
				if (!params.command || typeof params.command !== "object" || Array.isArray(params.command)) throw new BrowserBridgeError("INVALID_RULE", "browser_command requires command object", { commandName: "browser_command" });
				const protocol = validateBridgeCommand(params.command, { allowMissingTabId: true, publicCall: true });
				if (!protocol.ok) throw new BrowserBridgeError("INVALID_BROWSER_COMMAND", protocol.error, protocol.details);
				const owner = nativeCommandOwner(protocol.command);
				if (owner) throw new BrowserBridgeError("INVALID_RULE", `${String(protocol.command.cmd)} must be invoked through ${owner}`, { commandName: "browser_command", useTool: owner });
				if (!isPublicNativeCommand(protocol.command)) throw new BrowserBridgeError("INVALID_RULE", `${String(protocol.command.cmd)} is not a public native command`, { commandName: "browser_command", catalog: "browser-pilot://native-commands" });
				const prepared = prepareNativeRef(protocol.command);
				const command = prepared.command;
				const write = isNativeWriteCommand(command);
				const expect = prepareCommandExpectation(params.expect, "browser_command");
				if (expect && !write) throw new BrowserBridgeError("INVALID_RULE", "browser_command expect is only valid for writes", { commandName: "browser_command" });
				const server = await ensureStarted();
				const timeoutMs = DEFAULT_TOOL_TIMEOUT_MS;
				const rawTarget = targetTabId(params, command);
				const expectationRefs = expect?.kind === "abml" ? [resolveExecutionRef(expect.expectation.ref).target] : [];
				const resolvedTarget = resolveRefExecutionTarget(server, prepared.refs, { rawTarget, observedRefs: expectationRefs });
				const target = isNativeTabScopedCommand(command) ? pinTabExecutionTarget(server, resolvedTarget) : resolvedTarget;
				if (expect && target.tabId === undefined) throw new BrowserBridgeError("INVALID_RULE", "browser_command expect requires a tab-scoped write", { commandName: "browser_command" });
				const commandName = String(command.cmd || "");
				const dispatch = ({ signal: dispatchSignal }: { signal?: AbortSignal }) => server.sendCommand(command, {
					browserSessionId: target.browserSessionId,
					tabId: target.rawTarget,
					timeoutMs,
					accessMode: write ? "write" : "read",
					signal: dispatchSignal,
				});
				const dispatchWrite = async ({ signal: operationSignal, deadlineAt }: { signal: AbortSignal; deadlineAt: number }): Promise<NativeCommandOutcome> => {
					let actionAt: number | undefined;
					const run = () => {
						if (command.cmd === "input.ref") actionAt = Date.now();
						return dispatch({ signal: operationSignal });
					};
					if (target.tabId === undefined) return { result: await run() };
					const visualBinding = prepared.refs[0]?.visual;
					const beforeVisual = visualBinding ? await preflightVisualInput({ server, binding: visualBinding, browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs, signal: operationSignal }) : undefined;
					const structured = expect?.kind === "abml" ? expect.expectation : undefined;
					const abmlVerification = structured ? await prepareAbmlVerification({ server, expectation: structured, verb: commandName, browserSessionId: target.browserSessionId, tabId: target.tabId, rawTarget: target.rawTarget!, timeoutMs, signal: operationSignal }) : undefined;
					const initialVerification = abmlVerification?.initialVerification ?? (expect?.kind === "javascript" ? javascriptVerificationResult(commandName) : undefined);
					const effected = await withCommandEffect(server, {
						browserSessionId: target.browserSessionId,
						tabId: target.tabId,
						timeoutMs,
						deadlineAt,
						signal: operationSignal,
						...(initialVerification ? { initialVerification } : {}),
						...(expect?.kind === "javascript" ? { verify: async () => javascriptVerificationResult(commandName, (await server.executeJavaScript(`return Boolean(await (${expect.expression}));`, { browserSessionId: target.browserSessionId, tabId: target.rawTarget, timeoutMs, accessMode: "read", signal: operationSignal })).data === true) } : {}),
						...(abmlVerification ? { verify: abmlVerification.verify } : {}),
					}, run);
					const afterVisual = visualBinding
						? await captureVisualScreenshot(server, { browserSessionId: target.browserSessionId, tabId: target.tabId, timeoutMs, signal: operationSignal }).catch(() => {
							operationSignal.throwIfAborted();
							return undefined;
						})
						: undefined;
					if (command.cmd === "input.ref" && typeof command.ref === "string") {
						recordAbmlActionContext({ server, browserSessionId: target.browserSessionId, tabId: target.tabId, ref: command.ref, verb: commandName, at: actionAt ?? Date.now() });
					}
					return {
						...effected,
						...(visualBinding ? {
							visualCapture: afterVisual,
							visualEffect: {
								observed: !!afterVisual,
								changed: afterVisual ? afterVisual.sha256 !== beforeVisual?.sha256 : null,
								...(beforeVisual ? { beforeSha256: beforeVisual.sha256 } : {}),
								...(afterVisual ? { afterSha256: afterVisual.sha256 } : {}),
							},
						} : {}),
					};
				};
				const outcome: NativeCommandOutcome = write
					? await withBrowserOperation({ server, browserSessionId: target.browserSessionId, tabId: target.tabId, targetRef: target.rawTarget, timeoutMs, signal }, dispatchWrite)
					: { result: await dispatch({ signal }) };
				const visualSaved = outcome.visualCapture
					? await saveBuffer(outcome.visualCapture.buffer, resolveArtifactPath(ctx, undefined, artifactFallbackName("visual-effect", "png")), outcome.visualCapture.mime)
					: undefined;
				if (visualSaved) void pruneObservationArtifacts(visualSaved.path);
				const visualResourceUri = visualSaved ? artifactResourceUri(visualSaved.path, ctx?.cwd ?? process.cwd()) : undefined;
				const effect = outcome.effect
					? { ...outcome.effect, ...(outcome.visualEffect ? { visual: { ...outcome.visualEffect, ...(visualResourceUri ? { resourceUri: visualResourceUri } : {}) } } : {}) }
					: undefined;
				const value = {
					result: outcome.result.data ?? null,
					...(effect ? { effect } : {}),
					...(outcome.verification ? { verification: outcome.verification } : {}),
				};
				return jsonResult(value, { mode: "command", command: commandName, ...(visualSaved ? { saved: visualSaved } : {}) }, { preserveBodyFields: commandName === "network.body" });
			});
		},
	});
}
