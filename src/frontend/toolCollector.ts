/**
 * Tool definition collector for CLI/daemon frontends.
 *
 * register*Tool functions write into a tiny internal host interface. The
 * collected definitions are then consumed by the CLI for
 * local schema/help generation and by the daemon for execution.
 */
import type { BrowserToolDefinition } from "./toolHost.js";

export type ToolDefinition = BrowserToolDefinition;

// ---------------------------------------------------------------- adapter

/**
 * Minimal host implementation that collects tool registrations.
 */
export class ToolRegistryAdapter {
	private readonly tools = new Map<string, ToolDefinition>();

	registerTool(definition: ToolDefinition): void {
		this.tools.set(definition.name, definition);
	}

	/** Return all registered tool definitions. */
	getTools(): ToolDefinition[] {
		return [...this.tools.values()];
	}

	/** Look up a single tool by name. */
	getTool(name: string): ToolDefinition | undefined {
		return this.tools.get(name);
	}
}
