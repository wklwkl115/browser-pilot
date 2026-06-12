import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type { BrowserBridgeServer } from "../driver/BrowserBridgeServer.js";
import type { BridgeCommand } from "../protocol/nativeProtocol.js";
import { tryJson } from "../utils/json.js";
import { isRecord } from "../utils/records.js";
export { asPositiveInt } from "../utils/params.js";

export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
export const DEFAULT_OBSERVATION_TIMEOUT_MS = 35_000;

export type EnsureStarted = () => Promise<BrowserBridgeServer>;
export type MemoryResultResourceResolution = { ok: true; path: string; etag?: string; bytes?: number } | { ok: false; code: string; error: string };
export type MemoryResultResourceResolver = (uri: string) => Promise<MemoryResultResourceResolution>;
export type ToolRegistrarContext = {
	pi: ExtensionAPI;
	ensureStarted: EnsureStarted;
	memoryEvidenceResolver?: MemoryResultResourceResolver;
};

export type ToolRegistrar = (context: ToolRegistrarContext) => void;

export function parseMaybeCommand(script: string): BridgeCommand | undefined {
	const trimmed = script.trim();
	if (!trimmed.startsWith("{")) return undefined;
	const parsed = tryJson(trimmed);
	return isRecord(parsed) && typeof parsed.cmd === "string" ? parsed as BridgeCommand : undefined;
}

export function objectParam(value: unknown): Record<string, unknown> {
	return isRecord(value) ? { ...value } : {};
}

export const NativeStringList = Type.Array(Type.String());
export const NativeCommandParamsSchema = Type.Object({}, { additionalProperties: true });

export const TAB_SCOPED_TOOL_GUIDELINE = "For automation, call browser_tabs list/switch to pick a target tab. A tabId is NOT stable — it changes when the tab navigates, reloads, or is replaced — so do not cache one across navigations: re-read it from browser_tabs or the navigation result, or omit tabId to use the selected/active tab. Pass an explicit tabId mainly to disambiguate when several tabs are open.";
export const TAB_ID_DESCRIPTION = "Target tab id. Not stable across navigation/reload — re-resolve via browser_tabs or omit to use the selected/active tab; pass explicitly mainly to disambiguate multiple open tabs.";
export const DETAIL_LEVEL_DESCRIPTION = "Deprecated compatibility only; stripped before tool validation. Current summaries use tool-specific budgets and artifact handles.";
export const OUTPUT_PATH_DESCRIPTION = "Deprecated compatibility only; stripped before tool validation. Full raw evidence is saved by tool-managed artifacts when needed.";
export const MAX_CHARS_DESCRIPTION = "Deprecated compatibility only; stripped before tool validation. Current tools use committed per-tool budgets.";

function enumLiteralSchemas<const TValue extends readonly [string, string, ...string[]]>(values: TValue): [TSchema, TSchema, ...TSchema[]] {
	return values.map((value) => Type.Literal(value)) as unknown as [TSchema, TSchema, ...TSchema[]];
}

export function strictToolParameters<T extends Record<string, TSchema>>(properties: T) {
	return Type.Object(properties, { additionalProperties: false });
}

export function enumParam<const TValue extends readonly [string, string, ...string[]]>(values: TValue, description: string) {
	return Type.Optional(Type.Union(enumLiteralSchemas(values), { description }));
}

export function enumOrEnumArrayParam<const TValue extends readonly [string, string, ...string[]]>(values: TValue, description: string) {
	const valueUnion = Type.Union(enumLiteralSchemas(values));
	return Type.Optional(Type.Union([valueUnion, Type.Array(valueUnion)], { description }));
}

export function optionalTargetTabId(description = TAB_ID_DESCRIPTION) {
	return Type.Optional(Type.Union([Type.Number(), Type.String()], { description }));
}
