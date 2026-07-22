import { Type, type TSchema } from "typebox";
import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";
import type { BrowserCommandSink } from "./commandDefinition.js";
export { asPositiveInt } from "../utils/params.js";

export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;

export type EnsureStarted = () => Promise<BrowserCommandRuntimePort>;
export type CommandRegistrarContext = {
	commands: BrowserCommandSink;
	ensureStarted: EnsureStarted;
};

export type CommandRegistrar = (context: CommandRegistrarContext) => void;

export const TAB_SCOPED_TOOL_GUIDELINE = "Use targetRef from browser_tabs list/create to disambiguate several open tabs; omit it to use the selected active tab.";
export const TARGET_REF_DESCRIPTION = "Stable target reference from browser_tabs list/create (tabHandle). It survives daemon/extension reconnect and unambiguous in-place replacement within the current browser runtime; reacquire after the tab or browser runtime is gone.";

export function strictCommandParameters<T extends Record<string, TSchema>>(properties: T) {
	return Type.Object(properties, { additionalProperties: false });
}

export function optionalTargetRef(description = TARGET_REF_DESCRIPTION) {
	return Type.Optional(Type.String({ description }));
}
