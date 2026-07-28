import { CommandManifestIndex, type CommandDefinition } from "./commandManifestIndex.js";
import { defineBrowserCommands } from "./defineBrowserCommands.js";
import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";

const placeholderRuntime = {} as BrowserCommandRuntimePort;
const noopEnsureStarted = async () => placeholderRuntime;
let cached: CommandDefinition[] | undefined;

export function browserCommandDefinitions(): CommandDefinition[] {
	if (cached) return cached;
	const commands = new CommandManifestIndex();
	defineBrowserCommands(commands, noopEnsureStarted);
	cached = commands.getCommands();
	return cached;
}
