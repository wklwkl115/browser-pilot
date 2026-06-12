import type { CliCommand } from "./registry.js";
import type { GlobalFlags } from "./flags.js";
import { nativeToolMetadata } from "../src/protocol/nativeActionMetadata.js";

export type ActionParamMeta = { action: string; aliases?: readonly string[]; required?: readonly string[]; requiredAny?: readonly (readonly string[])[]; notes?: string };
export type NativeActionToolMeta = { actionDescription?: string; actions?: readonly ActionParamMeta[] };
export type NaturalActionInvocation = { action: string; token: string };
export type AgentCliRouting =
	| { mode: "standard"; recommended: true }
	| { mode: "natural"; recommended: true; action: string; naturalSubcommand: string; translatesTo: { action: string; params: "nativeActionParams" } }
	| { mode: "advancedCompatibility"; recommended: false; interface: "--action/--params"; reason: string[] }
	| { mode: "nativeEscapeHatch"; recommended: false; interface: "command --command"; reason: string[] };

const NATURAL_ACTION_ALLOWLIST: Record<string, readonly string[]> = {
	browser_wait: ["navigate", "navigateAndWait", "navigation", "loadState", "networkIdle", "selector", "any", "all", "cancel", "diagnose"],
	browser_network: ["start", "stop", "status", "clear", "list", "get", "body", "exportHar", "wait"],
	browser_frame: ["list", "evaluate"],
	browser_hook: ["listTargets", "installTargets", "listSessions", "install", "status", "collect", "clear", "pause", "resume", "uninstall", "performance"],
};

export function kebabAction(action: string): string {
	return action.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`).replace(/_/g, "-").toLowerCase();
}

export function kebabParam(name: string): string {
	return name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function normalizeActionName(value: string): string {
	return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function nativeActionToolMeta(toolName: string): NativeActionToolMeta | undefined {
	const tools = nativeToolMetadata.nativeActionTools as unknown as Record<string, NativeActionToolMeta>;
	return tools[toolName];
}

export function supportsNaturalActionRouting(cmd: CliCommand): boolean {
	return Boolean(NATURAL_ACTION_ALLOWLIST[cmd.name]?.length);
}

export function naturalActionMetas(cmd: CliCommand): readonly ActionParamMeta[] {
	const allowed = NATURAL_ACTION_ALLOWLIST[cmd.name];
	if (!allowed?.length) return [];
	const allowedSet = new Set(allowed);
	return (nativeActionToolMeta(cmd.name)?.actions ?? []).filter((action) => allowedSet.has(action.action));
}

export function naturalActionForToken(cmd: CliCommand, token: string): string | undefined {
	if (!supportsNaturalActionRouting(cmd)) return undefined;
	const wanted = normalizeActionName(token);
	for (const action of naturalActionMetas(cmd)) {
		const names = [action.action, kebabAction(action.action), ...(action.aliases ?? [])];
		if (names.some((name) => normalizeActionName(name) === wanted)) return action.action;
	}
	return undefined;
}

function actionToolCompatibilityRouting(cmd: CliCommand): AgentCliRouting | undefined {
	if (!nativeActionToolMeta(cmd.name)?.actions?.length) return undefined;
	return {
		mode: "advancedCompatibility",
		recommended: false,
		interface: "--action/--params",
		reason: ["compatibility", "full-native-action-coverage", "advanced-json-escape-hatch"],
	};
}

export function commandRouting(cmd: CliCommand): AgentCliRouting {
	if (cmd.name === "browser_command") {
		return {
			mode: "nativeEscapeHatch",
			recommended: false,
			interface: "command --command",
			reason: ["full-native-bridge-command-access", "advanced-json-escape-hatch"],
		};
	}
	const compat = actionToolCompatibilityRouting(cmd);
	if (compat) return compat;
	return { mode: "standard", recommended: true };
}

export function naturalRouting(action: string): AgentCliRouting {
	return {
		mode: "natural",
		recommended: true,
		action,
		naturalSubcommand: kebabAction(action),
		translatesTo: { action, params: "nativeActionParams" },
	};
}

export function legacyActionUsed(cmd: CliCommand, argv: string[]): boolean {
	return Boolean(nativeActionToolMeta(cmd.name)?.actions?.length) && hasFlag(argv, "--action");
}

function hasFlag(argv: string[], flag: string): boolean {
	return argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

export function translateNaturalActionArgv(cmd: CliCommand, argv: string[]): { ok: true; argv: string[]; natural?: NaturalActionInvocation } | { ok: false; error: string; globals: GlobalFlags } {
	if (!supportsNaturalActionRouting(cmd)) return { ok: true, argv };
	let index = 0;
	const globals: GlobalFlags = { json: false, text: false, help: false };
	while (argv[index] === "--json" || argv[index] === "--text") {
		if (argv[index] === "--json") { globals.json = true; globals.text = false; }
		if (argv[index] === "--text") { globals.text = true; globals.json = false; }
		index += 1;
	}
	const token = argv[index];
	if (!token || token.startsWith("--")) return { ok: true, argv };
	const action = naturalActionForToken(cmd, token);
	if (!action) return { ok: true, argv };
	const rest = [...argv.slice(0, index), ...argv.slice(index + 1)];
	if (hasFlag(rest, "--action")) {
		return { ok: false, error: `pi-browser ${cmd.subcommand} ${token} cannot be combined with --action; use either the natural subcommand or the legacy --action form`, globals };
	}
	return { ok: true, argv: [...argv.slice(0, index), "--action", action, ...argv.slice(index + 1)], natural: { action, token } };
}
