import { createInterface } from "node:readline";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserCommandDefinitions } from "../../commands/commandDefinitions.js";
import type { CommandDefinition } from "../../commands/commandManifestIndex.js";
import { publicNativeCommandNames } from "../../commands/nativeCommandAccess.js";
import { getNativeCommandProtocolSchema } from "../../types/nativeProtocol.js";
import { packageVersion } from "../daemon/packageInfo.js";
import { invokeDaemonTool } from "./client.js";
import { runMcpPairing } from "./auth.js";

type JsonRpcId = string | number | null;
type JsonRpcMessage = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
type McpContent = { type: "text"; text: string } | { type: "resource_link"; uri: string; name: string; mimeType?: string };
type McpTool = { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, boolean> };
type McpToolResult = { content: McpContent[]; structuredContent?: Record<string, unknown>; isError?: boolean; _meta?: Record<string, unknown> };
type McpServerState = { initialized: boolean; projectRoot: string; clientName: string; supportsRoots: boolean; rootRefresh?: Promise<void> };
type PendingServerRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

const LATEST_PROTOCOL_VERSION = "2025-11-25";
const PROTOCOL_VERSIONS = new Set([LATEST_PROTOCOL_VERSION]);
const PAIR_TOOL_NAME = "browser_pair";
const NATIVE_COMMANDS_URI = "browser-pilot://native-commands";
const definitions = browserCommandDefinitions();
const byName = new Map(definitions.map((definition) => [definition.name, definition]));
const pairingTool: McpTool = {
	name: PAIR_TOOL_NAME,
	description: "Pair this MCP agent with the connected Browser Pilot extension.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["start", "wait"] },
			label: { type: "string", description: "Agent label for action=start." },
			pairingId: { type: "string", description: "Pairing ID returned by action=start, required for action=wait." },
			timeoutMs: { type: "number", minimum: 0, maximum: 120_000 },
		},
		required: ["action"],
	},
};

function toolDescription(definition: CommandDefinition): string | undefined {
	const parts = [definition.description, definition.promptSnippet, ...(definition.promptGuidelines ?? [])]
		.filter((value): value is string => typeof value === "string" && !!value.trim());
	return [...new Set(parts)].join("\n\n") || undefined;
}

function toolAnnotations(name: string): Record<string, boolean> | undefined {
	if (name === "browser_observe") return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
	if (name === "browser_artifact") return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
	return undefined;
}

export function mcpTools(): McpTool[] {
	return [...definitions.map((definition) => ({
			name: definition.name,
			description: toolDescription(definition),
			inputSchema: definition.parameters && typeof definition.parameters === "object"
				? definition.parameters as Record<string, unknown>
				: { type: "object", properties: {} },
			...(toolAnnotations(definition.name) ? { annotations: toolAnnotations(definition.name) } : {}),
		})), pairingTool];
}

export function mcpProjectRoot(): string {
	return path.resolve(process.env.BROWSER_PILOT_PROJECT_ROOT || process.cwd());
}

