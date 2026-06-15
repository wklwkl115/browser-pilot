import type { CommandManifest } from "./defineCommand.js";

const commands = new Map<string, CommandManifest>();

export function registerCommand(command: CommandManifest): void {
	commands.set(command.name, command);
}

export function commandManifestRegistry(): readonly CommandManifest[] {
	return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findCommand(name: string): CommandManifest | undefined {
	return commands.get(name);
}

export * from "./defineCommand.js";
