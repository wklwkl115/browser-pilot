export type BrowserToolCapabilityProfileName = "security" | "core";

export type BrowserToolCapabilityProfile = {
	name: BrowserToolCapabilityProfileName;
	source: "default" | "env";
	envVar: "PI_BROWSER_TOOL_PROFILE";
	securityToolsEnabled: boolean;
	enableHint: string;
	warnings?: string[];
};

const PROFILE_ENV_VAR = "PI_BROWSER_TOOL_PROFILE" as const;
const CORE_PROFILE_ENABLE_HINT = `${PROFILE_ENV_VAR}=security then /reload`;

type ProcessEnvLike = Record<string, string | undefined>;

function normalizeProfileName(value: unknown): { name: BrowserToolCapabilityProfileName; recognized: boolean } {
	const text = String(value || "").trim().toLowerCase();
	if (!text) return { name: "core", recognized: true };
	if (text === "core") return { name: "core", recognized: true };
	if (text === "security" || text === "default" || text === "full" || text === "ctf") return { name: "security", recognized: true };
	return { name: "core", recognized: false };
}

export function resolveBrowserToolCapabilityProfile(env: ProcessEnvLike = process.env): BrowserToolCapabilityProfile {
	const raw = env[PROFILE_ENV_VAR];
	const normalized = normalizeProfileName(raw);
	const warnings = raw && raw.trim() && !normalized.recognized
		? [`Unrecognized ${PROFILE_ENV_VAR}=${raw}; falling back to core profile.`]
		: undefined;
	return {
		name: normalized.name,
		source: raw && raw.trim() ? "env" : "default",
		envVar: PROFILE_ENV_VAR,
		securityToolsEnabled: normalized.name === "security",
		enableHint: CORE_PROFILE_ENABLE_HINT,
		warnings,
	};
}
