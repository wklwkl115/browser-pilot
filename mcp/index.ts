#!/usr/bin/env node
/**
 * pi-browser-tools — MCP Server
 *
 * Exposes all 21 browser tools (14 core + 7 web-security) via the
 * Model Context Protocol over stdio.  The Chrome extension bridge
 * is started lazily on the first tool call.
 *
 * Usage:
 *   npm run mcp                  # stdio transport (repo-local)
 *   npx tsx mcp/index.ts         # stdio transport (for Claude Code / IDE)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	ListToolsRequestSchema,
	CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ExtensionToolResult } from "@earendil-works/pi-coding-agent";

import { McpExtensionAdapter } from "./adapter.js";
import { BrowserBridgeServer } from "../src/driver/BrowserBridgeServer.js";
import { registerBrowserTools } from "../src/tools/registerTools.js";
import type { EnsureStarted } from "../src/tools/toolShared.js";
import { resolveBrowserToolCapabilityProfile } from "../src/tools/capabilityProfile.js";

// ─── Bridge lifecycle ───────────────────────────────────────────────────────

const bridgeServer = new BrowserBridgeServer();
const capabilityProfile = resolveBrowserToolCapabilityProfile();
bridgeServer.setCapabilityProfile(capabilityProfile);

let startPromise: Promise<void> | undefined;

const ensureStarted: EnsureStarted = async () => {
	if (!startPromise) {
		startPromise = bridgeServer.start().catch((error) => {
			startPromise = undefined;
			throw error;
		});
	}
	await startPromise;
	return bridgeServer;
};

// ─── Register tools via the adapter ─────────────────────────────────────────

const adapter = new McpExtensionAdapter();

registerBrowserTools(adapter, bridgeServer, ensureStarted, {
	securityToolsEnabled: capabilityProfile.securityToolsEnabled,
});

const toolDefs = adapter.getTools();

// ─── Build MCP server ───────────────────────────────────────────────────────

const server = new Server(
	{ name: "pi-browser-tools", version: "1.0.0" },
	{ capabilities: { tools: {} } },
);

// tools/list ─────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: toolDefs.map((def) => ({
		name: def.name,
		description: def.description,
		// TypeBox Type.Object outputs standard JSON Schema — pass through directly.
		inputSchema: (def.parameters ?? { type: "object" }) as any,
	})),
}));

// tools/call ─────────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: args } = request.params;
	const def = toolDefs.find((t) => t.name === name);

	if (!def) {
		return {
			content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
			isError: true,
		};
	}

	try {
		const result: ExtensionToolResult = await def.execute(
			String(request.params._meta?.progressToken ?? `mcp-${Date.now()}`),
			args ?? {},
			undefined, // signal — MCP transport manages connection lifecycle
			undefined, // onUpdate — could map to MCP notifications in future
			undefined, // ctx — no editor UI in MCP context
		);

		return {
			content: result.content,
			isError: result.terminate === true,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text" as const, text: message }],
			isError: true,
		};
	}
});

// ─── Start ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error(`[pi-browser-mcp] server started, ${toolDefs.length} tools registered`);

	// Graceful shutdown
	for (const sig of ["SIGINT", "SIGTERM"] as const) {
		process.on(sig, () => {
			void (async () => {
				await server.close();
				await bridgeServer.stop();
				process.exit(0);
			})();
		});
	}
}

main().catch((error) => {
	console.error("[pi-browser-mcp] fatal:", error);
	process.exit(1);
});
