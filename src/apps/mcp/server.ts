import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ErrorCode,
	ListResourceTemplatesRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	McpError,
	ReadResourceRequestSchema,
	RootsListChangedNotificationSchema,
	type CallToolResult,
	type ReadResourceResult,
	type Resource,
	type ResourceTemplate,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { browserCommandDefinitions } from "../../commands/commandDefinitions.js";
import type { CommandDefinition } from "../../commands/commandManifestIndex.js";
import {
	coreNativeCommandNames,
	nativeCommandTier,
	publicNativeCommandNames,
} from "../../commands/nativeCommandAccess.js";
import { getNativeCommandProtocolSchema } from "../../types/nativeProtocol.js";
import { packageVersion } from "../daemon/packageInfo.js";
import { invokeDaemonTool } from "./client.js";
import { getJsonPath } from "../../utils/jsonPath.js";
import { PAGE_OBSERVATION_VIEW_JSON_SCHEMA, type PageObservationV3 } from "../../kernels/abml/pageObservation.js";
import { isPageObservationV3, isPageObservationView } from "../../validation/pageContracts.js";
import {
	OBSERVATION_RESOURCE_URI_PREFIX,
	OBSERVATION_RESOURCES_DETAIL_KEY,
	publicCausal,
	publicCollection,
	publicGist,
	publicRelations,
	publicSnapshotProjection,
	publicTreeDiff,
	publicVisual,
	publicWarnings,
	semanticContentSections,
	type ObservationResourceDescriptor,
} from "../../commands/observe/observationResources.js";
import { publicToolValue } from "../../utils/toolResult.js";
import { artifactResourceUri } from "../../artifacts/artifactFiles.js";

type McpContent =
	{ type: "text"; text: string } | { type: "resource_link"; uri: string; name: string; mimeType?: string };
type McpToolResult = { content: McpContent[]; structuredContent?: Record<string, unknown>; isError?: boolean };
type McpServerState = { projectRoot: string; rootRefresh?: Promise<void> };

/** MCP "Resource not found" code; the SDK enum does not include the resource-specific range. */
const RESOURCE_NOT_FOUND = -32002;
const ROOTS_LIST_TIMEOUT_MS = 5_000;
const SERVER_INSTRUCTIONS = [
	"Use the selected active tab by default; call browser_tabs list only to disambiguate tabs.",
	"Call browser_observe only when page understanding is required; observed bp-ref values route later calls automatically.",
	"Use browser_execute for JavaScript and browser_command for native or trusted input.",
	"Combine deterministic same-page JavaScript in one browser_execute call, attach expect when a write must be verified, and re-observe only when the next decision depends on new page state.",
	"Read browser-pilot://native-command/<cmd> only when an unfamiliar native command's fields are needed.",
].join(" ");
const NATIVE_COMMANDS_URI = "browser-pilot://native-commands";
const NATIVE_COMMAND_URI_PREFIX = "browser-pilot://native-command/";
const definitions = browserCommandDefinitions();
const byName = new Map(definitions.map((definition) => [definition.name, definition]));
const observationResources = new Map<string, ObservationResourceDescriptor & { projectRoot: string }>();
const MAX_OBSERVATION_RESOURCES = 1024;
const OBSERVATION_RESOURCE_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function toolDescription(definition: CommandDefinition): string | undefined {
	const parts = [definition.description, ...(definition.promptGuidelines ?? [])].filter(
		(value): value is string => typeof value === "string" && !!value.trim(),
	);
	return [...new Set(parts)].join("\n\n") || undefined;
}

function toolAnnotations(name: string): Tool["annotations"] | undefined {
	if (name === "browser_observe")
		return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
	return undefined;
}

/**
 * One-line meaning per top-level `browser_observe` key. The advertised outputSchema is shallow on
 * purpose: agents decide from these descriptions, while the full nested contract in
 * PAGE_OBSERVATION_VIEW_JSON_SCHEMA keeps validating every result before it leaves the server.
 */
