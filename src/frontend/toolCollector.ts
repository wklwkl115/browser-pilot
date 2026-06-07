/**
 * Tool-collecting ExtensionAPI adapter (frontend-agnostic).
 *
 * Implements the @earendil-works/pi-coding-agent ExtensionAPI interface
 * so that all existing register*Tool functions run unmodified. Tool
 * definitions are captured into an internal map and later consumed by a
 * frontend (the CLI client for flag generation, the daemon for execution)
 * via {@link ToolCollectingAdapter.getTools}.
 */
import type { ExtensionAPI, ExtensionToolResult, ExtensionToolUpdate } from "@earendil-works/pi-coding-agent";

// ------------------------------------------------------------------ types

export type ToolDefinition = {
	name: string;
	label?: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: unknown;
	prepareArguments?: (args: any) => any;
	execute: (
		toolCallId: string,
		params: any,
		signal?: AbortSignal,
		onUpdate?: (update: ExtensionToolUpdate) => void | Promise<void>,
		ctx?: { cwd?: string; hasUI?: boolean },
	) => Promise<ExtensionToolResult> | ExtensionToolResult;
};

// ---------------------------------------------------------------- adapter

/**
 * Minimal ExtensionAPI implementation that collects tool registrations.
 *
 * - `registerTool` → stores definition in `tools` map
 * - `on` → no-op (lifecycle is managed by the host process, not plugin events)
 * - `registerCommand` → no-op (slash commands need editor UI a CLI has no equivalent for)
 */
export class ToolCollectingAdapter implements ExtensionAPI {
	private readonly tools = new Map<string, ToolDefinition>();

	// ---- ExtensionAPI interface ------------------------------------------------

	registerTool(definition: Parameters<ExtensionAPI["registerTool"]>[0]): void {
		const def = definition as ToolDefinition;
		this.tools.set(def.name, def);
	}

	on(_event: string, _handler: (...args: any[]) => void | Promise<void>): void {
		// Lifecycle is managed by the host process (daemon / Pi host), not plugin events.
	}

	registerCommand(_name: string, _definition: Parameters<ExtensionAPI["registerCommand"]>[1]): void {
		// Slash commands depend on editor UI (ctx.ui.notify / setEditorText); skip silently.
	}

	// ---- frontend helpers ------------------------------------------------------

	/** Return all registered tool definitions. */
	getTools(): ToolDefinition[] {
		return [...this.tools.values()];
	}

	/** Look up a single tool by name. */
	getTool(name: string): ToolDefinition | undefined {
		return this.tools.get(name);
	}
}
