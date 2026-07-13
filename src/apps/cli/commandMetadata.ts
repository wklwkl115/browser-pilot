import type { CliCommand } from "./registry.js";
import { buildFlagSpecs, type FlagSpec } from "./flags.js";
import { pad } from "./help.js";
import { nativeToolMetadata } from "../../commands/nativeActionMetadata.js";
import { paramClassOf, type ParamClass } from "../../commands/commandShared.js";
import { isRecord } from "../../utils/records.js";
import {
	commandRouting,
	kebabAction,
	kebabParam,
	naturalActionMetas,
	naturalRouting,
	naturalSubcommandRoutes,
	supportsNaturalSubcommandRouting,
	type ActionParamMeta,
	type AgentCliRouting,
	type NaturalSubcommandInvocation,
} from "./naturalRouting.js";

const WEB_SECURITY_TOOL_NAMES = new Set([
	"browser_crawl",
	"browser_fuzz",
	"browser_sqli",
	"browser_template",
	"browser_callback_oast",
	"browser_cookie_analyze",
	"browser_http_replay",
]);

type ArtifactBehavior = {
	resultField: "saved.path";
	descriptorFields: string[];
	readCommand: string;
	readModes: string[];
	commonJsonPaths: string[];
	notes: string[];
};

const ARTIFACT_BEHAVIOR: ArtifactBehavior = {
	resultField: "saved.path",
	descriptorFields: ["path", "kind", "bytes", "chars", "privacy", "jsonPaths", "readCommands"],
	readCommand: "browser-pilot artifact inspect --path <saved.path> --json",
	readModes: ["inspect", "paths", "json", "text", "search", "sample"],
	commonJsonPaths: [],
	notes: [
		"JSON results that include saved.path are enriched with one artifacts[] descriptor per saved path; jsonPaths lists a bounded set of returned hints independently from the bounded readCommands descriptors.",
		"readCommands starts with inspect/paths and adds at most one targeted JSON template. Both display commands and argvTemplate use placeholders; pathRef/jsonPathRef resolve the exact descriptor fields without repeating untrusted values in shell text.",
		"Large or sensitive raw payloads stay in local artifacts; verify paths, then read bounded values with browser-pilot artifact. cliNextActions[] only carries non-duplicate structured follow-ups.",
	],
};

/** Per-action `--params` keys, surfaced from the generated native protocol metadata. */
export function nativeActionParamsHelp(commandName: string): string[] {
	const tools = nativeToolMetadata.nativeActionTools as unknown as Record<string, { actions?: readonly ActionParamMeta[] }>;
	const actions = tools[commandName]?.actions;
	if (!actions?.length) return [];
	const rows: string[] = [];
	for (const a of actions) {
		const parts: string[] = [];
		if (a.required?.length) parts.push(`requires ${a.required.join(", ")}`);
		if (a.requiredAny?.length) parts.push(`requires one of ${a.requiredAny.map((g) => g.join("+")).join(" | ")}`);
		if (a.notes) parts.push(a.notes);
		if (parts.length) rows.push(`  ${pad(a.action, 18)}${parts.join("; ")}`);
	}
	return rows;
}

const COMMA_SPLIT_ARRAY_FLAGS = new Set([
	"secretCandidates", "secrets", "wordlist", "words", "paths", "urls",
	"templates", "templateIds", "templatePaths", "workflowPaths", "paramNames",
	"hosts", "tags", "excludeTags", "severities", "authors", "schemes", "ports",
	"knownFiles", "probeTypes",
]);

function withCommaSplit(spec: FlagSpec): FlagSpec {
	if (spec.kind !== "array" || spec.split || !COMMA_SPLIT_ARRAY_FLAGS.has(spec.name)) return spec;
	const note = "Accepts comma-separated values or a repeated flag.";
	return { ...spec, split: "comma" as const, description: spec.description && !spec.description.includes(note) ? `${spec.description} ${note}` : spec.description ?? note };
}

