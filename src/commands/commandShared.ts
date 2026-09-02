import { Type, type TSchema } from "typebox";
import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";
import type { BrowserCommandSink } from "./commandDefinition.js";
export { asPositiveInt } from "../utils/params.js";

export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
/**
 * Timeouts are runtime-managed rather than public tool inputs. Commands whose whole purpose is to
 * wait (wait.*, network.wait, ws.wait, transfer.*) get a longer fixed budget than one-shot actions.
 */
export const LONG_RUNNING_TOOL_TIMEOUT_MS = 45_000;

const LONG_RUNNING_COMMAND_PATTERN = /^(wait\.|network\.wait$|ws\.wait$|transfer\.)/;

export function nativeCommandTimeoutMs(cmd: string): number {
	return LONG_RUNNING_COMMAND_PATTERN.test(cmd) ? LONG_RUNNING_TOOL_TIMEOUT_MS : DEFAULT_TOOL_TIMEOUT_MS;
}

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
