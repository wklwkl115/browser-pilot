/**
 * Command definition collector for CLI/daemon command consumers.
 *
 * command manifest functions write into a tiny internal host interface. The
 * collected definitions are then consumed by the CLI for
 * local schema/help generation and by the daemon for execution.
 */
import type { BrowserCommandDefinition } from "./commandDefinition.js";

export type CommandDefinition = BrowserCommandDefinition;

// ---------------------------------------------------------------- adapter

/**
 * Minimal host implementation that collects command registrations.
 */
export class CommandManifestIndex {
	private readonly commands = new Map<string, CommandDefinition>();

	define(definition: CommandDefinition): void {
		this.commands.set(definition.name, definition);
	}

	/** Return all registered command definitions. */
	getCommands(): CommandDefinition[] {
		return [...this.commands.values()];
	}

	/** Look up a single command by name. */
	getCommand(name: string): CommandDefinition | undefined {
		return this.commands.get(name);
	}
}