export function buildCommandFlagSpecs(cmd: CliCommand): FlagSpec[] {
	const specs = buildFlagSpecs(cmd.parameters).map((spec) => {
		if (cmd.name === "browser_command" && spec.name === "command") {
			return { ...spec, valueReferences: false, description: `${spec.description ?? "Bridge command object."} CLI accepts inline JSON only; use browser_execute --program @file, --script @file, or --script - for larger inputs.` };
		}
		if (cmd.name === "browser_execute" && spec.name === "script") {
			return { ...spec, description: `${spec.description ?? "JavaScript to execute."} CLI accepts inline source, @file, or stdin (-). Temporary JavaScript must stay in memory: use inline only for short shell-safe code, use stdin for complex/generated code, and never create a transient script file. @file is for durable source.` };
		}
		return spec;
	});
	return specs.map(withCommaSplit);
}

function actionParamNames(action: ActionParamMeta): Set<string> {
	const names = new Set<string>();
	for (const key of action.required ?? []) names.add(key);
	for (const group of action.requiredAny ?? []) for (const key of group) names.add(key);
	return names;
}

export function actionSpecificFlagSpecs(cmd: CliCommand, actionName: string): FlagSpec[] {
	const action = naturalActionMetas(cmd).find((item) => item.action === actionName);
	if (!action) return buildCommandFlagSpecs(cmd).filter((spec) => spec.name !== "action");
	const commonNames = new Set(["browserSessionId", "tabId", "targetRef", "sessionId", "timeoutMs", "maxChars", "outputPath", "detailLevel", "redact"]);
	const common = buildCommandFlagSpecs(cmd).filter((spec) => commonNames.has(spec.name));
	const paramsSchema = isRecord(action.paramsSchema) ? action.paramsSchema : {};
	const paramSpecs = buildFlagSpecs(paramsSchema).map(withCommaSplit).map((spec) => {
		if (cmd.name === "browser_hook" && actionName === "installTargets" && spec.name === "targets") {
			return { ...spec, split: "comma" as const, description: `${spec.description ?? "Hook target ids."} Accepts comma-separated values or a repeated flag.` };
		}
		return spec;
	});
	return [...common, ...paramSpecs];
}

export function nestNaturalActionParams(cmd: CliCommand, actionName: string | undefined, params: Record<string, unknown>): Record<string, unknown> {
	if (!actionName) return params;
	const action = naturalActionMetas(cmd).find((item) => item.action === actionName);
	const properties = isRecord(action?.paramsSchema) && isRecord(action.paramsSchema.properties) ? action.paramsSchema.properties : {};
	const nested = isRecord(params.params) ? { ...params.params } : {};
	const output = { ...params };
	for (const key of Object.keys(properties)) {
		if (output[key] === undefined) continue;
		nested[key] = output[key];
		delete output[key];
	}
	if (Object.keys(nested).length) output.params = nested;
	return output;
}

/**
 * Read a flag's intent/mechanical class from the command schema.
 * Synthetic CLI-only flags with no schema property default to intent.
 */
function paramClassFor(cmd: CliCommand, name: string): ParamClass {
	const root = isRecord(cmd.parameters) ? cmd.parameters : {};
	const props = isRecord(root.properties) ? root.properties as Record<string, unknown> : {};
	return paramClassOf(props[name]);
}

function schemaForFlagSpec(spec: FlagSpec): Record<string, unknown> {
	if (spec.kind === "boolean") return { type: "boolean", ...(spec.description ? { description: spec.description } : {}) };
	if (spec.kind === "number") return { type: "number", ...(spec.description ? { description: spec.description } : {}) };
	if (spec.kind === "array") return { type: "array", ...(spec.description ? { description: spec.description } : {}) };
	if (spec.kind === "json") return { type: "object", ...(spec.description ? { description: spec.description } : {}) };
	if (spec.kind === "enum" && spec.choices) return { anyOf: spec.choices.map((choice) => ({ const: choice })), ...(spec.description ? { description: spec.description } : {}) };
	return { type: "string", ...(spec.description ? { description: spec.description } : {}) };
}

