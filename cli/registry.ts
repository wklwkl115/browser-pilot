/**
 * CLI command registry — builds the subcommand list locally from the tool
 * registry, with NO browser/bridge startup. Mirrors how the MCP tools/list path
 * collects tool definitions, but for the CLI: each registered browser_* tool maps
 * to a subcommand. Used by --help, argv parsing, and the parity contract.
 */
import { ToolCollectingAdapter, type ToolDefinition } from "../src/frontend/toolCollector.js";
import { registerBrowserTools } from "../src/tools/registerTools.js";
import { resolveBrowserToolCapabilityProfile } from "../src/tools/capabilityProfile.js";
import type { BrowserBridgeServer } from "../src/driver/BrowserBridgeServer.js";

export type CliCommand = {
	/** Tool name, e.g. "browser_execute". */
	name: string;
	/** CLI subcommand, e.g. "execute" (tool name minus browser_, _ -> -). */
	subcommand: string;
	description?: string;
	/** TypeBox parameter schema (introspected into flags). */
	parameters?: unknown;
	def: ToolDefinition;
};

// Registration never touches the server (registrars only call pi.registerTool;
// the server is used lazily inside execute), so a placeholder is safe here.
const placeholderServer = {} as unknown as BrowserBridgeServer;
const noopEnsureStarted = async () => placeholderServer;

export function toSubcommand(toolName: string): string {
	return toolName.replace(/^browser_/, "").replace(/_/g, "-");
}

export function fromSubcommand(subcommand: string): string {
	return `browser_${subcommand.replace(/-/g, "_")}`;
}

/** Collect all registered tool definitions for the active (or given) profile. */
export function collectToolDefs(securityToolsEnabled?: boolean): ToolDefinition[] {
	const adapter = new ToolCollectingAdapter();
	const profile = resolveBrowserToolCapabilityProfile();
	registerBrowserTools(adapter, placeholderServer, noopEnsureStarted, {
		securityToolsEnabled: securityToolsEnabled ?? profile.securityToolsEnabled,
	});
	return adapter.getTools();
}

/** Build the CLI command list (one per registered tool). */
export function buildCliCommands(securityToolsEnabled?: boolean): CliCommand[] {
	return collectToolDefs(securityToolsEnabled)
		.map((def) => ({
			name: def.name,
			subcommand: toSubcommand(def.name),
			description: def.description,
			parameters: def.parameters,
			def,
		}))
		.sort((a, b) => a.subcommand.localeCompare(b.subcommand));
}
