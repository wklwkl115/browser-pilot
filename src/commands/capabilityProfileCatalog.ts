/**
 * Profile metadata owner: name sets only. Does not copy schemas or help.
 * Public tool definitions remain in commandCatalog.ts.
 */

export type CapabilityProfileName = "agent" | "agent-preview" | "expert" | "security" | "admin";

export const AGENT_FACADE_TOOL_NAMES = ["browser_view", "browser_act", "browser_read"] as const;

export const CORE_TOOL_NAMES = [
	"browser_tabs",
	"browser_command",
	"browser_execute",
	"browser_observe",
	"browser_download",
	"browser_upload",
	"browser_network",
	"browser_hook",
	"browser_evidence",
	"browser_frame",
	"browser_screenshot",
	"browser_artifact",
] as const;

export const SECURITY_TOOL_NAMES = [
	"browser_crawl",
	"browser_fuzz",
	"browser_sqli",
	"browser_template",
	"browser_callback_oast",
	"browser_cookie_analyze",
	"browser_http_replay",
] as const;

export const ADMIN_TOOL_NAMES = ["connect", "status", "doctor", "daemon"] as const;

const PROFILE_TOOL_SETS: Record<CapabilityProfileName, readonly string[]> = {
	agent: AGENT_FACADE_TOOL_NAMES,
	"agent-preview": AGENT_FACADE_TOOL_NAMES,
	expert: CORE_TOOL_NAMES,
	security: SECURITY_TOOL_NAMES,
	admin: ADMIN_TOOL_NAMES,
};

export function toolsForProfile(profile: CapabilityProfileName): readonly string[] {
	return PROFILE_TOOL_SETS[profile];
}

export function isAgentFacadeTool(name: string): boolean {
	return (AGENT_FACADE_TOOL_NAMES as readonly string[]).includes(name);
}

export function filterToolsByProfile<T extends { name: string }>(
	tools: readonly T[],
	profile: CapabilityProfileName,
): T[] {
	const allowed = new Set(toolsForProfile(profile));
	return tools.filter((tool) => allowed.has(tool.name));
}

export function parseCapabilityProfile(value: unknown): CapabilityProfileName | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "agent" || normalized === "agent-preview" || normalized === "expert" || normalized === "security" || normalized === "admin") {
		return normalized;
	}
	return undefined;
}
