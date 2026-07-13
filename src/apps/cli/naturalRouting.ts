import type { CliCommand } from "./registry.js";
import type { GlobalFlags } from "./flags.js";
import { nativeToolMetadata } from "../../commands/nativeActionMetadata.js";
import { kebabCaseAction, publicActionsForDefinition } from "../../commands/publicActionCatalog.js";
import { isRecord } from "../../utils/records.js";

export type ActionParamMeta = { action: string; aliases?: readonly string[]; required?: readonly string[]; requiredAny?: readonly (readonly string[])[]; paramsSchema?: Record<string, unknown>; notes?: string };
export type NativeActionToolMeta = { actionDescription?: string; actions?: readonly ActionParamMeta[] };
export type NaturalSubcommandInvocation = {
	token: string;
	parameter: string;
	value: string;
	action?: string;
	owner: "public-action" | "command";
};
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

function schemaLiteralValues(value: unknown): unknown[] {
	if (!isRecord(value)) return [];
	if (Object.prototype.hasOwnProperty.call(value, "const")) return [value.const];
	if (Array.isArray(value.enum)) return [...value.enum];
	if (Array.isArray(value.anyOf)) return value.anyOf.flatMap((entry) => schemaLiteralValues(entry));
	return [];
}

function commandOwnedSubcommands(cmd: CliCommand): NaturalSubcommandInvocation[] {
	const root = isRecord(cmd.parameters) ? cmd.parameters : {};
	const properties = isRecord(root.properties) ? root.properties : {};
	return (cmd.def.cliSubcommands ?? []).map((metadata) => {
		if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(metadata.token)) throw new Error(`Invalid CLI subcommand token for ${cmd.name}: ${metadata.token}`);
		const property = properties[metadata.parameter];
		if (!property) throw new Error(`CLI subcommand ${cmd.name}:${metadata.token} references unknown parameter ${metadata.parameter}`);
		const literals = schemaLiteralValues(property);
		if (literals.length > 0 && !literals.includes(metadata.value)) throw new Error(`CLI subcommand ${cmd.name}:${metadata.token} value ${metadata.value} is not allowed by ${metadata.parameter}`);
		return { token: metadata.token, parameter: metadata.parameter, value: metadata.value, owner: "command" as const };
	});
}

export function naturalSubcommandRoutes(cmd: CliCommand): NaturalSubcommandInvocation[] {
	const routes: NaturalSubcommandInvocation[] = [
		...publicActionsForDefinition(cmd.def).map((action) => ({
			token: action.cliAction,
			parameter: "action",
			value: action.action,
			action: action.action,
			owner: "public-action" as const,
		})),
		...commandOwnedSubcommands(cmd),
	];
	const tokens = new Set<string>();
	for (const route of routes) {
		if (tokens.has(route.token)) throw new Error(`Duplicate natural CLI subcommand for ${cmd.name}:${route.token}`);
		tokens.add(route.token);
	}
	return routes;
}

export function supportsNaturalSubcommandRouting(cmd: CliCommand): boolean {
	return naturalSubcommandRoutes(cmd).length > 0;
}

export function naturalActionMetas(cmd: CliCommand): readonly ActionParamMeta[] {
	return publicActionsForDefinition(cmd.def).map((action) => ({
		action: action.action,
		required: action.required,
		requiredAny: action.requiredAny,
		paramsSchema: action.paramsSchema,
		...(action.notes ? { notes: action.notes } : {}),
	}));
}

export function naturalActionForToken(cmd: CliCommand, token: string): string | undefined {
	return naturalSubcommandRoutes(cmd).find((route) => route.token === token)?.action;
}

export function naturalSubcommandForToken(cmd: CliCommand, token: string): NaturalSubcommandInvocation | undefined {
	return naturalSubcommandRoutes(cmd).find((route) => route.token === token);
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
	return naturalSubcommandRoutes(cmd).some((route) => route.parameter === "action") && hasFlag(argv, "--action");
}

function hasFlag(argv: string[], flag: string): boolean {
	return argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

export function translateNaturalActionArgv(cmd: CliCommand, argv: string[]): { ok: true; argv: string[]; natural?: NaturalSubcommandInvocation } | { ok: false; error: string; globals: GlobalFlags } {
	if (!supportsNaturalSubcommandRouting(cmd)) return { ok: true, argv };
	let index = 0;
	const globals: GlobalFlags = { json: false, text: false, help: false };
	while (argv[index] === "--json" || argv[index] === "--text") {
		if (argv[index] === "--json") { globals.json = true; globals.text = false; }
		if (argv[index] === "--text") { globals.text = true; globals.json = false; }
		index += 1;
	}
	const token = argv[index];
	if (!token || token.startsWith("--")) return { ok: true, argv };
	const natural = naturalSubcommandForToken(cmd, token);
	if (!natural) return { ok: true, argv };
	const rest = [...argv.slice(0, index), ...argv.slice(index + 1)];
	const flag = `--${kebabParam(natural.parameter)}`;
	if (hasFlag(rest, flag)) {
		return { ok: false, error: `browser-pilot ${cmd.subcommand} ${token} cannot be combined with ${flag}; use either the natural subcommand or the advanced flag form`, globals };
	}
	return { ok: true, argv: [...argv.slice(0, index), flag, natural.value, ...argv.slice(index + 1)], natural };
}