const OBSERVE_VIEW_KEY_DESCRIPTIONS: Record<keyof typeof PAGE_OBSERVATION_VIEW_JSON_SCHEMA.properties, string> = {
	target: "{ url } of the observed tab.",
	content: "Readable page text plus headings; complete:false means more text is behind a frontier resource.",
	visual: "When a screenshot was attached: image ref, resourceUri, size, and normalized target boxes per ref.",
	gist: "Title and landmark roles present; one-glance orientation.",
	outline: "Containers with member counts and refs; the skeleton of the page.",
	actionSpace:
		"items: actionable controls with ref, role, name, current value/placeholder/inputKind for fields, href for links, actions (click/edit), state, scope; coverage says whether all controls were captured.",
	relations: "Accessibility relation counts plus a few highlights.",
	causal: "Network requests and page events since the baseline, attributed to the last action, or unavailable.",
	treeDiff: "Summary of repeated-structure changes since the baseline (appeared/disappeared/changed/reordered).",
	collections: "Recognised lists/tables with observed/total counts and a completeness verdict.",
	frontier: "Everything not inlined, each with a kind, state, and resourceUri or unavailableReason.",
	warnings: "Human-readable notes about degraded capture or partial coverage.",
	nextActions: "Short hints about sensible follow-ups.",
};

const OBSERVE_TOOL_OUTPUT_SCHEMA = {
	type: "object",
	properties: Object.fromEntries(
		Object.entries(PAGE_OBSERVATION_VIEW_JSON_SCHEMA.properties).map(([key, schema]) => [
			key,
			{
				type: (schema as { type?: string; anyOf?: unknown }).anyOf
					? "object"
					: (schema as { type: string }).type,
				description: OBSERVE_VIEW_KEY_DESCRIPTIONS[key as keyof typeof OBSERVE_VIEW_KEY_DESCRIPTIONS],
			},
		]),
	),
	required: [...PAGE_OBSERVATION_VIEW_JSON_SCHEMA.required],
	additionalProperties: false,
} satisfies NonNullable<Tool["outputSchema"]>;

function toolOutputSchema(name: string): Tool["outputSchema"] | undefined {
	if (name === "browser_observe") return OBSERVE_TOOL_OUTPUT_SCHEMA;
	if (name === "browser_tabs")
		return {
			type: "object",
			properties: {
				tabs: {
					type: "array",
					items: {
						type: "object",
						properties: {
							targetRef: { type: "string" },
							url: { type: "string" },
							title: { type: "string" },
							active: { type: "boolean" },
							incognito: { type: "boolean" },
						},
						additionalProperties: false,
					},
				},
				effect: {
					type: "object",
					description: "navigate only: whether the page changed and settled, including navigation from/to.",
					additionalProperties: true,
				},
			},
			required: ["tabs"],
			additionalProperties: false,
		};
	if (name === "browser_screenshot")
		return {
			type: "object",
			properties: {
				captured: { type: "boolean" },
				width: { type: "number" },
				height: { type: "number" },
				mime: { type: "string" },
			},
			required: ["captured"],
			additionalProperties: false,
		};
	return undefined;
}

export function mcpTools(): Tool[] {
	return definitions.map((definition) => {
		const outputSchema = toolOutputSchema(definition.name);
		const annotations = toolAnnotations(definition.name);
		return {
			name: definition.name,
			description: toolDescription(definition),
			inputSchema:
				definition.parameters && typeof definition.parameters === "object"
					? (definition.parameters as Tool["inputSchema"])
					: { type: "object", properties: {} },
			...(outputSchema ? { outputSchema } : {}),
			...(annotations ? { annotations } : {}),
		};
	});
}

export function mcpProjectRoot(): string {
	return path.resolve(process.env.BROWSER_PILOT_PROJECT_ROOT || process.cwd());
}

