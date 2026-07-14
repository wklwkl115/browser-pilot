import { canonicalBridgeCommand, getNativeCommandProtocolSchema, type BridgeCommand } from "../types/nativeProtocol.js";
import type { BrowserOperationEvent, BrowserOperationStatus } from "../kernels/session/browserOperation.js";
import { isRecord } from "../utils/records.js";

export type BrowserOperationCompletion = { source: string; evidence: Record<string, unknown> };
export type BrowserOperationDispatchTerminal = {
	status: Extract<BrowserOperationStatus, "ambiguous" | "deadline" | "failed">;
	diagnostics: Array<Record<string, unknown>>;
};

export type BrowserOperationResolverInput = {
	commandName: string;
	command?: string;
	action?: string;
	mode?: "javascript" | "program";
	physicalProgram?: boolean;
	postcondition?: boolean;
	result?: unknown;
	events: BrowserOperationEvent[];
};

function bridgeData(value: unknown): unknown {
	return isRecord(value) && Object.prototype.hasOwnProperty.call(value, "data") ? value.data : value;
}

function scriptResult(value: unknown): unknown {
	const result = bridgeData(value);
	return result === "[undefined]" ? undefined : result;
}

function programResult(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) && Array.isArray(value.frames) ? value : undefined;
}

function programFrames(value: Record<string, unknown>): Array<Record<string, unknown>> {
	return (value.frames as unknown[]).filter(isRecord);
}

function physicalFrame(frame: Record<string, unknown>): boolean {
	const kind = String(frame.kind || "");
	return kind === "text" || kind.startsWith("mouse:") || kind.startsWith("key:");
}

function hasPhysicalFrame(value: Record<string, unknown>): boolean {
	return programFrames(value).some(physicalFrame);
}

function acknowledgedPhysicalFrame(value: Record<string, unknown>): boolean {
	return programFrames(value).some((frame) => physicalFrame(frame) && frame.acknowledged === true);
}

function successfulAcknowledgedPhysicalFrame(value: Record<string, unknown>): boolean {
	return programFrames(value).some((frame) => physicalFrame(frame) && frame.ok === true && frame.acknowledged === true);
}

function programFrameSummary(frame: Record<string, unknown>): Record<string, unknown> {
	return {
		step: frame.step,
		kind: frame.kind,
		ok: frame.ok,
		...(frame.acknowledged !== undefined ? { acknowledged: frame.acknowledged } : {}),
		...(frame.durationMs !== undefined ? { durationMs: frame.durationMs } : {}),
		...(frame.eventCount !== undefined ? { eventCount: frame.eventCount } : {}),
		...(isRecord(frame.resolved) ? { resolved: frame.resolved } : {}),
		...(typeof frame.error === "string" ? { error: frame.error.slice(0, 160) } : {}),
		...(isRecord(frame.verification) ? { verification: { passed: frame.verification.passed === true } } : {}),
	};
}

export function summarizeBrowserOperationDispatch(input: BrowserOperationResolverInput): Record<string, unknown> | undefined {
	if (input.commandName !== "browser_execute" || input.mode !== "program") return undefined;
	const result = programResult(input.result);
	if (!result) return undefined;
	const verification = isRecord(result.verification) ? result.verification : undefined;
	const aborted = isRecord(result.aborted) ? result.aborted : undefined;
	return {
		code: "PROGRAM_DISPATCH_SUMMARY",
		acknowledged: result.acknowledged === true,
		frameCount: programFrames(result).length,
		frames: programFrames(result).slice(0, 60).map(programFrameSummary),
		...(verification ? { verification: { step: verification.step, passed: verification.passed === true } } : {}),
		...(aborted ? { aborted: { reason: String(aborted.reason || "program aborted").slice(0, 160), atStep: aborted.atStep, ...(typeof aborted.newUrl === "string" ? { navigated: true } : {}) } } : {}),
	};
}

export function resolveBrowserOperationDispatchTerminal(input: BrowserOperationResolverInput): BrowserOperationDispatchTerminal | undefined {
	return scriptPostconditionTerminal(input) ?? programDispatchTerminal(input);
}

function programDispatchTerminal(input: BrowserOperationResolverInput): BrowserOperationDispatchTerminal | undefined {
	if (input.commandName !== "browser_execute" || input.mode !== "program") return undefined;
	const result = programResult(input.result);
	if (!result) return undefined;
	const aborted = isRecord(result.aborted) ? result.aborted : undefined;
	if (aborted && String(aborted.reason || "") !== "navigation") {
		const partial = acknowledgedPhysicalFrame(result);
		const timeout = /timeout/i.test(String(aborted.reason || ""));
		return {
			status: partial ? "ambiguous" : timeout ? "deadline" : "failed",
			diagnostics: [{
				code: partial ? "PROGRAM_PARTIAL_DISPATCH" : timeout ? "PROGRAM_DEADLINE" : "PROGRAM_ABORTED",
				message: partial ? "A physical input frame was acknowledged before the program aborted; verify page state before any further mutation." : String(aborted.reason || "Program aborted"),
				atStep: aborted.atStep,
			}],
		};
	}
	const verification = isRecord(result.verification) ? result.verification : undefined;
	if (verification && verification.passed !== true) {
		return {
			status: input.physicalProgram || hasPhysicalFrame(result) ? "ambiguous" : "failed",
			diagnostics: [{
				code: "PROGRAM_VERIFICATION_FAILED",
				message: "The explicit final program verifier did not prove its postcondition.",
				step: verification.step,
			}],
		};
	}
	return undefined;
}

