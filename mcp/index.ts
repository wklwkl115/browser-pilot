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
	ListPromptsRequestSchema,
	GetPromptRequestSchema,
	McpError,
	ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool as McpTool, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
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
import { registerBrowserResultResource, listResources, clearResourceStore, resolveRefUriDetailed, type ResourceKind } from "./resourceStore.js";
import { RESOURCE_KINDS } from "./structuredEnvelopeSchema.js";
import { readBrowserResultResource } from "./resourceReader.js";
import { listMemoryResources, memoryResourceTemplates, resolveBrowserResultEvidence } from "./memoryResourceStore.js";
import { readMemoryResource } from "./memoryResourceReader.js";
import { getBrowserPrompt, listBrowserPrompts } from "./prompts.js";
import { MCP_DISCOVERY_TOOL_NAME, isMcpToolVisible, resolveMcpToolVisibilityOptions, visibleMcpTools } from "./toolVisibility.js";

const RESOURCE_KIND_SET = new Set<string>(RESOURCE_KINDS);
type McpToolSchema = McpTool["inputSchema"] & Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isToolSchemaProperties(value: unknown): value is Record<string, object> {
	return isRecord(value) && Object.values(value).every((item) => !!item && typeof item === "object" && !Array.isArray(item));
}

function isMcpToolSchema(value: unknown): value is McpToolSchema {
	if (!isRecord(value) || value.type !== "object") return false;
	if (value.$schema !== undefined && typeof value.$schema !== "string") return false;
	if (value.properties !== undefined && !isToolSchemaProperties(value.properties)) return false;
	if (value.required !== undefined && !isStringArray(value.required)) return false;
	return true;
}

function normalizeMcpToolSchema(value: unknown): McpToolSchema | undefined {
	return isMcpToolSchema(value) ? value : undefined;
}

import { resolveIngressHandles } from "./handleResolver.js";
import { runHooks, emitLog, timingLogHook, registerHook, type MiddlewareContext } from "./middleware.js";
import { resolveUsageLogOptions, createUsageLogHook } from "./usageLog.js";

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
	memoryEvidenceResolver: resolveBrowserResultEvidence,
});

const toolDefs = adapter.getTools();

// ─── Protocol middleware setup ──────────────────────────────────────────────

registerHook("on_log", timingLogHook);

// Opt-in development usage logger (PI_BROWSER_USAGE_LOG). Persists one JSON line
// per tool call for studying real agent usage; off by default, best-effort writes.
const usageLogOptions = resolveUsageLogOptions();
if (usageLogOptions.enabled) {
	registerHook("on_log", createUsageLogHook(usageLogOptions));
	console.error(`[pi-browser-mcp] usage logging → ${usageLogOptions.filePath}${usageLogOptions.raw ? " (raw args)" : ""}`);
}

// ─── Build MCP server ───────────────────────────────────────────────────────

const server = new Server(
	{ name: "pi-browser-tools", version: "1.0.0" },
	{ capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} } },
);

const mcpToolVisibilityOptions = resolveMcpToolVisibilityOptions();
const revealedToolGroups = new Set<string>();
let lastToolsListSignature = "";

function currentVisibleTools() {
	return visibleMcpTools(toolDefs, { ...mcpToolVisibilityOptions, revealedGroups: [...revealedToolGroups] });
}

async function notifyToolListChangedIfNeeded(): Promise<void> {
	const nextSignature = currentVisibleTools().map((def) => def.name).join("\n");
	if (nextSignature === lastToolsListSignature) return;
	lastToolsListSignature = nextSignature;
	await server.sendToolListChanged();
}

function parsePromptArguments(value: unknown): Record<string, string | undefined> {
	if (!isRecord(value)) return {};
	const result: Record<string, string | undefined> = {};
	for (const [key, raw] of Object.entries(value)) result[key] = typeof raw === "string" ? raw : raw == null ? undefined : String(raw);
	return result;
}

// ─── Protocol hook call sites (Residual D / Phase 7) ─────────────────────────