function recordJsonText(content: Array<{ type: "text"; text: string }>): Record<string, unknown> | undefined {
	if (content.length !== 1) return undefined;
	try {
		const value = JSON.parse(content[0].text) as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function mimeTypeFor(filePath: string): string {
	switch (path.extname(filePath).toLowerCase()) {
		case ".json":
			return "application/json";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		case ".html":
			return "text/html";
		case ".txt":
		case ".log":
			return "text/plain";
		default:
			return "application/octet-stream";
	}
}

function resourceLink(details: Record<string, unknown> | undefined, projectRoot: string): McpContent | undefined {
	const saved = record(details?.saved);
	const uri = typeof saved.path === "string" ? artifactResourceUri(saved.path, projectRoot) : undefined;
	if (!uri) return undefined;
	const filePath = String(saved.path);
	return {
		type: "resource_link",
		uri,
		name: path.basename(filePath),
		mimeType: typeof saved.mime === "string" ? saved.mime : mimeTypeFor(filePath),
	};
}

function visualResourceLink(
	observation: Record<string, unknown> | undefined,
	projectRoot: string,
): McpContent | undefined {
	const visual = record(observation?.visual);
	const uri = typeof visual.resourceUri === "string" ? visual.resourceUri : undefined;
	const target = uri ? safeArtifactPath(uri, projectRoot) : undefined;
	return uri && target
		? { type: "resource_link", uri, name: path.basename(target), mimeType: "image/png" }
		: undefined;
}

function observationResourceToken(uri: string): string | undefined {
	if (!uri.startsWith(OBSERVATION_RESOURCE_URI_PREFIX)) return undefined;
	const token = uri.slice(OBSERVATION_RESOURCE_URI_PREFIX.length);
	return OBSERVATION_RESOURCE_TOKEN.test(token) ? token : undefined;
}

function pruneObservationResources(now = Date.now()): void {
	for (const [token, descriptor] of observationResources) {
		if (descriptor.expiresAt <= now) observationResources.delete(token);
	}
}

function validObservationResourceTarget(descriptor: ObservationResourceDescriptor): boolean {
	if (descriptor.kind === "content")
		return (
			Number.isInteger(descriptor.contentSection) &&
			Number(descriptor.contentSection) >= 0 &&
			descriptor.jsonPath === undefined
		);
	if (descriptor.contentSection !== undefined || typeof descriptor.jsonPath !== "string") return false;
	if (descriptor.kind === "collection-window") return /^collections\[\d+\]$/.test(descriptor.jsonPath);
	if (descriptor.kind === "action-space") return descriptor.jsonPath === "actionSpace";
	if (descriptor.kind === "details")
		return /^(treeDiff|causal|relations|snapshotProjection|collections|\$)$/.test(descriptor.jsonPath);
	return false;
}

function completeSemanticObservation(observation: PageObservationV3): Record<string, unknown> {
	const title = observation.content?.headings?.[0];
	const gist = publicGist(observation.gist, title);
	const visual = publicVisual(observation.visual);
	const causal = publicCausal(observation.causal);
	const relations = publicRelations(observation.relations);
	const snapshotProjection = publicSnapshotProjection(observation.snapshotProjection);
	const treeDiff = publicTreeDiff(observation.treeDiff);
	const warnings = publicWarnings(observation.diagnostics);
	const outline = observation.outline?.flatMap((item) =>
		typeof item.container === "string" && typeof item.memberCount === "number" && Array.isArray(item.memberRefs)
			? [
					{
						container: item.container,
						...(typeof item.name === "string" ? { name: item.name } : {}),
						memberCount: item.memberCount,
						...(typeof item.controlCount === "number" ? { controlCount: item.controlCount } : {}),
						memberRefs: item.memberRefs.filter(
							(ref): ref is string => typeof ref === "string" && ref.startsWith("bp-ref://"),
						),
					},
				]
			: [],
	);
	const collections = observation.collections?.map(publicCollection);
	return {
		target: { ...(observation.target.url ? { url: observation.target.url } : {}) },
		...(observation.content ? { content: observation.content } : {}),
		...(visual ? { visual } : {}),
		...(gist ? { gist } : {}),
		...(outline?.length ? { outline } : {}),
		...(observation.actionSpace ? { actionSpace: observation.actionSpace } : {}),
		...(relations ? { relations } : {}),
		...(causal ? { causal } : {}),
		...(treeDiff ? { treeDiff } : {}),
		...(snapshotProjection ? { snapshotProjection } : {}),
		...(collections?.length ? { collections } : {}),
		...(warnings.length ? { warnings } : {}),
		...(observation.nextActions?.length ? { nextActions: observation.nextActions } : {}),
	};
}

export function registerMcpObservationResources(
	details: Record<string, unknown> | undefined,
	projectRoot: string,
): McpContent[] {
	const now = Date.now();
	pruneObservationResources(now);
	const raw = details?.[OBSERVATION_RESOURCES_DETAIL_KEY];
	if (!Array.isArray(raw)) return [];
	const resolvedProjectRoot = path.resolve(projectRoot);
	const root = path.resolve(resolvedProjectRoot, ".browser-pilot", "artifacts");
	const links: McpContent[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object" || Array.isArray(item)) continue;
		const descriptor = item as ObservationResourceDescriptor;
		const token = typeof descriptor.uri === "string" ? observationResourceToken(descriptor.uri) : undefined;
		const target = typeof descriptor.path === "string" ? path.resolve(descriptor.path) : "";
		const relative = target ? path.relative(root, target) : "";
		if (
			!token ||
			!relative ||
			relative.startsWith("..") ||
			path.isAbsolute(relative) ||
			descriptor.mimeType !== "application/json" ||
			typeof descriptor.name !== "string" ||
			!descriptor.name.trim() ||
			typeof descriptor.snapshotId !== "string" ||
			!descriptor.snapshotId.trim() ||
			typeof descriptor.ref !== "string" ||
			!descriptor.ref.trim() ||
			(descriptor.label !== undefined && typeof descriptor.label !== "string") ||
			!["action-space", "collection-window", "content", "details"].includes(descriptor.kind) ||
			!Number.isFinite(descriptor.expiresAt) ||
			descriptor.expiresAt <= now ||
			!validObservationResourceTarget(descriptor)
		)
			continue;
		observationResources.set(token, { ...descriptor, projectRoot: resolvedProjectRoot });
		while (observationResources.size > MAX_OBSERVATION_RESOURCES)
			observationResources.delete(observationResources.keys().next().value!);
		links.push({ type: "resource_link", uri: descriptor.uri, name: descriptor.name, mimeType: "application/json" });
	}
	return links;
}

function publicContent(content: McpContent[]): McpContent[] {
	return content.map((item) => {
		if (item.type !== "text") return item;
		return { ...item, text: publicJsonText(item.text) };
	});
}

/** Strip runtime routing fields from JSON text; non-JSON text passes through unchanged. */
function publicJsonText(value: string): string {
	try {
		return JSON.stringify(publicToolValue(JSON.parse(value) as unknown));
	} catch {
		return value;
	}
}

function observationSummary(value: Record<string, unknown>): string {
	const target = record(value.target);
	const content = record(value.content);
	const title = record(value.gist).title;
	const actionables = Array.isArray(record(value.actionSpace).items)
		? (record(value.actionSpace).items as unknown[]).length
		: 0;
	const frontier = Array.isArray(record(value.frontier).items) ? (record(value.frontier).items as unknown[]) : [];
	return `Observed ${typeof title === "string" ? title : typeof target.url === "string" ? target.url : "page"}: ${actionables} actionables, ${frontier.length} expandable regions${content.complete === false ? ", additional content available" : ""}.`;
}

export async function callMcpTool(
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
	projectRoot = mcpProjectRoot(),
): Promise<McpToolResult> {
	if (!byName.has(name)) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
	try {
		const result = await invokeDaemonTool(name, args, projectRoot, signal);
		const resourceLinks = registerMcpObservationResources(result.details, projectRoot);
		const link = resourceLink(result.details, projectRoot);
		const isError = result.isError === true || result.terminate === true;
		const content = isError ? publicContent(result.content) : result.content;
		const textContent = content.filter((item): item is { type: "text"; text: string } => item.type === "text");
		const structuredContent = isError ? undefined : recordJsonText(textContent);
		const observation =
			name === "browser_observe" && structuredContent && isPageObservationView(structuredContent)
				? structuredContent
				: undefined;
		const visualLink = visualResourceLink(observation, projectRoot);
		return {
			content: [
				...(observation ? [{ type: "text" as const, text: observationSummary(observation) }] : content),
				...resourceLinks,
				...(visualLink ? [visualLink] : []),
				...(link ? [link] : []),
			],
			...(structuredContent ? { structuredContent } : {}),
			isError,
		};
	} catch (error) {
		return {
			content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
			isError: true,
		};
	}
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function mcpResources(): Resource[] {
	return [
		{
			uri: NATIVE_COMMANDS_URI,
			name: "Browser Pilot native command index",
			description:
				"Canonical command names grouped by tier (core vs advanced) and capability, with access modes and required fields.",
			mimeType: "application/json",
		},
	];
}

export function mcpResourceTemplates(): ResourceTemplate[] {
	return [
		{
			uriTemplate: `${NATIVE_COMMAND_URI_PREFIX}{command}`,
			name: "Browser Pilot native command",
			description: "The exact fields and validation rules for one canonical browser_command command.",
		},
		{
			uriTemplate: `${OBSERVATION_RESOURCE_URI_PREFIX}{token}`,
			name: "Browser Pilot observation region",
			description: "An immutable semantic region returned by browser_observe.",
		},
	];
}

function safeArtifactPath(uri: string, projectRoot: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "browser-pilot:" || parsed.hostname !== "artifact") return undefined;
	const relative = decodeURIComponent(parsed.pathname.slice(1));
	if (!relative) return undefined;
	const root = path.resolve(projectRoot, ".browser-pilot", "artifacts");
	const target = path.resolve(root, relative);
	const fromRoot = path.relative(root, target);
	return fromRoot && !fromRoot.startsWith("..") && !path.isAbsolute(fromRoot) ? target : undefined;
}

export async function readMcpResource(uri: string, projectRoot = mcpProjectRoot()): Promise<ReadResourceResult> {
	if (uri === NATIVE_COMMANDS_URI) {
		const schema = getNativeCommandProtocolSchema();
		const publicNames = new Set(publicNativeCommandNames());
		const publicSchema = {
			name: schema.name,
			version: schema.version,
			tiers: {
				core: coreNativeCommandNames(),
				advanced: [...publicNames].filter((command) => nativeCommandTier(command) === "advanced"),
			},
			domains: Object.fromEntries(
				Object.entries(schema.domains)
					.map(([domain, commands]) => [domain, commands.filter((command) => publicNames.has(command))])
					.filter(([, commands]) => commands.length),
			),
			commands: Object.fromEntries(
				[...publicNames].map((command) => {
					const {
						paramsSchema: _paramsSchema,
						domain: _domain,
						tabScoped: _tabScoped,
						requiredAny: _requiredAny,
						methods: _methods,
						methodRequired: _methodRequired,
						methodSpecs: _methodSpecs,
						...summary
					} = schema.commands[command]!;
					return [command, summary];
				}),
			),
		};
		return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(publicSchema) }] };
	}
	if (uri.startsWith(NATIVE_COMMAND_URI_PREFIX)) {
		const command = decodeURIComponent(uri.slice(NATIVE_COMMAND_URI_PREFIX.length));
		const schema = getNativeCommandProtocolSchema();
		if (!publicNativeCommandNames().includes(command))
			throw new Error(`Unknown native command resource: ${command}`);
		const spec = schema.commands[command]!;
		const { requiredAny: _requiredAny, ...paramsSchema } = spec.paramsSchema ?? {
			type: "object",
			properties: {},
			additionalProperties: false,
		};
		return {
			contents: [
				{
					uri,
					mimeType: "application/json",
					text: JSON.stringify({
						command,
						accessMode: spec.accessMode,
						...(spec.notes ? { notes: spec.notes } : {}),
						paramsSchema,
					}),
				},
			],
		};
	}
	const observationToken = observationResourceToken(uri);
	if (observationToken) {
		const descriptor = observationResources.get(observationToken);
		const now = Date.now();
		pruneObservationResources(now);
		if (!descriptor || descriptor.projectRoot !== path.resolve(projectRoot))
			throw new Error(`Unknown observation resource: ${uri}`);
		if (descriptor.expiresAt <= now) throw new Error(`Observation resource expired: ${uri}`);
		const root = await realpath(path.resolve(projectRoot, ".browser-pilot", "artifacts"));
		const target = await realpath(descriptor.path);
		const relative = path.relative(root, target);
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
			throw new Error("Observation resource is outside the project artifact root");
		const observation = JSON.parse(await readFile(target, "utf8")) as unknown;
		if (!isPageObservationV3(observation) || observation.snapshot.snapshotId !== descriptor.snapshotId)
			throw new Error("Observation resource snapshot mismatch");
		let value: unknown;
		if (descriptor.contentSection !== undefined) {
			const section = observation.content
				? semanticContentSections(observation.content)[descriptor.contentSection]
				: undefined;
			if (!section) throw new Error("Observation content region is unavailable");
			value = { label: section.label, text: section.text };
		} else if (descriptor.jsonPath === "$") {
			value = completeSemanticObservation(observation);
		} else if (descriptor.jsonPath) {
			const selected = getJsonPath(observation, descriptor.jsonPath);
			if (!selected.exists) throw new Error(`Observation resource path is unavailable: ${descriptor.ref}`);
			if (descriptor.jsonPath === "causal") value = publicCausal(observation.causal);
			else if (descriptor.jsonPath === "relations") value = publicRelations(observation.relations);
			else if (descriptor.jsonPath === "snapshotProjection")
				value = publicSnapshotProjection(observation.snapshotProjection);
			else if (descriptor.jsonPath === "treeDiff") value = publicTreeDiff(observation.treeDiff);
			else if (descriptor.jsonPath === "collections" && Array.isArray(selected.value))
				value = selected.value.map((collection) =>
					publicCollection(collection as NonNullable<PageObservationV3["collections"]>[number]),
				);
			else if (descriptor.kind === "collection-window")
				value = publicCollection(selected.value as NonNullable<PageObservationV3["collections"]>[number]);
			else value = selected.value;
		} else {
			throw new Error("Observation resource target is invalid");
		}
		const payload = publicToolValue({
			ref: descriptor.ref,
			kind: descriptor.kind,
			...(descriptor.label ? { label: descriptor.label } : {}),
			value,
		});
		return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(payload) }] };
	}
	const requested = safeArtifactPath(uri, projectRoot);
	if (!requested) throw new Error(`Unknown or invalid resource URI: ${uri}`);
	const root = await realpath(path.resolve(projectRoot, ".browser-pilot", "artifacts"));
	const target = await realpath(requested);
	const relative = path.relative(root, target);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
		throw new Error("Artifact resource is outside the project artifact root");
	const data = await readFile(target);
	const mimeType = mimeTypeFor(target);
	return mimeType === "application/json"
		? { contents: [{ uri, mimeType, text: publicJsonText(data.toString("utf8")) }] }
		: mimeType.startsWith("text/")
			? { contents: [{ uri, mimeType, text: data.toString("utf8") }] }
			: { contents: [{ uri, mimeType, blob: data.toString("base64") }] };
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Resolve the artifact project root from the client's first filesystem root.
 * Multi-root clients currently pin the first root; cwd/environment stays the
 * fallback when the client does not advertise the Roots capability.
 */