function recordJsonText(content: Array<{ type: "text"; text: string }>): Record<string, unknown> | undefined {
	if (content.length !== 1) return undefined;
	try {
		const value = JSON.parse(content[0].text) as unknown;
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function artifactResourceUri(savedPath: unknown, projectRoot: string): string | undefined {
	if (typeof savedPath !== "string" || !savedPath.trim()) return undefined;
	const root = path.resolve(projectRoot, ".browser-pilot", "artifacts");
	const target = path.isAbsolute(savedPath) ? path.resolve(savedPath) : path.resolve(projectRoot, savedPath);
	const relative = path.relative(root, target);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
	return `browser-pilot://artifact/${relative.split(path.sep).map(encodeURIComponent).join("/")}`;
}

function mimeTypeFor(filePath: string): string {
	switch (path.extname(filePath).toLowerCase()) {
		case ".json": return "application/json";
		case ".png": return "image/png";
		case ".jpg":
		case ".jpeg": return "image/jpeg";
		case ".webp": return "image/webp";
		case ".html": return "text/html";
		case ".txt":
		case ".log": return "text/plain";
		default: return "application/octet-stream";
	}
}

function resourceLink(details: Record<string, unknown> | undefined, projectRoot: string): McpContent | undefined {
	const saved = record(details?.saved);
	const uri = artifactResourceUri(saved.path, projectRoot);
	if (!uri) return undefined;
	const filePath = String(saved.path);
	return { type: "resource_link", uri, name: path.basename(filePath), mimeType: typeof saved.mime === "string" ? saved.mime : mimeTypeFor(filePath) };
}

function jsonToolResult(value: Record<string, unknown>): McpToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

export async function callMcpTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, projectRoot = mcpProjectRoot(), clientName = ""): Promise<McpToolResult> {
	if (name === PAIR_TOOL_NAME) {
		try {
			return jsonToolResult(await runMcpPairing(args, signal, projectRoot, clientName));
		} catch (error) {
			return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
		}
	}
	if (!byName.has(name)) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
	try {
		const result = await invokeDaemonTool(name, args, projectRoot, signal, clientName);
		const link = resourceLink(result.details, projectRoot);
		return {
			content: [...result.content, ...(link ? [link] : [])],
			...(recordJsonText(result.content) ? { structuredContent: recordJsonText(result.content) } : {}),
			isError: result.isError === true || result.terminate === true,
			...(result.details ? { _meta: { "browser-pilot/details": result.details } } : {}),
		};
	} catch (error) {
		return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
	}
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requestId(value: unknown): JsonRpcId | undefined {
	return typeof value === "string" || typeof value === "number" || value === null ? value : undefined;
}

function send(message: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id: JsonRpcId, value: unknown): void {
	send({ jsonrpc: "2.0", id, result: value });
}

function error(id: JsonRpcId, code: number, message: string): void {
	send({ jsonrpc: "2.0", id, error: { code, message } });
}

export function mcpResources() {
	return [{
		uri: NATIVE_COMMANDS_URI,
		name: "Browser Pilot native command catalog",
		description: "Command names, fields, access modes, and validation rules accepted by browser_command.",
		mimeType: "application/json",
	}];
}

function safeArtifactPath(uri: string, projectRoot: string): string | undefined {
	let parsed: URL;
	try { parsed = new URL(uri); } catch { return undefined; }
	if (parsed.protocol !== "browser-pilot:" || parsed.hostname !== "artifact") return undefined;
	const relative = decodeURIComponent(parsed.pathname.slice(1));
	if (!relative) return undefined;
	const root = path.resolve(projectRoot, ".browser-pilot", "artifacts");
	const target = path.resolve(root, relative);
	const fromRoot = path.relative(root, target);
	return fromRoot && !fromRoot.startsWith("..") && !path.isAbsolute(fromRoot) ? target : undefined;
}

export async function readMcpResource(uri: string, projectRoot = mcpProjectRoot()) {
	if (uri === NATIVE_COMMANDS_URI) {
		const schema = getNativeCommandProtocolSchema();
		const publicNames = new Set(publicNativeCommandNames());
		const publicSchema = {
			...schema,
			domains: Object.fromEntries(Object.entries(schema.domains).map(([domain, commands]) => [domain, commands.filter((command) => publicNames.has(command))]).filter(([, commands]) => commands.length)),
			commands: Object.fromEntries(Object.entries(schema.commands).filter(([command]) => publicNames.has(command))),
		};
		return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(publicSchema) }] };
	}
	const requested = safeArtifactPath(uri, projectRoot);
	if (!requested) throw new Error(`Unknown or invalid resource URI: ${uri}`);
	const root = await realpath(path.resolve(projectRoot, ".browser-pilot", "artifacts"));
	const target = await realpath(requested);
	const relative = path.relative(root, target);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Artifact resource is outside the project artifact root");
	const data = await readFile(target);
	const mimeType = mimeTypeFor(target);
	return mimeType.startsWith("text/") || mimeType === "application/json"
		? { contents: [{ uri, mimeType, text: data.toString("utf8") }] }
		: { contents: [{ uri, mimeType, blob: data.toString("base64") }] };
}

let nextServerRequestId = 1;

function serverRequest(method: string, pending: Map<JsonRpcId, PendingServerRequest>): Promise<unknown> {
	const id = `browser-pilot-${nextServerRequestId++}`;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`${method} timed out`));
		}, 5_000);
		timer.unref?.();
		pending.set(id, { resolve, reject, timer });
		send({ jsonrpc: "2.0", id, method, params: {} });
	});
}

async function refreshProjectRoot(state: McpServerState, pending: Map<JsonRpcId, PendingServerRequest>): Promise<void> {
	if (!state.supportsRoots) return;
	try {
		const response = record(await serverRequest("roots/list", pending));
		const roots = Array.isArray(response.roots) ? response.roots : [];
		// ponytail: first client root; add per-call root selection when multi-root routing is required.
		const uri = record(roots[0]).uri;
		if (typeof uri === "string" && uri.startsWith("file:")) state.projectRoot = path.resolve(fileURLToPath(uri));
	} catch {
		// cwd/environment remains the compatibility fallback when Roots is unavailable.
	}
}

function handleServerResponse(message: JsonRpcMessage, pending: Map<JsonRpcId, PendingServerRequest>): boolean {
	if (message.jsonrpc !== "2.0") return false;
	const id = requestId(message.id);
	if (id === undefined || typeof message.method === "string") return false;
	const request = pending.get(id);
	if (!request) return false;
	clearTimeout(request.timer);
	pending.delete(id);
	if (message.error !== undefined) request.reject(new Error(JSON.stringify(message.error)));
	else request.resolve(message.result);
	return true;
}

