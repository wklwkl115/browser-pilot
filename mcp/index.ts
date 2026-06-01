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
	ListResourcesRequestSchema,
	ListResourceTemplatesRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ExtensionToolResult } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import { McpExtensionAdapter } from "./adapter.js";
import { validateMcpToolArgs } from "./validation.js";
import { TOOL_ANNOTATIONS } from "./toolAnnotations.js";
import { BrowserBridgeServer } from "../src/driver/BrowserBridgeServer.js";
import { registerBrowserTools } from "../src/tools/registerTools.js";
import type { EnsureStarted } from "../src/tools/toolShared.js";
import { resolveBrowserToolCapabilityProfile } from "../src/tools/capabilityProfile.js";
import { getDistillerDefinition } from "../src/tools/distillerRegistry.js";
import { registerBrowserResultResource, listResources, clearResourceStore } from "./resourceStore.js";
import { readBrowserResultResource } from "./resourceReader.js";
import { resolveIngressHandles } from "./handleResolver.js";
import { runHooks, emitLog, timingLogHook, registerHook } from "./middleware.js";

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

// ─── Protocol middleware setup ──────────────────────────────────────────────

registerHook("on_log", timingLogHook);

// ─── Build MCP server ───────────────────────────────────────────────────────

const server = new Server(
	{ name: "pi-browser-tools", version: "1.0.0" },
	{ capabilities: { tools: {}, resources: {} } },
);

// tools/list ─────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
	const ctx = { method: "tools/list", startedAt: Date.now() };
	const hookResult = await runHooks("on_list_tools", ctx, null);
	if (!hookResult.pass) {
		emitLog(ctx, Date.now() - ctx.startedAt, "error", { code: hookResult.code });
		throw new Error(`${hookResult.code}: ${hookResult.error}`);
	}

	// Phase 8: capability-gated browser_artifact retirement.
	// The server declares resources:{} capability. Clients that have completed
	// initialize (clientCaps != null) are modern MCP clients that support
	// resources/read for artifact access. For those clients, omit browser_artifact
	// from tools/list. Pre-initialize or legacy clients keep it.
	// Override: set PI_BROWSER_MCP_KEEP_ARTIFACT=1 to always expose browser_artifact.
	const clientCaps = server.getClientCapabilities();
	const keepArtifact = process.env["PI_BROWSER_MCP_KEEP_ARTIFACT"] === "1";
	const clientIsModern = clientCaps != null;
	const visibleTools = (!keepArtifact && clientIsModern)
		? toolDefs.filter((def) => def.name !== "browser_artifact")
		: toolDefs;

	const response = ({
		tools: visibleTools.map((def) => {
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
	});
	emitLog(ctx, Date.now() - ctx.startedAt, "ok", { toolCount: visibleTools.length, resourcesCapable: clientIsModern });
	return response;
});