// on_initialize fires when the client completes the initialize handshake.
server.oninitialized = () => {
	const ctx = { method: "initialize", startedAt: Date.now() };
	void runHooks("on_initialize", ctx, server.getClientCapabilities())
		.then((r) => emitLog(ctx, Date.now() - ctx.startedAt, r.pass ? "ok" : "error", r.pass ? undefined : { code: r.code }))
		.catch(() => {
			/* best-effort: initialization hooks must never break the handshake */
		});
};

// on_message is the catch-all for methods with no registered handler. The MCP SDK
// exposes no true per-message interceptor — fallback handlers fire ONLY for
// unhandled methods, so registered methods (tools/*, resources/*) do NOT pass
// through on_message. The fallback must still reject unknown methods.
server.fallbackRequestHandler = async (request) => {
	const ctx = { method: request.method, startedAt: Date.now() };
	const r = await runHooks("on_message", ctx, request.params);
	// An unhandled request is always an error outcome (either hook-blocked or method-not-found).
	emitLog(ctx, Date.now() - ctx.startedAt, "error", { code: r.pass ? "METHOD_NOT_FOUND" : r.code });
	if (!r.pass) throw new McpError(ErrorCode.InvalidRequest, `${r.code}: ${r.error}`);
	throw new McpError(ErrorCode.MethodNotFound, `Method not found: ${request.method}`);
};
server.fallbackNotificationHandler = async (notification) => {
	const ctx = { method: notification.method, startedAt: Date.now() };
	await runHooks("on_message", ctx, undefined);
	// Unknown notifications are advisory; swallow after the hook (per JSON-RPC, no response).
};

// tools/list ─────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
	const ctx = { method: "tools/list", startedAt: Date.now() };
	const hookResult = await runHooks("on_list_tools", ctx, null);
	if (!hookResult.pass) {
		emitLog(ctx, Date.now() - ctx.startedAt, "error", { code: hookResult.code });
		throw new Error(`${hookResult.code}: ${hookResult.error}`);
	}

	// Phase 8: capability-gated browser_artifact retirement remains controlled by
	// PI_BROWSER_MCP_KEEP_ARTIFACT through resolveMcpToolVisibilityOptions().
	// Phase 9: optional compact/minimal MCP visibility uses a discovery helper;
	// listChanged:true is declared and notifications are emitted only when the
	// discovery helper reveals an additional group during the session.
	const clientCaps = server.getClientCapabilities();
	const visibleTools = currentVisibleTools();
	lastToolsListSignature = visibleTools.map((def) => def.name).join("\n");

	const response: ListToolsResult = {
		tools: visibleTools.map((def): McpTool => {
			const distillerDef = getDistillerDefinition(def.name);
			const inputSchema = normalizeMcpToolSchema(def.parameters) ?? { type: "object" };
			const outputSchema = normalizeMcpToolSchema(distillerDef?.summarySchema);
			return {
				name: def.name,
				description: def.description,
				// TypeBox Type.Object outputs standard JSON Schema — pass through directly.
				inputSchema,
				// outputSchema declared only for tools with an explicit DistillerDefinition.
				// Clients that support structuredContent will receive the distilled summary.
				...(outputSchema ? { outputSchema } : {}),
				// Informational hints for MCP clients (UIs, hosts). Not security boundaries.
				annotations: TOOL_ANNOTATIONS[def.name],
			};
		}),
	};
	emitLog(ctx, Date.now() - ctx.startedAt, "ok", { toolCount: visibleTools.length, resourcesCapable: clientCaps != null, visibilityProfile: mcpToolVisibilityOptions.profile });
	return response;
});