async function refreshProjectRoot(server: Server, state: McpServerState): Promise<void> {
	if (!server.getClientCapabilities()?.roots) return;
	try {
		const { roots } = await server.listRoots(undefined, { timeout: ROOTS_LIST_TIMEOUT_MS });
		const uri = roots[0]?.uri;
		if (typeof uri === "string" && uri.startsWith("file:")) state.projectRoot = path.resolve(fileURLToPath(uri));
	} catch {
		// Roots are advisory; keep the previous project root when the client cannot answer.
	}
}

async function settledProjectRoot(state: McpServerState): Promise<string> {
	if (state.rootRefresh) {
		await state.rootRefresh;
		state.rootRefresh = undefined;
	}
	return state.projectRoot;
}

export function createMcpServer(): Server {
	const state: McpServerState = { projectRoot: mcpProjectRoot() };
	const server = new Server(
		{ name: "browser-pilot", version: packageVersion() },
		{ capabilities: { tools: {}, resources: {} }, instructions: SERVER_INSTRUCTIONS },
	);
	const scheduleRootRefresh = () => {
		state.rootRefresh = refreshProjectRoot(server, state);
	};

	server.oninitialized = scheduleRootRefresh;
	server.setNotificationHandler(RootsListChangedNotificationSchema, scheduleRootRefresh);
	server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: mcpTools() }));
	server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: mcpResources() }));
	server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: mcpResourceTemplates() }));
	server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
		const projectRoot = await settledProjectRoot(state);
		try {
			return await readMcpResource(params.uri, projectRoot);
		} catch (cause) {
			throw new McpError(RESOURCE_NOT_FOUND, errorMessage(cause));
		}
	});
	server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra): Promise<CallToolResult> => {
		if (!byName.has(params.name)) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${params.name}`);
		const projectRoot = await settledProjectRoot(state);
		return await callMcpTool(params.name, params.arguments ?? {}, extra.signal, projectRoot);
	});
	return server;
}

export async function runMcpServer(): Promise<void> {
	const server = createMcpServer();
	const transport = new StdioServerTransport();
	const closed = new Promise<void>((resolve) => {
		server.onclose = resolve;
	});
	// The SDK transport only listens for stdin data; an EOF from the client must still end the process.
	process.stdin.once("end", () => {
		void server.close();
	});
	await server.connect(transport);
	await closed;
}