// tools/call ─────────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: args } = request.params;
	const ctx = { method: "tools/call", toolName: name, startedAt: Date.now() };

	// Run on_call_tool hooks (auth/profile/rate-limit checks)
	const hookResult = await runHooks("on_call_tool", ctx, request.params);
	if (!hookResult.pass) {
		emitLog(ctx, Date.now() - ctx.startedAt, "error", { code: hookResult.code });
		return {
			content: [{ type: "text" as const, text: `${hookResult.code}: ${hookResult.error}` }],
			isError: true,
		};
	}

	const def = toolDefs.find((t) => t.name === name);

	if (!def) {
		emitLog(ctx, Date.now() - ctx.startedAt, "error", { code: "TOOL_NOT_FOUND" });
		return {
			content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
			isError: true,
		};
	}

	// Phase 6: Resolve browser-result:// handle strings in declared fields before
	// TypeBox validation. Handles are expanded to their typed JSON payloads;
	// diagnostics echo handle meta (not payload). Kind mismatch / expired / not
	// found return structured errors.
	const handleResult = await resolveIngressHandles(name, args ?? {});
	if (!handleResult.ok) {
		emitLog(ctx, Date.now() - ctx.startedAt, "error", { code: handleResult.code });
		return {
			content: [{ type: "text" as const, text: `Handle resolution error [${handleResult.code}]: ${handleResult.error}` }],
			isError: true,
		};
	}

	// Validate and coerce args via TypeBox before reaching tool execute.
	// Uses handle-expanded args so TypeBox sees the real payload, not the URI.
	const validation = validateMcpToolArgs(def.parameters, handleResult.args);
	if (!validation.ok) {
		emitLog(ctx, Date.now() - ctx.startedAt, "error", { code: "INVALID_PARAMS" });
		return {
			content: [{ type: "text" as const, text: validation.error }],
			isError: true,
		};
	}

	const progressToken = request.params._meta?.progressToken;
	let progressCount = 0;

	const distillerDef = getDistillerDefinition(name);

	try {
		let result: ExtensionToolResult = await def.execute(
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
		let resourceLink: { type: "resource_link"; uri: string; name: string; mimeType?: string } | undefined;

		if (!result.terminate) {
			try {
				const text = result.content[0]?.text ?? "";
				const envelope = JSON.parse(text) as Record<string, unknown>;

				// Extract structuredContent from summary (for distiller-backed tools).
				// MCP spec: structuredContent MUST conform to the declared outputSchema.
				// The distilled summary can be budget-fitted (compacted/truncated) into a
				// minimal shape that drops required fields. Validate against summarySchema
				// before emitting; if it no longer conforms, omit structuredContent and
				// degrade gracefully to text-only rather than violate the spec.
				if (distillerDef) {
					const summary = envelope.summary;
					if (
						summary != null &&
						typeof summary === "object" &&
						!Array.isArray(summary) &&
						Value.Check(distillerDef.summarySchema, summary)
					) {
						structuredContent = summary as Record<string, unknown>;
					}
				}

				// Register a resource_link for saved artifacts so clients can use
				// resources/read instead of browser_artifact. URI never exposes local path.
				const saved = envelope.saved as Record<string, unknown> | undefined;
				if (saved?.path && typeof saved.path === "string") {
					const resourceUri = registerBrowserResultResource({
						kind: "raw-result",
						artifactPath: saved.path,
						name: `${name} result`,
						description: `Raw result from ${name} call`,
						mime: typeof saved.mime === "string" ? saved.mime : "application/json",
						bytes: typeof saved.bytes === "number" ? saved.bytes : undefined,
						immutable: true,
					});
					resourceLink = {
						type: "resource_link" as const,
						uri: resourceUri,
						name: `${name} artifact`,
						mimeType: typeof saved.mime === "string" ? saved.mime : "application/json",
					};

					// Phase 5: nextActions adapter transformation.
					// Replace core-generated browser_artifact path=<localPath> entries with
					// MCP resources/read uri=<browser-result://...> equivalents. Pi adapter
					// path keeps the original browser_artifact entries unchanged.
					const nextActions = Array.isArray(envelope.nextActions) ? envelope.nextActions : [];
					const localPath = saved.path;
					const adaptedNextActions = nextActions.map((action) => {
						if (typeof action !== "string") return action;
						if (action.startsWith(`browser_artifact path=${localPath}`)) {
							// Preserve any trailing query options (mode=json jsonPath=...)
							const suffix = action.slice(`browser_artifact path=${localPath}`.length).trim();
							const queryPart = suffix ? `&${suffix.replace(/\s+/g, "&")}` : "";
							return `resources/read uri=${resourceUri}${queryPart}`;
						}
						if (action.startsWith("browser_artifact path=")) {
							// Different path — only adapt our registered artifact
							return action;
						}
						return action;
					});
					if (adaptedNextActions.some((a, i) => a !== nextActions[i])) {
						// Re-serialize the text with adapted nextActions only if something changed.
						result = {
							...result,
							content: [{ type: "text" as const, text: JSON.stringify({ ...envelope, nextActions: adaptedNextActions }) }],
						};
					}
				}
			} catch {
				// Best-effort: non-JSON result (e.g. error response) — skip.
			}
		}

		const content = resourceLink
			? [...result.content, resourceLink]
			: result.content;

		emitLog(ctx, Date.now() - ctx.startedAt, result.terminate ? "error" : "ok");
		return {
			content,
			...(structuredContent != null ? { structuredContent } : {}),
			isError: result.terminate === true,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		emitLog(ctx, Date.now() - ctx.startedAt, "error", { error: message });
		return {
			content: [{ type: "text" as const, text: message }],
			isError: true,
		};
	}
});

// resources/list ─────────────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
	resources: listResources().map((r) => ({
		uri: r.uri,
		name: r.name,
		description: r.description,
		mimeType: r.mime,
	})),
}));

// resources/templates/list ────────────────────────────────────────────────────

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
	resourceTemplates: [
		{
			uriTemplate: "browser-result://{id}",
			name: "Browser tool result",
			description: "Raw or distilled result from a browser tool call. Supports ?mode=text|json|search|sample&offset=&limit=&jsonPath=&search=",
			mimeType: "text/plain",
		},
	],
}));

// resources/read ──────────────────────────────────────────────────────────────

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
	const uri = request.params.uri;
	const ctx = { method: "resources/read", startedAt: Date.now() };
	const hookResult = await runHooks("on_read_resource", ctx, request.params);
	if (!hookResult.pass) {
		emitLog(ctx, Date.now() - ctx.startedAt, "error", { code: hookResult.code });
		throw new Error(`${hookResult.code}: ${hookResult.error}`);
	}
	const result = await readBrowserResultResource(uri);
	if (!result.ok) {
		emitLog(ctx, Date.now() - ctx.startedAt, "error", { code: result.code });
		throw new Error(`${result.code}: ${result.error}`);
	}
	emitLog(ctx, Date.now() - ctx.startedAt, "ok");
	return {
		contents: [result.content],
	};
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
				clearResourceStore();
				process.exit(0);
			})();
		});
	}
}

main().catch((error) => {
	console.error("[pi-browser-mcp] fatal:", error);
	process.exit(1);
});