export function schemaForFlagSpecs(cmd: CliCommand, specs: FlagSpec[]): Record<string, unknown> {
	const root = isRecord(cmd.parameters) ? cmd.parameters : {};
	const rootProperties = isRecord(root.properties) ? root.properties as Record<string, unknown> : {};
	const properties: Record<string, unknown> = {};
	for (const spec of specs) properties[spec.name] = rootProperties[spec.name] ?? schemaForFlagSpec(spec);
	const required = specs.filter((spec) => spec.required).map((spec) => spec.name);
	return {
		type: "object",
		properties,
		...(required.length ? { required } : {}),
		additionalProperties: false,
	};
}

export function invocationFlagSpecs(cmd: CliCommand, naturalAction?: string): FlagSpec[] {
	if (!naturalAction) return buildCommandFlagSpecs(cmd);
	const actionSpec = buildCommandFlagSpecs(cmd).find((spec) => spec.name === "action");
	return [
		...(actionSpec ? [actionSpec] : []),
		...actionSpecificFlagSpecs(cmd, naturalAction),
	];
}

function naturalSubcommandRows(cmd: CliCommand): string[] {
	const actions = new Map(naturalActionMetas(cmd).map((action) => [action.action, action]));
	return naturalSubcommandRoutes(cmd).map((route) => {
		if (!route.action) return `  ${pad(route.token, 18)}browser-pilot ${cmd.subcommand} ${route.token}`;
		const action = actions.get(route.action);
		if (!action) throw new Error(`Missing action metadata for ${cmd.name}:${route.action}`);
		const parts: string[] = [];
		const required = [...actionParamNames(action)];
		if (required.length) parts.push(`requires --${required.map(kebabParam).join(" / --")}`);
		if (action.notes) parts.push(action.notes);
		const example = required.length === 1 ? `browser-pilot ${cmd.subcommand} ${kebabAction(action.action)} --${kebabParam(required[0])} ...` : `browser-pilot ${cmd.subcommand} ${kebabAction(action.action)}`;
		return `  ${pad(kebabAction(action.action), 18)}${parts.length ? `${parts.join("; ")} · ` : ""}${example}`;
	});
}

function helpFlagSpecs(cmd: CliCommand, natural?: NaturalSubcommandInvocation): FlagSpec[] {
	if (natural?.action) return actionSpecificFlagSpecs(cmd, natural.action);
	if (natural) return buildCommandFlagSpecs(cmd).filter((spec) => spec.name !== natural.parameter);
	return buildCommandFlagSpecs(cmd);
}

function renderHelpFlag(spec: FlagSpec): string {
	const meta = spec.kind === "enum" && spec.choices ? ` (${spec.choices.join("|")})` : spec.kind === "boolean" ? "" : ` <${spec.kind}>`;
	return `  ${pad(`${spec.flag}${meta}`, 30)}${spec.required ? "[required] " : ""}${spec.description ?? ""}`.trimEnd();
}

function appendAdvancedEquivalent(lines: string[], cmd: CliCommand, natural?: NaturalSubcommandInvocation): void {
	if (!natural) return;
	if (natural.action) {
		lines.push("", `Advanced equivalent: browser-pilot ${cmd.subcommand} --action ${natural.action} --params <json>`);
		return;
	}
	lines.push("", `Advanced equivalent: browser-pilot ${cmd.subcommand} --${kebabParam(natural.parameter)} ${natural.value}`);
}

function appendCommandInputNotes(lines: string[], cmd: CliCommand, natural?: NaturalSubcommandInvocation): void {
	if (natural) return;
	if (cmd.name === "browser_command") lines.push("", "File input note: --command accepts inline JSON only; do not use --command @file.");
	if (cmd.name === "browser_execute") lines.push("", "Input rule: temporary JavaScript must stay in memory. Use inline source only for short shell-safe code and --script - for complex/generated stdin; never create a transient script file. Reserve --script @file for durable source. Use --program @file for JSON/newline program frames.");
}

