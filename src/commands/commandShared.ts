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

export const TARGET_REF_DESCRIPTION = "Target returned by browser_tabs; omit it to use the selected active tab.";

export function strictCommandParameters<T extends Record<string, TSchema>>(properties: T) {
	return Type.Object(properties, { additionalProperties: false });
}

export function optionalTargetRef(description = TARGET_REF_DESCRIPTION) {
	return Type.Optional(Type.String({ description }));
}
