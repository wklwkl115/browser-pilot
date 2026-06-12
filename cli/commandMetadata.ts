import type { CliCommand } from "./registry.js";
import { buildFlagSpecs, type FlagSpec } from "./flags.js";
import { pad } from "./help.js";
import { nativeToolMetadata } from "../src/protocol/nativeActionMetadata.js";
import {
	commandRouting,
	kebabAction,
	kebabParam,
	naturalActionMetas,
	naturalRouting,
	nativeActionToolMeta,
	supportsNaturalActionRouting,
	type ActionParamMeta,
	type AgentCliRouting,
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
	descriptorFields: ["path", "kind", "bytes", "chars", "privacy", "readCommands"],
	readCommand: "pi-browser artifact --path <saved.path> --mode json --json-path data --json",
	readModes: ["json", "text", "search", "sample"],
	commonJsonPaths: ["data", "data.content", "data.actionables", "data.list_hints"],
	notes: [
		"JSON results that include saved.path are enriched with artifacts[] descriptors; cliNextActions[] only carries non-duplicate executable follow-ups.",
		"Large or sensitive raw payloads stay in local artifacts; read bounded paths with pi-browser artifact.",
	],
};

/** Per-action `--params` keys, surfaced from the generated native protocol metadata. */
export function nativeActionParamsHelp(toolName: string): string[] {
	const tools = nativeToolMetadata.nativeActionTools as unknown as Record<string, { actions?: readonly ActionParamMeta[] }>;
	const actions = tools[toolName]?.actions;
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
	const specs = buildFlagSpecs(cmd.parameters);
	if (cmd.name === "browser_execute") {
		specs.push({
			name: "scriptFile",
			flag: "--script-file",
			kind: "string",
			description: "Read JavaScript source from a local file and pass it as --script. CLI-only; cannot be combined with --script.",
			required: false,
		});
	}
	return specs.map(withCommaSplit);
}

function actionParamNames(action: ActionParamMeta): Set<string> {
	const names = new Set<string>();
	for (const key of action.required ?? []) names.add(key);
	for (const group of action.requiredAny ?? []) for (const key of group) names.add(key);
	return names;
}

export function actionSpecificFlagSpecs(cmd: CliCommand, actionName: string): FlagSpec[] {
	const specs = buildCommandFlagSpecs(cmd);
	const action = nativeActionToolMeta(cmd.name)?.actions?.find((item) => item.action === actionName);
	if (!action) return specs;
	const actionParams = actionParamNames(action);
	const common = new Set(["tabId", "targetRef", "sessionId"]);
	return specs
		.filter((spec) => spec.name !== "action")
		.filter((spec) => common.has(spec.name) || actionParams.has(spec.name))
		.map((spec) => {
			const required = (action.required ?? []).includes(spec.name);
			if (cmd.name === "browser_hook" && actionName === "installTargets" && spec.name === "targets") {
				return {
					...spec,
					kind: "array" as const,
					required,
					split: "comma" as const,
					description: `${spec.description ?? "Hook target ids."} CLI natural route accepts comma-separated values or repeated --targets.`,
				};
			}
			return required ? { ...spec, required } : spec;
		});
}

function schemaForFlagSpec(spec: FlagSpec): Record<string, unknown> {
	if (spec.kind === "boolean") return { type: "boolean", ...(spec.description ? { description: spec.description } : {}) };
	if (spec.kind === "number") return { type: "number", ...(spec.description ? { description: spec.description } : {}) };
	if (spec.kind === "array") return { type: "array", ...(spec.description ? { description: spec.description } : {}) };
	if (spec.kind === "json") return { type: "object", ...(spec.description ? { description: spec.description } : {}) };
	if (spec.kind === "enum" && spec.choices) return { anyOf: spec.choices.map((choice) => ({ const: choice })), ...(spec.description ? { description: spec.description } : {}) };
	return { type: "string", ...(spec.description ? { description: spec.description } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

function naturalActionRows(cmd: CliCommand): string[] {
	if (!supportsNaturalActionRouting(cmd)) return [];
	return naturalActionMetas(cmd).map((action) => {
		const parts: string[] = [];
		const required = [...actionParamNames(action)];
		if (required.length) parts.push(`requires --${required.map(kebabParam).join(" / --")}`);
		if (action.notes) parts.push(action.notes);
		const example = required.length === 1 ? `pi-browser ${cmd.subcommand} ${kebabAction(action.action)} --${kebabParam(required[0])} ...` : `pi-browser ${cmd.subcommand} ${kebabAction(action.action)}`;
		return `  ${pad(kebabAction(action.action), 18)}${parts.length ? `${parts.join("; ")} · ` : ""}${example}`;
	});
}

export function printCommandHelp(cmd: CliCommand, natural?: { action: string }): void {
	const specs = natural ? actionSpecificFlagSpecs(cmd, natural.action) : buildCommandFlagSpecs(cmd);
	const title = natural ? `pi-browser ${cmd.subcommand} ${kebabAction(natural.action)}` : `pi-browser ${cmd.subcommand}`;
	const lines = [`${title}${cmd.description ? ` — ${cmd.description}` : ""}`, ""];
	const naturalRows = natural ? [] : naturalActionRows(cmd);
	if (naturalRows.length) {
		lines.push("Natural subcommands (recommended):", ...naturalRows, "");
	}
	lines.push(natural ? "Flags:" : supportsNaturalActionRouting(cmd) ? "Advanced legacy flags:" : "Flags:");
	for (const s of specs) {
		const meta = s.kind === "enum" && s.choices ? ` (${s.choices.join("|")})` : s.kind === "boolean" ? "" : ` <${s.kind}>`;
		lines.push(`  ${pad(`${s.flag}${meta}`, 30)}${s.required ? "[required] " : ""}${s.description ?? ""}`.trimEnd());
	}
	const actionParams = natural ? [] : nativeActionParamsHelp(cmd.name);
	if (actionParams.length) {
		lines.push("", "Per-action --params keys (a JSON object; optional keys may also apply — see the action list above):", ...actionParams);
	}
	if (natural) lines.push("", `Advanced equivalent: pi-browser ${cmd.subcommand} --action ${natural.action} --params <json>`);
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
	return specs.map((spec) => ({
		name: spec.name,
		flag: spec.flag,
		kind: spec.kind,
		required: spec.required,
		...(spec.choices ? { choices: spec.choices } : {}),
		...(spec.split ? { split: spec.split } : {}),
		...(spec.description ? { description: spec.description } : {}),
		inputs: ["inline", ...(spec.kind === "json" || spec.kind === "array" || spec.kind === "string" ? ["@file", "stdin"] : [])],
	}));
}

export function naturalSubcommandMetadata(cmd: CliCommand): Record<string, unknown>[] | undefined {
	const rows = naturalActionMetas(cmd);
	if (!supportsNaturalActionRouting(cmd) || !rows?.length) return undefined;
	return rows.map((action) => ({
		name: kebabAction(action.action),
		action: action.action,
		agentCli: naturalRouting(action.action),
		required: [...(action.required ?? [])],
		requiredAny: (action.requiredAny ?? []).map((group) => [...group]),
		flags: flagMetadata(cmd, action.action),
		example: `pi-browser ${cmd.subcommand} ${kebabAction(action.action)}`,
	}));
}

export { commandRouting, kebabAction, naturalRouting };
export type { AgentCliRouting };