export function printCommandHelp(cmd: CliCommand, natural?: NaturalSubcommandInvocation): void {
	const specs = helpFlagSpecs(cmd, natural);
	const title = natural ? `browser-pilot ${cmd.subcommand} ${natural.token}` : `browser-pilot ${cmd.subcommand}`;
	const lines = [`${title}${cmd.description ? ` — ${cmd.description}` : ""}`, ""];
	const naturalRows = natural ? [] : naturalSubcommandRows(cmd);
	if (naturalRows.length) {
		lines.push("Natural subcommands (recommended):", ...naturalRows, "");
	}
	// Split the agent's real choices from ignorable plumbing.
	const intentSpecs = specs.filter((s) => paramClassFor(cmd, s.name) === "intent");
	const plumbingSpecs = specs.filter((s) => paramClassFor(cmd, s.name) === "mechanical");
	lines.push(natural ? "Flags:" : supportsNaturalSubcommandRouting(cmd) ? "Advanced flags:" : "Flags:");
	for (const spec of intentSpecs) lines.push(renderHelpFlag(spec));
	if (plumbingSpecs.length) {
		lines.push("", "Plumbing (optional; defaults apply — usually omit):");
		for (const spec of plumbingSpecs) lines.push(renderHelpFlag(spec));
	}
	const actionParams = natural ? [] : nativeActionParamsHelp(cmd.name);
	if (actionParams.length) {
		lines.push("", "Per-action --params keys (a JSON object; optional keys may also apply — see the action list above):", ...actionParams);
	}
	appendAdvancedEquivalent(lines, cmd, natural);
	appendCommandInputNotes(lines, cmd, natural);
	process.stdout.write(`${lines.join("\n")}\n`);
}

export function commandGroup(cmd: CliCommand): "core" | "security" {
	return WEB_SECURITY_TOOL_NAMES.has(cmd.name) ? "security" : "core";
}

export function commandGroupCounts(commands: CliCommand[]): Record<"core" | "security", number> {
	return commands.reduce<Record<"core" | "security", number>>((counts, cmd) => {
		counts[commandGroup(cmd)] += 1;
		return counts;
	}, { core: 0, security: 0 });
}

export function artifactBehaviorMetadata(): ArtifactBehavior {
	return {
		...ARTIFACT_BEHAVIOR,
		descriptorFields: [...ARTIFACT_BEHAVIOR.descriptorFields],
		readModes: [...ARTIFACT_BEHAVIOR.readModes],
		commonJsonPaths: [...ARTIFACT_BEHAVIOR.commonJsonPaths],
		notes: [...ARTIFACT_BEHAVIOR.notes],
	};
}

export function flagMetadata(cmd: CliCommand, naturalAction?: string): Record<string, unknown>[] {
	const specs = naturalAction ? actionSpecificFlagSpecs(cmd, naturalAction) : buildCommandFlagSpecs(cmd);
	return specs.map((spec) => {
		const referenceInputs = spec.valueReferences === false ? [] : spec.kind === "json" || spec.kind === "array" || spec.kind === "string" ? ["@file", "stdin"] : [];
		return {
			name: spec.name,
			flag: spec.flag,
			kind: spec.kind,
			required: spec.required,
			paramClass: paramClassFor(cmd, spec.name),
			...(spec.choices ? { choices: spec.choices } : {}),
			...(spec.split ? { split: spec.split } : {}),
			...(spec.description ? { description: spec.description } : {}),
			inputs: ["inline", ...referenceInputs],
		};
	});
}

export function naturalSubcommandMetadata(cmd: CliCommand): Record<string, unknown>[] | undefined {
	const actionByName = new Map(naturalActionMetas(cmd).map((action) => [action.action, action]));
	const routes = naturalSubcommandRoutes(cmd);
	if (!routes.length) return undefined;
	return routes.map((route) => {
		if (!route.action) return {
			name: route.token,
			parameter: route.parameter,
			value: route.value,
			flags: flagMetadata(cmd).filter((flag) => flag.name !== route.parameter),
			example: `browser-pilot ${cmd.subcommand} ${route.token}`,
		};
		const action = actionByName.get(route.action);
		if (!action) throw new Error(`Missing action metadata for ${cmd.name}:${route.action}`);
		return {
			name: route.token,
			action: action.action,
			agentCli: naturalRouting(action.action),
			required: [...(action.required ?? [])],
			requiredAny: (action.requiredAny ?? []).map((group) => [...group]),
			flags: flagMetadata(cmd, action.action),
			example: `browser-pilot ${cmd.subcommand} ${route.token}`,
		};
	});
}

export { commandRouting, kebabAction, naturalRouting };
export type { AgentCliRouting };
