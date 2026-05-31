/**
 * MCP ExtensionAPI adapter.
 *
 * Implements the @earendil-works/pi-coding-agent ExtensionAPI interface
 * so that all existing register*Tool functions can run unmodified.
 * Tool definitions are captured into an internal map and later registered
 * with the MCP server via {@link getTools}.
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
 * - `on` → no-op (lifecycle managed by MCP server, not the plugin host)
 * - `registerCommand` → no-op (slash commands need editor UI)
 */
export class McpExtensionAdapter implements ExtensionAPI {
	private readonly tools = new Map<string, ToolDefinition>();

	// ---- ExtensionAPI interface ------------------------------------------------

	registerTool(definition: Parameters<ExtensionAPI["registerTool"]>[0]): void {
		const def = definition as ToolDefinition;
		this.tools.set(def.name, def);
	}

	on(_event: string, _handler: (...args: any[]) => void | Promise<void>): void {
		// Lifecycle is managed by the MCP server process, not by plugin events.
	}

	registerCommand(_name: string, _definition: Parameters<ExtensionAPI["registerCommand"]>[1]): void {
		// Slash commands depend on editor UI (ctx.ui.notify / setEditorText).
		// MCP has no equivalent; skip silently.
	}

	// ---- MCP helpers -----------------------------------------------------------

	/** Return all registered tool definitions. */
	getTools(): ToolDefinition[] {
		return [...this.tools.values()];
	}

	/** Look up a single tool by name. */
	getTool(name: string): ToolDefinition | undefined {
		return this.tools.get(name);
	}
}
