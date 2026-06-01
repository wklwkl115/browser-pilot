import type { ToolDefinition } from "./adapter.js";

export const MCP_DISCOVERY_TOOL_NAME = "browser_tool_discovery";
const ALL_GROUPS = ["core", "state", "observe", "action", "evidence", "artifact", "web-security"] as const;

type ToolGroup = typeof ALL_GROUPS[number];

export type McpToolVisibilityOptions = {
	keepArtifact: boolean;
	discoveryEnabled: boolean;
	profile?: string;
	revealedGroups?: readonly string[];
};

type ToolVisibilityEntry = {
	groups: ToolGroup[];
	defaultVisible: boolean;
};

const TOOL_VISIBILITY: Record<string, ToolVisibilityEntry> = {
	browser_tabs: { groups: ["core", "state"], defaultVisible: true },
	browser_observe: { groups: ["core", "observe"], defaultVisible: true },
	browser_execute: { groups: ["core", "action"], defaultVisible: true },
	browser_command: { groups: ["core", "action"], defaultVisible: true },
	browser_wait: { groups: ["core", "action"], defaultVisible: true },
	browser_network: { groups: ["core", "evidence"], defaultVisible: true },
	browser_hook: { groups: ["core", "evidence"], defaultVisible: true },
	browser_evidence: { groups: ["core", "evidence"], defaultVisible: true },
	browser_frame: { groups: ["core", "observe"], defaultVisible: true },
	browser_screenshot: { groups: ["core", "observe"], defaultVisible: true },
	browser_pick: { groups: ["core", "action"], defaultVisible: true },
	browser_download: { groups: ["core", "action", "artifact"], defaultVisible: true },
	browser_upload: { groups: ["core", "action"], defaultVisible: true },
	browser_artifact: { groups: ["core", "artifact"], defaultVisible: true },
	browser_memory: { groups: ["core", "artifact"], defaultVisible: true },
	browser_crawl: { groups: ["web-security"], defaultVisible: false },
	browser_fuzz: { groups: ["web-security"], defaultVisible: false },
	browser_sqli: { groups: ["web-security"], defaultVisible: false },
	browser_template: { groups: ["web-security"], defaultVisible: false },
	browser_callback_oast: { groups: ["web-security"], defaultVisible: false },
	browser_cookie_analyze: { groups: ["web-security"], defaultVisible: false },
	browser_http_replay: { groups: ["web-security"], defaultVisible: false },
};

function normalizedVisibilityProfile(profile: string | undefined): string {
	const raw = (profile || "").trim().toLowerCase();
	if (raw === "compact" || raw === "discovery") return "compact";
	if (raw === "minimal") return "minimal";
	return "full";
}

function knownToolNames(toolDefs: readonly ToolDefinition[]): Set<string> {
	return new Set(toolDefs.map((def) => def.name));
}

export function resolveMcpToolVisibilityOptions(env: NodeJS.ProcessEnv = process.env): McpToolVisibilityOptions {
	return {
		keepArtifact: env["PI_BROWSER_MCP_KEEP_ARTIFACT"] === "1",
		discoveryEnabled: env["PI_BROWSER_MCP_DISCOVERY"] !== "0",
		profile: normalizedVisibilityProfile(env["PI_BROWSER_MCP_TOOL_VISIBILITY"]),
	};
}

export function visibleMcpTools(toolDefs: readonly ToolDefinition[], options: McpToolVisibilityOptions): ToolDefinition[] {
	const profile = normalizedVisibilityProfile(options.profile);
	const knownNames = knownToolNames(toolDefs);
	const revealedGroups = new Set(options.revealedGroups || []);
	const visible = toolDefs.filter((def) => isMcpToolVisible(def.name, options.keepArtifact, profile, revealedGroups));
	return options.discoveryEnabled && !knownNames.has(MCP_DISCOVERY_TOOL_NAME)
		? [discoveryToolDefinition(toolDefs), ...visible]
		: visible;
}

export function isMcpToolVisible(toolName: string, keepArtifact: boolean, profile: string | undefined, revealedGroups: ReadonlySet<string>): boolean {
	const normalizedProfile = normalizedVisibilityProfile(profile);
	if (toolName === MCP_DISCOVERY_TOOL_NAME) return true;
	if (toolName === "browser_artifact" && !keepArtifact) return false;
	const entry = TOOL_VISIBILITY[toolName];
	if (normalizedProfile === "full") return true;
	if (!entry) return normalizedProfile !== "minimal";
	if (entry.groups.some((group) => revealedGroups.has(group))) return true;
	if (normalizedProfile === "minimal") return entry.groups.includes("state") || entry.groups.includes("observe");
	return entry.defaultVisible;
}

export function discoveryToolDefinition(toolDefs: readonly ToolDefinition[]): ToolDefinition {
	const names = knownToolNames(toolDefs);
	return {
		name: MCP_DISCOVERY_TOOL_NAME,
		label: "Browser Tool Discovery",
		description: "Lightweight MCP discovery helper that lists available pi-browser tool groups and tool names without exposing the full tool schemas.",
		promptSnippet: "Discover available pi-browser MCP tool groups and hidden tools when tools/list is compact.",
		promptGuidelines: ["Use this only to inspect available pi-browser tool names/groups; call the actual tool explicitly after choosing one."],
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				group: { type: "string", enum: [...ALL_GROUPS], description: "Optional group filter." },
				revealGroup: { type: "string", enum: [...ALL_GROUPS, "all"], description: "Optional group to reveal in subsequent tools/list calls when the server runs in compact/minimal visibility mode." },
				includeDescriptions: { type: "boolean", description: "Include short tool descriptions." },
			},
		},
		execute: async (_toolCallId, params) => {
			const args = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
			const group = typeof args.group === "string" ? args.group : undefined;
			const revealGroup = typeof args.revealGroup === "string" ? args.revealGroup : undefined;
			const includeDescriptions = args.includeDescriptions === true;
			const tools = toolDefs
				.filter((def) => names.has(def.name))
				.map((def) => ({ def, entry: TOOL_VISIBILITY[def.name] ?? { groups: ["core" as const], defaultVisible: true } }))
				.filter(({ entry }) => !group || entry.groups.includes(group as ToolGroup))
				.map(({ def, entry }) => ({
					name: def.name,
					groups: entry.groups,
					defaultVisible: entry.defaultVisible,
					...(includeDescriptions && def.description ? { description: def.description } : {}),
				}));
			return {
				content: [{
					type: "text" as const,
					text: JSON.stringify({ groups: ALL_GROUPS, revealGroup, count: tools.length, tools }),
				}],
			};
		},
	};
}
