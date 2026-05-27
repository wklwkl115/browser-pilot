export type BrowserToolCapabilityProfileName = "security" | "core";

export type BrowserToolCapabilityProfile = {
	name: BrowserToolCapabilityProfileName;
	source: "default" | "env";
	envVar: "PI_BROWSER_TOOL_PROFILE";
	securityToolsEnabled: boolean;
	enableHint: string;
};

const PROFILE_ENV_VAR = "PI_BROWSER_TOOL_PROFILE" as const;

function normalizeProfileName(value: unknown): BrowserToolCapabilityProfileName {
	const text = String(value || "").trim().toLowerCase();
	if (text === "core") return "core";
	if (text === "security" || text === "default" || text === "full" || text === "ctf") return "security";
	return "security";
}

export function resolveBrowserToolCapabilityProfile(env: NodeJS.ProcessEnv = process.env): BrowserToolCapabilityProfile {
	const raw = env[PROFILE_ENV_VAR];
	const name = normalizeProfileName(raw);
	return {
		name,
		source: raw && raw.trim() ? "env" : "default",
		envVar: PROFILE_ENV_VAR,
		securityToolsEnabled: name === "security",
		enableHint: `${PROFILE_ENV_VAR}=security then /reload`,
	};
}
