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
import { validateMcpToolArgs } from "./validation.js";
import { TOOL_ANNOTATIONS } from "./toolAnnotations.js";
import { BrowserBridgeServer } from "../src/driver/BrowserBridgeServer.js";
import { registerBrowserTools } from "../src/tools/registerTools.js";
import type { EnsureStarted } from "../src/tools/toolShared.js";
import { resolveBrowserToolCapabilityProfile } from "../src/tools/capabilityProfile.js";
import { getDistillerDefinition } from "../src/tools/distillerRegistry.js";

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
	tools: toolDefs.map((def) => {
		const distillerDef = getDistillerDefinition(def.name);
		return {
			name: def.name,
			description: def.description,
			// TypeBox Type.Object outputs standard JSON Schema — pass through directly.
			inputSchema: (def.parameters ?? { type: "object" }) as any,
			// outputSchema declared only for tools with an explicit DistillerDefinition.
			// Clients that support structuredContent will receive the distilled summary.
			outputSchema: distillerDef?.summarySchema as any,
			// Informational hints for MCP clients (UIs, hosts). Not security boundaries.
			annotations: TOOL_ANNOTATIONS[def.name],
		};
	}),
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

	// Validate and coerce args via TypeBox before reaching tool execute.
	// This replicates the Pi framework's Value.Convert + Check behavior so
	// MCP callers get the same coercion and rejection semantics.
	const validation = validateMcpToolArgs(def.parameters, args ?? {});
	if (!validation.ok) {
		return {
			content: [{ type: "text" as const, text: validation.error }],
			isError: true,
		};
	}

	const progressToken = request.params._meta?.progressToken;
	let progressCount = 0;

	const distillerDef = getDistillerDefinition(name);

	try {
		const result: ExtensionToolResult = await def.execute(
			String(progressToken ?? `mcp-call-${name}`),
			validation.args,
			undefined, // signal — MCP transport manages connection lifecycle
			progressToken != null
				? async (update) => {
						// Map streaming updates to MCP progress notifications when the
						// caller supplied a progressToken. Best-effort: ignore send errors
						// (connection may have closed before the tool finishes).
						const text = update.content.map((c) => c.text).join(" ").slice(0, 200);
						await server
							.notification({
								method: "notifications/progress",
								params: {
									progressToken,
									progress: ++progressCount,
									message: text || undefined,
								},
							})
							.catch(() => {
								/* best-effort */
							});
					}
				: undefined,
			undefined, // ctx — no editor UI in MCP context
		);

		// For tools with a declared outputSchema, include structuredContent alongside
		// the compatible text. Extract the summary from the existing DistilledEnvelope
		// text (which is already the distilled JSON). Pi adapter path is unchanged.
		let structuredContent: Record<string, unknown> | undefined;
		if (distillerDef && !result.terminate) {
			try {
				const text = result.content[0]?.text ?? "";
				const envelope = JSON.parse(text) as Record<string, unknown>;
				const summary = envelope.summary;
				if (summary != null && typeof summary === "object" && !Array.isArray(summary)) {
					structuredContent = summary as Record<string, unknown>;
				}
			} catch {
				// Best-effort: non-JSON result (e.g. error response) — skip structuredContent.
			}
		}

		return {
			content: result.content,
			...(structuredContent != null ? { structuredContent } : {}),
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
