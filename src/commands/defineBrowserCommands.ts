import type { BrowserCommandSink } from "./commandDefinition.js";
import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";
import { ensureBuiltinDistillersReady } from "./distillerRegistry.js";
import { withRelevanceTraceTap } from "./relevanceTraceAdapter.js";
import { resolveBrowserCommandRegistrars } from "./commandCatalog.js";
import type { EnsureStarted, MemoryResultResourceResolver, CommandRegistrarContext } from "./commandShared.js";

export function defineBrowserCommands(commands: BrowserCommandSink, server: BrowserCommandRuntimePort, ensureStarted: EnsureStarted, options: { memoryEvidenceResolver?: MemoryResultResourceResolver } = {}) {
	ensureBuiltinDistillersReady();
	const context: CommandRegistrarContext = { commands: withRelevanceTraceTap(commands, server), ensureStarted, memoryEvidenceResolver: options.memoryEvidenceResolver };
	for (const defineCommandManifest of resolveBrowserCommandRegistrars()) defineCommandManifest(context);
}