// tools/call ─────────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	const { name, arguments: args } = request.params;
	const ctx: MiddlewareContext = { method: "tools/call", toolName: name, startedAt: Date.now(), ...(usageLogOptions.enabled ? { args } : {}) };

	// Run on_call_tool hooks (auth/profile/rate-limit checks)
	const hookResult = await runHooks("on_call_tool", ctx, request.params);
	if (!hookResult.pass) {
		emitLog(ctx, Date.now() - ctx.startedAt, "error", { code: hookResult.code });
		return {
			content: [{ type: "text" as const, text: `${hookResult.code}: ${hookResult.error}` }],
			isError: true,
		};
	}

	const def = name === MCP_DISCOVERY_TOOL_NAME
		? currentVisibleTools().find((t) => t.name === name)
		: toolDefs.find((t) => t.name === name && isMcpToolVisible(t.name, mcpToolVisibilityOptions.keepArtifact, mcpToolVisibilityOptions.profile, revealedToolGroups));

	if (!def) {
		emitLog(ctx, Date.now() - ctx.startedAt, "error", { code: "TOOL_NOT_FOUND" });
		return {
			content: [{ type: "text" as const, text: `Unknown or currently hidden tool: ${name}` }],
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

		if (name === MCP_DISCOVERY_TOOL_NAME && typeof validation.args.revealGroup === "string") {
			const revealGroup = validation.args.revealGroup;
			if (revealGroup === "all") {
				for (const group of ["core", "state", "observe", "action", "evidence", "artifact", "web-security"]) revealedToolGroups.add(group);
			} else {
				revealedToolGroups.add(revealGroup);
			}
			await notifyToolListChangedIfNeeded().catch(() => {
				/* best-effort: client may have disconnected before the list_changed notification */
			});
		}

		// For tools with a declared outputSchema, include structuredContent alongside
		// the compatible text. Extract the summary from the existing DistilledEnvelope
		// text (which is already the distilled JSON). Pi adapter path is unchanged.
		let structuredContent: Record<string, unknown> | undefined;
		const resourceLinks: Array<{ type: "resource_link"; uri: string; name: string; description?: string; mimeType?: string }> = [];

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
					const localPath = saved.path;
					let nextEnvelope = envelope;
					let envelopeChanged = false;

					const resourceUri = registerBrowserResultResource({
						kind: "raw-result",
						artifactPath: localPath,
						name: `${name} result`,
						description: `Raw result from ${name} call`,
						mime: typeof saved.mime === "string" ? saved.mime : "application/json",
						bytes: typeof saved.bytes === "number" ? saved.bytes : undefined,
						immutable: true,
					});
					resourceLinks.push({
						type: "resource_link" as const,
						uri: resourceUri,
						name: `${name} artifact`,
						mimeType: typeof saved.mime === "string" ? saved.mime : "application/json",
					});

					// Layer-1 section sub-resources (Residual C). The distiller advertises
					// readable sub-collections via summary.artifact_hints.preferredReads, each
					// with a jsonPath into the raw artifact. Register one section resource per
					// hint (stored jsonPath; resourceReader already honors it) and advertise
					// them as resource_links + envelope.sections.
					const summary = isRecord(envelope.summary) ? envelope.summary : undefined;
					const hints = summary && isRecord(summary.artifact_hints) ? summary.artifact_hints : undefined;
					const preferredReads = hints && Array.isArray(hints.preferredReads) ? hints.preferredReads : [];
					const sections: Array<{ name: string; kind: string; handle: string; count?: number }> = [];
					for (const pr of preferredReads) {
						if (!isRecord(pr) || typeof pr.jsonPath !== "string") continue;
						const label = typeof pr.label === "string" ? pr.label : pr.jsonPath;
						const kind: ResourceKind = RESOURCE_KIND_SET.has(String(pr.kind)) ? (pr.kind as ResourceKind) : "artifact-slice";
						const sectionUri = registerBrowserResultResource({
							kind,
							artifactPath: localPath,
							jsonPath: pr.jsonPath,
							section: label,
							name: `${name}: ${label}`,
							description: `Section ${pr.jsonPath} of ${name} result`,
							mime: "application/json",
							immutable: true,
						});
						resourceLinks.push({ type: "resource_link" as const, uri: sectionUri, name: label, description: `Section ${pr.jsonPath} of ${name} result`, mimeType: "application/json" });
						const dataSliceHandle = resolveRefUriDetailed(`pi-ref://data-slice/${sectionUri.split("://")[1]}`).ok ? `pi-ref://data-slice/${sectionUri.split("://")[1]}` : sectionUri;
						sections.push({ name: label, kind, handle: dataSliceHandle, ...(typeof pr.count === "number" ? { count: pr.count } : {}) });
					}
					if (sections.length) {
						nextEnvelope = { ...nextEnvelope, sections };
						envelopeChanged = true;
					}

					// Phase 5: nextActions adapter transformation.
					// Replace core-generated browser_artifact path=<localPath> entries with
					// MCP resources/read uri=<browser-result://...> equivalents. Pi adapter
					// path keeps the original browser_artifact entries unchanged.
					const nextActions = Array.isArray(envelope.nextActions) ? envelope.nextActions : [];
					const adaptedNextActions = nextActions.map((action) => {
						if (typeof action !== "string") return action;
						if (action.startsWith(`browser_artifact path=${localPath}`)) {
							// Preserve any trailing query options (mode=json jsonPath=...)
							const suffix = action.slice(`browser_artifact path=${localPath}`.length).trim();
							const queryPart = suffix ? `&${suffix.replace(/\s+/g, "&")}` : "";
							return `resources/read uri=${resourceUri}${queryPart}`;
						}
						if (action.startsWith("read_saved_artifact")) {
							const suffix = action.slice("read_saved_artifact".length).trim();
							const queryPart = suffix ? `?${suffix.replace(/\s+/g, "&")}` : "";
							return `resources/read uri=${resourceUri}${queryPart}`;
						}
						return action;
					});
					if (adaptedNextActions.some((a, i) => a !== nextActions[i])) {
						nextEnvelope = { ...nextEnvelope, nextActions: adaptedNextActions };
						envelopeChanged = true;
					}

					if (envelopeChanged) {
						result = {
							...result,
							content: [{ type: "text" as const, text: JSON.stringify(nextEnvelope) }],
						};
					}
				}
			} catch {
				// Best-effort: non-JSON result (e.g. error response) — skip.
			}
		}

		const content = resourceLinks.length
			? [...result.content, ...resourceLinks]
			: result.content;

		if (usageLogOptions.enabled) ctx.resultBytes = JSON.stringify(content).length;
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

