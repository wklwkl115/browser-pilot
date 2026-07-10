// frame.js - Browser Pilot frame commands.

import { BROWSER_PILOT_ERROR_CODES, normalizePersistentBrowserPilotResponse, browserPilotError, browserPilotPersistentCdp } from "./runtimeSupport.js";
import type { JsonRecord, BrowserPilotBridgeCommand, BrowserPilotBridgeResponse } from "./types";

type FrameCdpMethod = "frameTree" | "evaluateInFrame" | "addNewDocumentScript" | "removeNewDocumentScript";
type FrameHandler = (cmd: string, tabId: number, msg: BrowserPilotBridgeCommand) => Promise<BrowserPilotBridgeResponse>;

function frameOptions(msg: BrowserPilotBridgeCommand): JsonRecord {
	return msg.options && typeof msg.options === "object" ? { ...msg.options as JsonRecord } : {};
}

function frameError(message: string, details: JsonRecord = {}): BrowserPilotBridgeResponse {
	return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, message, details);
}

function newDocumentOptions(msg: BrowserPilotBridgeCommand): JsonRecord {
	const options: JsonRecord = { ...frameOptions(msg), persistent: true, name: "new_document" };
	if (msg.timeoutMs !== undefined || msg.timeout_ms !== undefined) options.timeoutMs = msg.timeoutMs ?? msg.timeout_ms;
	return options;
}

async function callFrameCdp(
	cmd: string,
	method: FrameCdpMethod,
	args: unknown[],
	project: (data: JsonRecord) => JsonRecord,
): Promise<BrowserPilotBridgeResponse> {
	const operation = browserPilotPersistentCdp()?.[method];
	if (typeof operation !== "function") return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, "Persistent CDP bridge is not loaded", { cmd });
	const response = normalizePersistentBrowserPilotResponse(await (operation as (...values: unknown[]) => Promise<BrowserPilotBridgeResponse>)(...args));
	return response.ok && response.data ? { ok: true, data: project(response.data as JsonRecord) } : response;
}

const frameHandlers: Record<string, FrameHandler> = {
	"frame.list": (cmd, tabId, msg) => callFrameCdp(cmd, "frameTree", [tabId, frameOptions(msg)], (data) => {
		const frames = Array.isArray(data.frames) ? data.frames : [];
		return { tabId, frameTree: data.frameTree || null, frames, count: frames.length };
	}),
	"frame.evaluate": (cmd, tabId, msg) => {
		if (!msg.frameId) return Promise.resolve(frameError("frame.evaluate requires frameId"));
		const options: JsonRecord = { ...frameOptions(msg), frameId: String(msg.frameId), awaitPromise: msg.awaitPromise !== false };
		if (msg.grantUniversalAccess !== undefined) options.grantUniversalAccess = Boolean(msg.grantUniversalAccess);
		if (msg.returnByValue !== undefined) options.returnByValue = msg.returnByValue !== false;
		if (msg.userGesture !== undefined) options.userGesture = Boolean(msg.userGesture);
		if (msg.worldName !== undefined) options.worldName = String(msg.worldName || "");
		return callFrameCdp(cmd, "evaluateInFrame", [tabId, String(msg.expression || ""), options], (data) => ({ tabId, frameId: String(msg.frameId), ...data }));
	},
	"frame.addNewDocumentScript": (cmd, tabId, msg) => {
		if (!msg.source) return Promise.resolve(frameError("frame.addNewDocumentScript requires source"));
		const options = newDocumentOptions(msg);
		if (msg.runImmediately !== undefined) options.runImmediately = Boolean(msg.runImmediately);
		if (msg.worldName !== undefined) options.worldName = String(msg.worldName || "");
		if (msg.includeCommandLineAPI !== undefined) options.includeCommandLineAPI = Boolean(msg.includeCommandLineAPI);
		return callFrameCdp(cmd, "addNewDocumentScript", [tabId, String(msg.source), options], (data) => ({ tabId, ...data }));
	},
	"frame.removeNewDocumentScript": (cmd, tabId, msg) => {
		if (!msg.identifier) return Promise.resolve(frameError("frame.removeNewDocumentScript requires identifier"));
		return callFrameCdp(cmd, "removeNewDocumentScript", [tabId, String(msg.identifier), newDocumentOptions(msg)], (data) => ({ tabId, ...data }));
	},
};

async function handleBrowserPilotFrameCommand(cmd: string, tabId: number, msg: BrowserPilotBridgeCommand): Promise<BrowserPilotBridgeResponse> {
	const handler = frameHandlers[cmd];
	return handler ? handler(cmd, tabId, msg) : frameError(`Unknown Browser Pilot frame command: ${cmd}`, { cmd });
}

export { handleBrowserPilotFrameCommand };
// ESM module metadata
export const __browserPilotBridgeModule_frame = { name: "frame", symbols: { handleBrowserPilotFrameCommand } };
