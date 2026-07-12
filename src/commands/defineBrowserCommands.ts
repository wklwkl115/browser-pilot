import type { BrowserCommandSink } from "./commandDefinition.js";
import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";
import { ensureBuiltinDistillersReady } from "./distillerRegistry.js";
import { withRelevanceTraceTap } from "./relevanceTraceAdapter.js";
import { resolveBrowserCommandRegistrars } from "./commandCatalog.js";
import type { EnsureStarted, CommandRegistrarContext } from "./commandShared.js";

export function defineBrowserCommands(commands: BrowserCommandSink, server: BrowserCommandRuntimePort, ensureStarted: EnsureStarted) {
	ensureBuiltinDistillersReady();
	const context: CommandRegistrarContext = { commands: withRelevanceTraceTap(commands, server), ensureStarted };
	for (const defineCommandManifest of resolveBrowserCommandRegistrars()) defineCommandManifest(context);
}
