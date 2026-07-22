import type { BrowserCommandSink } from "./commandDefinition.js";
import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";
import { withRelevanceTraceTap } from "./relevanceTraceAdapter.js";
import { BROWSER_COMMAND_REGISTRARS } from "./commandCatalog.js";
import type { EnsureStarted, CommandRegistrarContext } from "./commandShared.js";

export function defineBrowserCommands(commands: BrowserCommandSink, server: BrowserCommandRuntimePort, ensureStarted: EnsureStarted) {
	const context: CommandRegistrarContext = {
		commands: withRelevanceTraceTap(commands, server),
		ensureStarted,
	};
	for (const defineCommandManifest of BROWSER_COMMAND_REGISTRARS) defineCommandManifest(context);
}