async function handleRequest(message: JsonRpcMessage, active: Map<JsonRpcId, AbortController>, pending: Map<JsonRpcId, PendingServerRequest>, state: McpServerState): Promise<void> {
	if (handleServerResponse(message, pending)) return;
	const id = requestId(message.id);
	if (message.jsonrpc !== "2.0") return error(id ?? null, -32600, "Invalid Request: jsonrpc must be 2.0");
	const method = typeof message.method === "string" ? message.method : "";
	const params = record(message.params);
	if (method === "notifications/initialized") {
		state.rootRefresh = refreshProjectRoot(state, pending);
		return;
	}
	if (method === "notifications/roots/list_changed") {
		state.rootRefresh = refreshProjectRoot(state, pending);
		return;
	}
	if (method === "notifications/cancelled") {
		const cancelledId = requestId(params.requestId);
		if (cancelledId !== undefined) active.get(cancelledId)?.abort();
		return;
	}
	if (id === undefined) return;
	if (method === "initialize") {
		if (state.initialized) return error(id, -32600, "Server already initialized");
		const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
			const capabilities = params.capabilities;
			const clientInfo = params.clientInfo;
			if (!requested || !capabilities || typeof capabilities !== "object" || Array.isArray(capabilities) || typeof record(clientInfo).name !== "string") return error(id, -32602, "Invalid initialize parameters");
			result(id, {
				protocolVersion: PROTOCOL_VERSIONS.has(requested) ? requested : LATEST_PROTOCOL_VERSION,
				capabilities: { tools: {}, resources: {} },
				serverInfo: { name: "browser-pilot", version: packageVersion() },
			});
			state.initialized = true;
			state.clientName = record(clientInfo).name as string;
			state.supportsRoots = !!record(capabilities).roots;
			return;
	}
	if (!state.initialized) return error(id, -32002, "Server not initialized");
	if (state.rootRefresh) {
		await state.rootRefresh;
		state.rootRefresh = undefined;
	}
	if (method === "ping") return result(id, {});
	if (method === "tools/list") return result(id, { tools: mcpTools() });
	if (method === "resources/list") return result(id, { resources: mcpResources() });
	if (method === "resources/templates/list") return result(id, { resourceTemplates: [{ uriTemplate: "browser-pilot://artifact/{path}", name: "Browser Pilot artifact", description: "A file produced under the current project .browser-pilot/artifacts directory." }] });
	if (method === "resources/read") {
		const uri = typeof params.uri === "string" ? params.uri : "";
		if (!uri) return error(id, -32602, "resources/read requires uri");
		try { return result(id, await readMcpResource(uri, state.projectRoot)); }
		catch (cause) { return error(id, -32002, cause instanceof Error ? cause.message : String(cause)); }
	}
	if (method !== "tools/call") return error(id, -32601, `Method not found: ${method}`);
	const name = typeof params.name === "string" ? params.name : "";
	const rawArgs = params.arguments;
	if (!name || (rawArgs !== undefined && (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)))) {
		return error(id, -32602, "Invalid tools/call parameters");
	}
	const args = record(rawArgs);
	const controller = new AbortController();
	const progressToken = record(params._meta).progressToken;
	let progress = 0;
	let heartbeat: NodeJS.Timeout | undefined;
	if (typeof progressToken === "string" || typeof progressToken === "number") {
		send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress, message: `${name} started` } });
		// ponytail: elapsed heartbeat; stream daemon phases if semantic progress becomes necessary.
		heartbeat = setInterval(() => send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: ++progress, message: `${name} is running` } }), 1_000);
		heartbeat.unref?.();
	}
		active.set(id, controller);
		try {
			result(id, await callMcpTool(name, args, controller.signal, state.projectRoot, state.clientName));
	} finally {
		if (heartbeat) clearInterval(heartbeat);
		active.delete(id);
	}
}

export async function runMcpServer(): Promise<void> {
	const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
	const active = new Map<JsonRpcId, AbortController>();
	const pending = new Map<JsonRpcId, PendingServerRequest>();
	const state: McpServerState = { initialized: false, projectRoot: mcpProjectRoot(), clientName: "", supportsRoots: false };
	lines.on("line", (line) => {
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(line) as JsonRpcMessage;
		} catch {
			error(null, -32700, "Parse error");
			return;
		}
			void handleRequest(message, active, pending, state).catch((cause) => {
			const id = requestId(message.id);
			if (id !== undefined) error(id, -32603, cause instanceof Error ? cause.message : String(cause));
		});
	});
	await new Promise<void>((resolve) => lines.once("close", resolve));
	for (const controller of active.values()) controller.abort();
	for (const request of pending.values()) {
		clearTimeout(request.timer);
		request.reject(new Error("MCP transport closed"));
	}
}
