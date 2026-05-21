import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BrowserBridgeServer } from "../driver/BrowserBridgeServer";
import type { BridgeCommand } from "../protocol/nativeProtocol";
export { asPositiveInt } from "../utils/params";

export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
export const DEFAULT_OBSERVATION_TIMEOUT_MS = 35_000;

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

export const TAB_SCOPED_TOOL_GUIDELINE = "For automation, call browser_tabs list or switch first, keep the target tabId, or use target:{orchestrationId,sessionTag,tabRole} after browser_orchestrate has bound the tab; omitted tabId uses the mutable selected/active tab fallback.";
export const TAB_ID_DESCRIPTION = "Target tab id. For automation, pass explicitly after browser_tabs list/switch; omitted uses mutable selected/active tab fallback.";
export const TARGET_DESCRIPTION = "Logical/physical target resolver. Use {orchestrationId,sessionTag,tabRole} to target a tab bound by browser_orchestrate, or {tabId,browserId} for physical disambiguation. Conflicts with top-level tabId are rejected.";
export const DETAIL_LEVEL_DESCRIPTION = "summary | preview | full; summary is default to reduce token usage";
export const OUTPUT_PATH_DESCRIPTION = "Optional artifact output path for full raw results";
export const MAX_CHARS_DESCRIPTION = "Maximum characters returned to the model";

export const BrowserToolTargetRefSchema = Type.Object({
	tabId: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Physical tab id. Conflicts with top-level tabId are rejected." })),
	browserId: Type.Optional(Type.String({ description: "Browser client or extension id used to disambiguate physical tab ids." })),
	orchestrationId: Type.Optional(Type.String({ description: "browser_orchestrate orchestration id for logical session/role lookup." })),
	sessionTag: Type.Optional(Type.String({ description: "browser_orchestrate session tag." })),
	tabRole: Type.Optional(Type.String({ description: "browser_orchestrate tab role within the session." })),
	windowId: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Reserved for future window-level target resolution." })),
	groupId: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Reserved for future tabGroups target resolution." })),
	profileId: Type.Optional(Type.String({ description: "Reserved for future managed browser profile target resolution." })),
	requireOwned: Type.Optional(Type.Boolean({ description: "When true, logical orchestration targets must resolve to an owned binding." })),
}, { additionalProperties: false, description: TARGET_DESCRIPTION });

export function optionalTargetTabId(description = TAB_ID_DESCRIPTION) {
	return Type.Optional(Type.Union([Type.Number(), Type.String()], { description }));
}
