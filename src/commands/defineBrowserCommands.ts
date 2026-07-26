import type { BrowserCommandSink } from "./commandDefinition.js";
import { BROWSER_COMMAND_REGISTRARS } from "./commandCatalog.js";
import type { EnsureStarted, CommandRegistrarContext } from "./commandShared.js";

export function defineBrowserCommands(commands: BrowserCommandSink, ensureStarted: EnsureStarted) {
	const context: CommandRegistrarContext = {
		commands,
		ensureStarted,
	};
	for (const defineCommandManifest of BROWSER_COMMAND_REGISTRARS) defineCommandManifest(context);
}
