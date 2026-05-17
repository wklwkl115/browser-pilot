import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BrowserBridgeServer } from "../driver/BrowserBridgeServer";
import type { BridgeCommand } from "../protocol/nativeProtocol";
export { asPositiveInt } from "../utils/params";

export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;

export type EnsureStarted = () => Promise<BrowserBridgeServer>;
export type ToolRegistrarContext = {
	pi: ExtensionAPI;
	ensureStarted: EnsureStarted;
};

export function parseMaybeCommand(script: string): BridgeCommand | undefined {
	const trimmed = script.trim();
	if (!trimmed.startsWith("{")) return undefined;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>).cmd === "string" ? parsed as BridgeCommand : undefined;
	} catch {
		return undefined;
	}
}

export function objectParam(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

export const NativeStringList = Type.Array(Type.String());
export const NativeCommandParamsSchema = Type.Object({}, { additionalProperties: true });

export const TAB_SCOPED_TOOL_GUIDELINE = "For automation, call browser_tabs list or switch first, keep the target tabId, and pass that tabId explicitly to every tab-scoped browser_* call; omitted tabId uses the mutable selected/active tab fallback.";
export const TAB_ID_DESCRIPTION = "Target tab id. For automation, pass explicitly after browser_tabs list/switch; omitted uses mutable selected/active tab fallback.";
export const DETAIL_LEVEL_DESCRIPTION = "summary | preview | full; summary is default to reduce token usage";
export const OUTPUT_PATH_DESCRIPTION = "Optional artifact output path for full raw results";
export const MAX_CHARS_DESCRIPTION = "Maximum characters returned to the model";

export function optionalTargetTabId(description = TAB_ID_DESCRIPTION) {
	return Type.Optional(Type.Union([Type.Number(), Type.String()], { description }));
}
