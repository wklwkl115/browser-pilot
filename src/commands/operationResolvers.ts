import { canonicalBridgeCommand, getNativeCommandProtocolSchema, type BridgeCommand } from "../types/nativeProtocol.js";
import type { BrowserOperationEvent } from "../kernels/session/browserOperation.js";
import { isRecord } from "../utils/records.js";

export type BrowserOperationCompletion = { source: string; evidence: Record<string, unknown> };

export type BrowserOperationResolverInput = {
	commandName: string;
	command?: string;
	action?: string;
	mode?: "javascript" | "program";
	physicalProgram?: boolean;
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
	const navigation = [...input.events].reverse().find((event) => event.type === "navigation_completed" || (event.type === "navigation" && (event.data?.phase === "complete" || event.data?.phase === "Page.lifecycleEvent" && event.data?.name === "load")));
	const download = [...input.events].reverse().find((event) => event.type === "download_completed");
	if (download) return { source: "download-completed", evidence: { event: download.data } };
	if (navigation) return { source: input.events.some((event) => event.type === "new_tab") ? "new-tab-ready" : "navigation-completed", evidence: { event: navigation.data } };
	if (input.mode !== "javascript") return input.physicalProgram ? undefined : { source: "program-resolved", evidence: { result: input.result } };
	const result = scriptResult(input.result);
	return result !== undefined ? { source: "script-resolved", evidence: { result } } : undefined;
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