function scriptPostconditionTerminal(input: BrowserOperationResolverInput): BrowserOperationDispatchTerminal | undefined {
	if (input.commandName !== "browser_execute" || input.mode !== "javascript" || !input.postcondition) return undefined;
	const verification = isRecord(input.result) && isRecord(input.result.businessVerification) ? input.result.businessVerification : undefined;
	if (!verification || verification.passed === true) return undefined;
	return {
		status: "ambiguous",
		diagnostics: [{
			code: "BUSINESS_POSTCONDITION_FAILED",
			message: "The script action was dispatched, but its declared business postcondition did not pass. Observe current page state before any further mutation.",
		}],
	};
}

function findFileEvidence(value: unknown): Record<string, unknown> | undefined {
	const data = bridgeData(value);
	if (!isRecord(data)) return undefined;
	const download = isRecord(data.download) ? data.download : data;
	const path = download.filePath ?? download.filename ?? download.path ?? download.finalPath;
	const state = download.state ?? download.status;
	if (typeof path !== "string" || !path || (typeof state === "string" && !/complete|completed|success/i.test(state))) return undefined;
	return { path, ...(state ? { state } : {}) };
}

function nativeCompletionSource(command: string): string | undefined {
	const sourceByCommand: Array<[RegExp, string]> = [
		[/^batch$/, "batch-completed"],
		[/^tabs(?:\.(?:create|switch|close))?$/, "tab-lifecycle"],
		[/^transfer\.download$/, "download-completed"],
		[/^transfer\.upload$/, "upload-applied"],
		[/^network\.start$/, "network-recorder-armed"],
		[/^network\.stop$/, "network-recorder-flushed"],
		[/^network\.captureReload$/, "network-capture-completed"],
		[/^network\.(?:clear)$/, "network-recorder-updated"],
		[/^hook\.(?:install|install_targets|clear|clear_buffer|pause|resume|uninstall|addEventListener|removeEventListener)$/, "hook-lifecycle"],
		[/^frame\.(?:evaluate|addNewDocumentScript|removeNewDocumentScript)$/, "frame-command-result"],
		[/^(?:input\.|cdp$|persistent_cdp$)/, "native-command-result"],
		[/^(?:management|intercept\.|ws\.)/, "native-command-result"],
	];
	return sourceByCommand.find(([pattern]) => pattern.test(command))?.[1];
}

function nativeCompletion(command: string, result: unknown): BrowserOperationCompletion | undefined {
	const source = nativeCompletionSource(command);
	if (!source) return undefined;
	if (command === "transfer.download") {
		const file = findFileEvidence(result);
		return file ? { source, evidence: file } : undefined;
	}
	const data = bridgeData(result);
	if ((command === "batch" || command === "network.captureReload") && isRecord(data) && Array.isArray(data.results)) {
		if (!data.results.length || data.results.some((item) => !isRecord(item) || item.ok !== true)) return undefined;
	}
	return data === undefined ? undefined : { source, evidence: { command, result: data } };
}

function executeCompletion(input: BrowserOperationResolverInput): BrowserOperationCompletion | undefined {
	return input.mode === "javascript" && input.postcondition ? scriptPostconditionCompletion(input.result) : mechanicalExecuteCompletion(input);
}

function mechanicalExecuteCompletion(input: BrowserOperationResolverInput): BrowserOperationCompletion | undefined {
	const navigation = [...input.events].reverse().find((event) => event.type === "navigation_completed" || (event.type === "navigation" && (event.data?.phase === "complete" || event.data?.phase === "Page.lifecycleEvent" && event.data?.name === "load")));
	const download = [...input.events].reverse().find((event) => event.type === "download_completed");
	if (download) return { source: "download-completed", evidence: { event: download.data } };
	if (navigation) return { source: input.events.some((event) => event.type === "new_tab") ? "new-tab-ready" : "navigation-completed", evidence: { event: navigation.data } };
	if (input.mode !== "javascript") {
		const program = programResult(input.result);
		if (!program || isRecord(program.aborted)) return undefined;
		const verification = isRecord(program.verification) ? program.verification : undefined;
		if (input.physicalProgram || hasPhysicalFrame(program)) {
			return program.acknowledged === true && successfulAcknowledgedPhysicalFrame(program) && verification?.passed === true
				? { source: "program-verified", evidence: { verification, result: input.result } }
				: undefined;
		}
		if (verification) return verification.passed === true ? { source: "program-verified", evidence: { verification, result: input.result } } : undefined;
		return { source: "program-resolved", evidence: { result: input.result } };
	}
	const result = scriptResult(input.result);
	return result !== undefined ? { source: "script-resolved", evidence: { result } } : undefined;
}

