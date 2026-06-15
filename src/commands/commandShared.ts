import { Type, type TSchema } from "typebox";
import type { BrowserBridgeServer } from "../bridge/server/BrowserBridgeServer.js";
import type { BridgeCommand } from "../bridge/protocol/nativeProtocol.js";
import { tryJson } from "../utils/json.js";
import { isRecord } from "../utils/records.js";
import type { BrowserCommandSink } from "./commandDefinition.js";
export { asPositiveInt } from "../utils/params.js";

export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
export const DEFAULT_OBSERVATION_TIMEOUT_MS = 35_000;

export type EnsureStarted = () => Promise<BrowserBridgeServer>;
export type MemoryResultResourceResolution = { ok: true; path: string; etag?: string; bytes?: number } | { ok: false; code: string; error: string };
export type MemoryResultResourceResolver = (uri: string) => Promise<MemoryResultResourceResolution>;
export type CommandRegistrarContext = {
	commands: BrowserCommandSink;
	ensureStarted: EnsureStarted;
	memoryEvidenceResolver?: MemoryResultResourceResolver;
};

export type CommandRegistrar = (context: CommandRegistrarContext) => void;

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

export const TAB_SCOPED_TOOL_GUIDELINE = "For automation, call browser_tabs list to get a stable tabHandle/targetRef, or reuse browser_tabs create id/targetRef directly. Omit targetRef/tabId to use the selected active tab; pass an explicit target mainly to disambiguate several open tabs. Numeric tabId remains accepted for compatibility and auto-follows unambiguous Chrome replacement chains.";
export const TAB_ID_DESCRIPTION = "Compatibility target: numeric tabId or stable tabHandle string. Prefer targetRef/tabHandle from browser_tabs list; omit to use the selected active tab.";
export const TARGET_REF_DESCRIPTION = "Stable target reference from browser_tabs list/create (tabHandle). Preferred over numeric tabId because it survives unambiguous in-place tab replacement.";
export const DETAIL_LEVEL_DESCRIPTION = "Deprecated compatibility only; stripped before tool validation. Current summaries use command-specific budgets and artifact handles.";
export const OUTPUT_PATH_DESCRIPTION = "Deprecated compatibility only; stripped before tool validation. Full raw evidence is saved by command-managed artifacts when needed.";
export const MAX_CHARS_DESCRIPTION = "Deprecated compatibility only; stripped before tool validation. Current commands use committed per-tool budgets.";

function enumLiteralSchemas<const TValue extends readonly [string, string, ...string[]]>(values: TValue): [TSchema, TSchema, ...TSchema[]] {
	return values.map((value) => Type.Literal(value)) as unknown as [TSchema, TSchema, ...TSchema[]];
}

export function strictCommandParameters<T extends Record<string, TSchema>>(properties: T) {
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

export function optionalTargetRef(description = TARGET_REF_DESCRIPTION) {
	return Type.Optional(Type.String({ description }));
}
