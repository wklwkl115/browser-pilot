import type { CliCommand } from "./registry.js";
import type { GlobalFlags } from "./flags.js";
import { nativeToolMetadata } from "../../commands/nativeActionMetadata.js";
import { kebabCaseAction, publicActionsForDefinition } from "../../commands/publicActionCatalog.js";

export type ActionParamMeta = { action: string; aliases?: readonly string[]; required?: readonly string[]; requiredAny?: readonly (readonly string[])[]; notes?: string };
export type NativeActionToolMeta = { actionDescription?: string; actions?: readonly ActionParamMeta[] };
export type NaturalActionInvocation = { action: string; token: string };
export type AgentCliRouting =
	| { mode: "standard"; recommended: true }
	| { mode: "natural"; recommended: true; action: string; naturalSubcommand: string; translatesTo: { action: string; params: "nativeActionParams" } }
	| { mode: "advancedCompatibility"; recommended: false; interface: "--action/--params"; reason: string[] }
	| { mode: "nativeEscapeHatch"; recommended: false; interface: "command --command"; reason: string[] };

export function kebabAction(action: string): string {
	return kebabCaseAction(action);
}

export function kebabParam(name: string): string {
	return name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

export function nativeActionToolMeta(commandName: string): NativeActionToolMeta | undefined {
	const tools = nativeToolMetadata.nativeActionTools as unknown as Record<string, NativeActionToolMeta>;
	return tools[commandName];
}

export function supportsNaturalActionRouting(cmd: CliCommand): boolean {
	return publicActionsForDefinition(cmd.def).length > 0;
}

export function naturalActionMetas(cmd: CliCommand): readonly ActionParamMeta[] {
	return publicActionsForDefinition(cmd.def).map((action) => ({
		action: action.action,
		required: action.required,
		requiredAny: action.requiredAny,
		...(action.notes ? { notes: action.notes } : {}),
	}));
}

export function naturalActionForToken(cmd: CliCommand, token: string): string | undefined {
	if (!supportsNaturalActionRouting(cmd)) return undefined;
	return publicActionsForDefinition(cmd.def).find((action) => action.cliAction === token)?.action;
}

function actionToolCompatibilityRouting(cmd: CliCommand): AgentCliRouting | undefined {
	if (!publicActionsForDefinition(cmd.def).length) return undefined;
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
	return publicActionsForDefinition(cmd.def).length > 0 && hasFlag(argv, "--action");
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
		return { ok: false, error: `browser-pilot ${cmd.subcommand} ${token} cannot be combined with --action; use either the natural subcommand or the legacy --action form`, globals };
	}
	return { ok: true, argv: [...argv.slice(0, index), "--action", action, ...argv.slice(index + 1)], natural: { action, token } };
}