function scriptPostconditionCompletion(result: unknown): BrowserOperationCompletion | undefined {
	const verification = isRecord(result) && isRecord(result.businessVerification) ? result.businessVerification : undefined;
	return verification?.passed === true
		? { source: "script-postcondition-verified", evidence: { verification: { passed: true, result: verification.result }, result: scriptResult(result) } }
		: undefined;
}

function tabCreateCompletion(result: unknown): BrowserOperationCompletion | undefined {
	const record = isRecord(result) ? result : {};
	const created = isRecord(record.createdTarget) ? record.createdTarget : isRecord(record.target) ? record.target : isRecord(record.data) ? record.data : {};
	const targetRef = created.targetRef ?? created.tabHandle;
	return typeof targetRef === "string" && targetRef ? { source: "tab-create", evidence: { targetRef, tabId: created.tabId, url: created.url } } : undefined;
}

function tabSwitchCompletion(data: unknown): BrowserOperationCompletion | undefined {
	if (!isRecord(data) || data.active !== true) return undefined;
	const selectedTabId = Number(data.selectedTabId ?? data.tabId);
	return Number.isInteger(selectedTabId) && selectedTabId > 0
		? { source: "tab-switch", evidence: { selectedTabId, selectionVersion: data.selectionVersion } }
		: undefined;
}

function tabCloseCompletion(data: unknown): BrowserOperationCompletion | undefined {
	if (!isRecord(data)) return undefined;
	const closedTabId = Number(data.tabId ?? data.id);
	return Number.isInteger(closedTabId) && closedTabId > 0 ? { source: "tab-close", evidence: { tabId: closedTabId } } : undefined;
}

function tabsCompletion(input: BrowserOperationResolverInput): BrowserOperationCompletion | undefined {
	const action = String(input.action || input.command || "").toLowerCase();
	if (action === "create") return tabCreateCompletion(input.result);
	if (action === "switch") return tabSwitchCompletion(bridgeData(input.result));
	if (action === "close") return tabCloseCompletion(bridgeData(input.result));
	return undefined;
}

function uploadCompletion(result: unknown): BrowserOperationCompletion | undefined {
	const data = bridgeData(result);
	if (!isRecord(data) || data.uploaded !== true) return undefined;
	const filesCount = Number(data.files_count);
	if (!Number.isInteger(filesCount) || filesCount <= 0) return undefined;
	return { source: "upload-applied", evidence: { uploaded: true, files_count: filesCount, ...(typeof data.selector === "string" ? { selector: data.selector } : {}) } };
}

function nativeToolCompletion(input: BrowserOperationResolverInput): BrowserOperationCompletion | undefined {
	const prefixes: Record<string, string> = { browser_network: "network", browser_hook: "hook", browser_frame: "frame" };
	const prefix = prefixes[input.commandName];
	if (prefix) return nativeCompletion(String(input.command || `${prefix}.${input.action}`), input.result);
	if (input.commandName !== "browser_command") return undefined;
	if (String(input.command || "") === "tabs") return tabsCompletion(input);
	return nativeCompletion(String(input.command || ""), input.result);
}

export function resolveBrowserOperationCompletion(input: BrowserOperationResolverInput): BrowserOperationCompletion | undefined {
	if (input.commandName === "browser_execute") return executeCompletion(input);
	if (input.commandName === "browser_tabs") return tabsCompletion(input);
	if (input.commandName === "browser_download") {
		const file = findFileEvidence(input.result);
		return file ? { source: "download-completed", evidence: file } : undefined;
	}
	if (input.commandName === "browser_upload") return uploadCompletion(input.result);
	return nativeToolCompletion(input);
}

export function isNativeWriteCommand(command: BridgeCommand): boolean {
	const schema = getNativeCommandProtocolSchema();
	const canonical = canonicalBridgeCommand(String(command.cmd || ""), schema);
	const spec = schema.commands[canonical];
	if (!spec || spec.internal === true) return false;
	const method = String(command.method || command.action || spec.defaultMethod || "").toLowerCase();
	return (spec.methodSpecs?.[method]?.accessMode ?? spec.accessMode) === "write";
}

export function hasBrowserOperationResolver(command: BridgeCommand): boolean {
	if (!isNativeWriteCommand(command)) return true;
	const schema = getNativeCommandProtocolSchema();
	const canonical = canonicalBridgeCommand(String(command.cmd || ""), schema);
	const method = String(command.method || command.action || schema.commands[canonical]?.defaultMethod || "").toLowerCase();
	const effective = canonical === "tabs" && method ? `${canonical}.${method}` : canonical;
	return nativeCompletionSource(effective) !== undefined;
}
