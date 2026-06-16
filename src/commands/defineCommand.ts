import type { CommandResult } from "./resultTypes.js";

export type CommandContext = {
	ports: Record<string, unknown>;
	cwd?: string;
};

export type CommandManifest<TParams = unknown, TResult = unknown> = {
	name: string;
	description?: string;
	parameters?: unknown;
	run: (params: TParams, context: CommandContext) => Promise<CommandResult<TResult>> | CommandResult<TResult>;
};

export function defineCommand<TParams, TResult>(manifest: CommandManifest<TParams, TResult>): CommandManifest<TParams, TResult> {
	return manifest;
}
