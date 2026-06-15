/**
 * CLI command registry — builds the subcommand list locally from the command
 * registry, with NO browser/bridge startup. Each registered browser_* command maps
 * to a subcommand. Used by --help, argv parsing, and the parity contract.
 */
import { CommandManifestIndex, type CommandDefinition } from "../../commands/commandManifestIndex.js";
import { defineBrowserCommands } from "../../commands/defineBrowserCommands.js";
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
let cachedCliCommands: CliCommand[] | undefined;

export function toSubcommand(commandName: string): string {
	return commandName.replace(/^browser_/, "").replace(/_/g, "-");
}

export function fromSubcommand(subcommand: string): string {
	return `browser_${subcommand.replace(/-/g, "_")}`;
}

/** Collect all registered command definitions. */
export function collectCommandDefs(): CommandDefinition[] {
	if (cachedCommandDefs) return cachedCommandDefs;
	const adapter = new CommandManifestIndex();
	defineBrowserCommands(adapter, placeholderServer, noopEnsureStarted);
	cachedCommandDefs = adapter.getCommands();
	return cachedCommandDefs;
}

/** Build the CLI command list (one per registered command). */
export function buildCliCommands(): CliCommand[] {
	if (cachedCliCommands) return cachedCliCommands;
	cachedCliCommands = collectCommandDefs()
		.map((def) => ({
			name: def.name,
			subcommand: toSubcommand(def.name),
			description: def.description,
			parameters: def.parameters,
			def,
		}))
		.sort((a, b) => a.subcommand.localeCompare(b.subcommand));
	return cachedCliCommands;
}
