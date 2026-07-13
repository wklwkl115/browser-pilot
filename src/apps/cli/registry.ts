/**
 * CLI command registry — builds the subcommand list locally from the command
 * registry, with NO browser/bridge startup. Each registered browser_* command maps
 * to a subcommand. Used by --help, argv parsing, and the parity contract.
 */
import { CommandManifestIndex, type CommandDefinition } from "../../commands/commandManifestIndex.js";
import { defineBrowserCommands } from "../../commands/defineBrowserCommands.js";
import { defineAgentFacadeCommands } from "../../commands/agent/defineAgentFacadeCommands.js";
import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";

export type CliCommand = {
	/** Command name, e.g. "browser_execute". */
	name: string;
	/** CLI subcommand, e.g. "execute" (command name minus browser_, _ -> -). */
	subcommand: string;
	description?: string;
	/** TypeBox parameter schema (introspected into flags). */
	parameters?: unknown;
	def: CommandDefinition;
};

// Registration never touches the server (registrars only add command metadata;
// the server is used lazily inside execute), so a placeholder is safe here.
const placeholderServer = {} as unknown as BrowserCommandRuntimePort;
const noopEnsureStarted = async () => placeholderServer;
let cachedCommandDefs: CommandDefinition[] | undefined;
let cachedAgentFacadeDefs: CommandDefinition[] | undefined;
let cachedCliCommands: CliCommand[] | undefined;
let cachedRunnableCliCommands: CliCommand[] | undefined;

export function toSubcommand(commandName: string): string {
	return commandName.replace(/^browser_/, "").replace(/_/g, "-");
}

export function fromSubcommand(subcommand: string): string {
	return `browser_${subcommand.replace(/-/g, "_")}`;
}

/** Public catalog definitions (contract toolCount 22: core + security + agent façade). */
export function collectCommandDefs(): CommandDefinition[] {
	if (cachedCommandDefs) return cachedCommandDefs;
	const adapter = new CommandManifestIndex();
	defineBrowserCommands(adapter, placeholderServer, noopEnsureStarted);
	defineAgentFacadeCommands({ commands: adapter, ensureStarted: noopEnsureStarted });
	cachedCommandDefs = adapter.getCommands();
	return cachedCommandDefs;
}

/** Agent façade definitions only (view/act/read). */
export function collectAgentFacadeDefs(): CommandDefinition[] {
	if (cachedAgentFacadeDefs) return cachedAgentFacadeDefs;
	const adapter = new CommandManifestIndex();
	defineAgentFacadeCommands({ commands: adapter, ensureStarted: noopEnsureStarted });
	cachedAgentFacadeDefs = adapter.getCommands();
	return cachedAgentFacadeDefs;
}

function toCliCommands(defs: readonly CommandDefinition[]): CliCommand[] {
	return defs
		.map((def) => ({
			name: def.name,
			subcommand: toSubcommand(def.name),
			description: def.description,
			parameters: def.parameters,
			def,
		}))
		.sort((a, b) => a.subcommand.localeCompare(b.subcommand));
}

/** Public CLI catalog list (exactly 22 tools). */
export function buildCliCommands(): CliCommand[] {
	if (cachedCliCommands) return cachedCliCommands;
	cachedCliCommands = toCliCommands(collectCommandDefs());
	return cachedCliCommands;
}

/** Runnable CLI list equals public catalog after agent façade GA. */
export function buildRunnableCliCommands(): CliCommand[] {
	if (cachedRunnableCliCommands) return cachedRunnableCliCommands;
	cachedRunnableCliCommands = buildCliCommands();
	return cachedRunnableCliCommands;
}