// prompts/list ───────────────────────────────────────────────────────────────

server.setRequestHandler(ListPromptsRequestSchema, async () => {
	const ctx = { method: "prompts/list", startedAt: Date.now() };
	const hookResult = await runHooks("on_list_prompts", ctx, null);
	if (!hookResult.pass) {
		emitLog(ctx, Date.now() - ctx.startedAt, "error", { code: hookResult.code });
		throw new Error(`${hookResult.code}: ${hookResult.error}`);
	}
	const response = { prompts: listBrowserPrompts() };
	emitLog(ctx, Date.now() - ctx.startedAt, "ok", { promptCount: response.prompts.length });
	return response;
});

// prompts/get ────────────────────────────────────────────────────────────────

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
	const ctx = { method: "prompts/get", startedAt: Date.now() };
	const hookResult = await runHooks("on_get_prompt", ctx, request.params);
	if (!hookResult.pass) {
		emitLog(ctx, Date.now() - ctx.startedAt, "error", { code: hookResult.code });
		throw new McpError(ErrorCode.InvalidRequest, `${hookResult.code}: ${hookResult.error}`);
	}
	const prompt = getBrowserPrompt(request.params.name, parsePromptArguments(request.params.arguments), toolDefs);
	if (!prompt) {
		emitLog(ctx, Date.now() - ctx.startedAt, "error", { code: "PROMPT_NOT_FOUND" });
		throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${request.params.name}`);
	}
	emitLog(ctx, Date.now() - ctx.startedAt, "ok", { promptName: request.params.name });
	return prompt;
});

// resources/list ─────────────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
	resources: [
		...listResources().map((r) => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mime })),
		...(await listMemoryResources(process.cwd())).map((r) => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mime })),
	],
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
		...memoryResourceTemplates(),
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
	const result = uri.startsWith("browser-memory://")
		? await readMemoryResource(uri, process.cwd())
		: await readBrowserResultResource(uri);
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
