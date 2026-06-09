/**
 * pi-browser CLI dispatch.
 *
 * `pi-browser --help`            → list subcommands (one per registered tool)
 * `pi-browser <cmd> --help`      → flags for that command
 * `pi-browser <cmd> [--flags]`   → parse + coerce, then execute via the daemon
 * `pi-browser daemon <start|stop|status>`  → daemon lifecycle
 *
 * Parsing/help is fully local (no browser startup); only execution is delegated
 * to the daemon. Default output is human on a TTY, JSON otherwise; --json/--text
 * override.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CliCommand } from "./registry.js";
import { buildFlagSpecs, parseArgs, coerceParams, resolveParamValueReferences, wantsJson, type GlobalFlags, type FlagSpec } from "./flags.js";
import { looksLikeToolError, renderResult, renderUsageError, renderUnavailableError, writeJsonEnvelope, EXIT, type RenderMode, type ToolResultLike } from "./render.js";
import { invokeTool, DaemonUnavailableError } from "./client.js";
import { findDaemon, isDaemonVersionCurrent, lockfilePath, stopDaemon } from "./daemonControl.js";
import { daemonVersion, packageVersion } from "./packageInfo.js";
import { connectBrowser, connectionStatus, staleLockfileDiagnostic } from "./connection.js";
import { nativeToolMetadata } from "../src/protocol/nativeActionMetadata.js";
import { pad, printHelp } from "./help.js";

const WEB_SECURITY_TOOL_NAMES = new Set([
	"browser_crawl",
	"browser_fuzz",
	"browser_sqli",
	"browser_template",
	"browser_callback_oast",
	"browser_cookie_analyze",
	"browser_http_replay",
]);

async function loadCliCommands(): Promise<CliCommand[]> {
	const registry = await import("./registry.js");
	return registry.buildCliCommands();
}

type ActionParamMeta = { action: string; aliases?: readonly string[]; required?: readonly string[]; requiredAny?: readonly (readonly string[])[]; notes?: string };
type NativeActionToolMeta = { actionDescription?: string; actions?: readonly ActionParamMeta[] };
type NaturalActionInvocation = { action: string; token: string };
type AgentCliRouting =
	| { mode: "standard"; recommended: true }
	| { mode: "natural"; recommended: true; action: string; naturalSubcommand: string; translatesTo: { action: string; params: "nativeActionParams" } }
	| { mode: "advancedCompatibility"; recommended: false; interface: "--action/--params"; reason: string[] }
	| { mode: "nativeEscapeHatch"; recommended: false; interface: "command --command"; reason: string[] };

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

/** Per-action `--params` keys, surfaced from the generated native protocol metadata (single source of
 *  truth = bridge/native_command_schema.json). Action tools (wait/network/hook/frame) take an opaque
 *  `--params <json>`; this lists the REQUIRED keys the schema knows for each action so a blind agent
 *  doesn't have to guess. Optional keys may also exist — see the action description. Empty for
 *  non-action tools. */
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

// Array flags that hold simple tokens (ids / paths / statuses / names) which NEVER contain a comma in
// a single value, so a comma-separated string is unambiguously a list. Agents naturally pass
// `--words a,b,c`; without this they silently parse as ONE element (real dogfooding friction on
// `--secret-candidates`). Repeated flags and `@file`/`-` still work. Flags whose values CAN contain a
// comma (headers, values, json-values, mutations, *payloads, raw requests) are deliberately EXCLUDED —
// an allowlist (not a denylist) so a missed flag merely keeps the old behavior instead of corrupting a
// value. Mirrors the per-hit `hook installTargets --targets` comma fix, generalized to the safe set.
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

function kebabAction(action: string): string {
	return action.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`).replace(/_/g, "-").toLowerCase();
}

function kebabParam(name: string): string {
	return name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function normalizeActionName(value: string): string {
	return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function nativeActionToolMeta(toolName: string): NativeActionToolMeta | undefined {
	const tools = nativeToolMetadata.nativeActionTools as unknown as Record<string, NativeActionToolMeta>;
	return tools[toolName];
}

const NATURAL_ACTION_ALLOWLIST: Record<string, readonly string[]> = {
	browser_wait: ["navigate", "navigateAndWait", "navigation", "loadState", "networkIdle", "selector", "any", "all", "cancel", "diagnose"],
	browser_network: ["start", "stop", "status", "clear", "list", "get", "body", "exportHar", "wait"],
	browser_frame: ["list", "evaluate"],
	browser_hook: ["listTargets", "installTargets", "listSessions", "install", "status", "collect", "clear", "pause", "resume", "uninstall", "performance"],
};

function supportsNaturalActionRouting(cmd: CliCommand): boolean {
	return Boolean(NATURAL_ACTION_ALLOWLIST[cmd.name]?.length);
}

function naturalActionMetas(cmd: CliCommand): readonly ActionParamMeta[] {
	const allowed = NATURAL_ACTION_ALLOWLIST[cmd.name];
	if (!allowed?.length) return [];
	const allowedSet = new Set(allowed);
	return (nativeActionToolMeta(cmd.name)?.actions ?? []).filter((action) => allowedSet.has(action.action));
}

function naturalActionForToken(cmd: CliCommand, token: string): string | undefined {
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

function commandRouting(cmd: CliCommand): AgentCliRouting {
	if (cmd.name === "browser_command") {
		return {
			mode: "nativeEscapeHatch",
			recommended: false,
			interface: "command --command",
			reason: ["full-native-bridge-command-access", "advanced-json-escape-hatch"],
		};
	}
	return actionToolCompatibilityRouting(cmd) ?? { mode: "standard", recommended: true };
}

function naturalRouting(action: string): AgentCliRouting {
	return {
		mode: "natural",
		recommended: true,
		action,
		naturalSubcommand: kebabAction(action),
		translatesTo: { action, params: "nativeActionParams" },
	};
}

function legacyActionUsed(cmd: CliCommand, argv: string[]): boolean {
	return Boolean(actionToolCompatibilityRouting(cmd)) && hasFlag(argv, "--action");
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

export function applyCliOnlyParams(cmd: CliCommand, raw: Record<string, unknown>, cwd = process.cwd()): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
	const params = { ...raw };
	if (cmd.name !== "browser_execute" || params.scriptFile === undefined) return { ok: true, params };
	if (typeof params.scriptFile !== "string" || !params.scriptFile) return { ok: false, error: "--script-file requires a non-empty path" };
	if (params.script !== undefined) return { ok: false, error: "--script-file cannot be combined with --script" };
	const filePath = path.resolve(cwd, params.scriptFile);
	try {
		params.script = readFileSync(filePath, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `cannot read --script-file ${filePath}: ${message}` };
	}
	delete params.scriptFile;
	return { ok: true, params };
}

function actionParamNames(action: ActionParamMeta): Set<string> {
	const names = new Set<string>();
	for (const key of action.required ?? []) names.add(key);
	for (const group of action.requiredAny ?? []) for (const key of group) names.add(key);
	return names;
}

function actionSpecificFlagSpecs(cmd: CliCommand, actionName: string): FlagSpec[] {
	const specs = buildCommandFlagSpecs(cmd);
	const action = nativeActionToolMeta(cmd.name)?.actions?.find((item) => item.action === actionName);
	if (!action) return specs;
	const actionParams = actionParamNames(action);
	const common = new Set(["tabId", "sessionId"]);
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

function schemaForFlagSpecs(cmd: CliCommand, specs: FlagSpec[]): Record<string, unknown> {
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

function printCommandHelp(cmd: CliCommand, natural?: NaturalActionInvocation): void {
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

function commandGroup(cmd: CliCommand): "core" | "security" {
	return WEB_SECURITY_TOOL_NAMES.has(cmd.name) ? "security" : "core";
}

function commandGroupCounts(commands: CliCommand[]): Record<"core" | "security", number> {
	return commands.reduce<Record<"core" | "security", number>>((counts, cmd) => {
		counts[commandGroup(cmd)] += 1;
		return counts;
	}, { core: 0, security: 0 });
}

function recoveryCommand(command: string, argv: string[], purpose: string): Record<string, unknown> {
	return { command, argv, purpose };
}

function flagMetadata(cmd: CliCommand, naturalAction?: string): Record<string, unknown>[] {
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

function artifactBehaviorMetadata(): ArtifactBehavior {
	return {
		...ARTIFACT_BEHAVIOR,
		descriptorFields: [...ARTIFACT_BEHAVIOR.descriptorFields],
		readModes: [...ARTIFACT_BEHAVIOR.readModes],
		commonJsonPaths: [...ARTIFACT_BEHAVIOR.commonJsonPaths],
		notes: [...ARTIFACT_BEHAVIOR.notes],
	};
}

function naturalSubcommandMetadata(cmd: CliCommand): Record<string, unknown>[] | undefined {
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

function renderLocalJson(obj: Record<string, unknown>): number {
	writeJsonEnvelope({ ok: true, exitCode: EXIT.ok, ...obj });
	return EXIT.ok;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function compactText(text: string): string {
	return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

function toolResultText(result: ToolResultLike): string {
	return result.content.map((c) => c.text).join("\n");
}

function parseSelftestJson(text: string, step: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(text) as unknown;
		if (isRecord(parsed)) return parsed;
	} catch {
		/* handled below */
	}
	throw new Error(`${step} returned non-JSON output: ${compactText(text)}`);
}

function envelopeMessage(env: Record<string, unknown>, fallback: string): string {
	const nested = isRecord(env.error) ? env.error : undefined;
	if (typeof nested?.message === "string") return nested.message;
	if (typeof env.message === "string") return env.message;
	if (typeof env.error === "string") return env.error;
	if (typeof env.code === "string") return `${env.code}: ${fallback}`;
	return fallback;
}

export function selftestToolError(result: ToolResultLike): string | undefined {
	const text = toolResultText(result);
	if (result.terminate !== true && !looksLikeToolError(text)) return undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		return isRecord(parsed) ? envelopeMessage(parsed, compactText(text)) : compactText(text);
	} catch {
		return compactText(text);
	}
}

function requireSelftestToolOk(step: string, result: ToolResultLike): string {
	const error = selftestToolError(result);
	if (error) throw new Error(`${step} failed: ${error}`);
	return toolResultText(result);
}

async function runCommandsCommand(argv: string[]): Promise<number> {
	const mode: RenderMode = wantsJson(argv) ? "json" : "human";
	const commands = (await loadCliCommands()).map((cmd) => ({
		name: cmd.subcommand,
		toolName: cmd.name,
		group: commandGroup(cmd),
		description: cmd.description,
		agentCli: commandRouting(cmd),
		artifactBehavior: artifactBehaviorMetadata(),
		flags: flagMetadata(cmd),
		...(naturalSubcommandMetadata(cmd) ? { subcommands: naturalSubcommandMetadata(cmd) } : {}),
	}));
	if (mode === "json") return renderLocalJson({ command: "commands", commands });
	for (const cmd of commands) process.stdout.write(`${pad(String(cmd.name), 22)}${cmd.description ?? ""}\n`);
	return EXIT.ok;
}

async function runSchemaCommand(argv: string[]): Promise<number> {
	const mode: RenderMode = wantsJson(argv) ? "json" : "human";
	const first = firstPositional(argv);
	const cmdName = first.value;
	if (!cmdName) return renderUsageError("usage: pi-browser schema <command> --json", mode);
	const cmd = (await loadCliCommands()).find((c) => c.subcommand === cmdName);
	if (!cmd) return renderUsageError(`unknown command "${cmdName}"; run pi-browser commands --json`, mode);
	const second = firstPositional(first.rest);
	const naturalAction = second.value ? naturalActionForToken(cmd, second.value) : undefined;
	if (second.value && !naturalAction) return renderUsageError(`unknown ${cmd.subcommand} subcommand "${second.value}"`, mode);
	if (mode === "json") return renderLocalJson({
		command: "schema",
		name: cmd.subcommand,
		toolName: cmd.name,
		...(naturalAction ? { naturalSubcommand: kebabAction(naturalAction), action: naturalAction } : {}),
		agentCli: naturalAction ? naturalRouting(naturalAction) : commandRouting(cmd),
		artifactBehavior: artifactBehaviorMetadata(),
		schema: naturalAction ? schemaForFlagSpecs(cmd, actionSpecificFlagSpecs(cmd, naturalAction)) : cmd.parameters ?? {},
		flags: flagMetadata(cmd, naturalAction),
		...(!naturalAction && naturalSubcommandMetadata(cmd) ? { subcommands: naturalSubcommandMetadata(cmd) } : {}),
	});
	process.stdout.write(JSON.stringify(cmd.parameters ?? {}, null, 2) + "\n");
	return EXIT.ok;
}

function extractParamsArg(argv: string[], mode: RenderMode): { ok: true; params: Record<string, unknown> } | { ok: false; code: number } {
	const specs: FlagSpec[] = [{
		name: "params",
		flag: "--params",
		kind: "json",
		required: true,
		description: "Parameter object to validate; supports inline JSON, @file, or stdin.",
	}];
	const parsed = parseArgs(specs, argv);
	if (!parsed.ok) return { ok: false, code: renderUsageError(parsed.error, renderMode(parsed.globals)) };
	const params = parsed.value.params.params;
	if (!params || typeof params !== "object" || Array.isArray(params)) return { ok: false, code: renderUsageError("--params must resolve to a JSON object", mode, EXIT.input) };
	return { ok: true, params: params as Record<string, unknown> };
}

async function runValidateCommand(argv: string[]): Promise<number> {
	const mode: RenderMode = wantsJson(argv) ? "json" : "human";
	const positional = firstPositional(argv);
	const cmdName = positional.value;
	const rest = positional.rest;
	if (!cmdName || cmdName.startsWith("--")) return renderUsageError("usage: pi-browser validate <command> --params @params.json --json", mode);
	const cmd = (await loadCliCommands()).find((c) => c.subcommand === cmdName);
	if (!cmd) return renderUsageError(`unknown command "${cmdName}"; run pi-browser commands --json`, mode);
	const extracted = extractParamsArg(rest, mode);
	if (!extracted.ok) return extracted.code;
	const resolved = resolveParamValueReferences(buildCommandFlagSpecs(cmd), extracted.params);
	if (!resolved.ok) return renderUsageError(resolved.error, mode, EXIT.input);
	const prepared = (cmd.def.prepareArguments ? cmd.def.prepareArguments(resolved.params) : resolved.params) as Record<string, unknown>;
	const cliParams = applyCliOnlyParams(cmd, prepared);
	if (!cliParams.ok) return renderUsageError(cliParams.error, mode, EXIT.input);
	const coerced = coerceParams(cmd.parameters, cliParams.params);
	if (!coerced.ok) return renderUsageError(coerced.error, mode);
	if (mode === "json") return renderLocalJson({ command: "validate", name: cmd.subcommand, toolName: cmd.name, valid: true, args: coerced.args });
	process.stdout.write(`valid: ${cmd.subcommand}\n`);
	return EXIT.ok;
}

async function runDoctorCommand(argv: string[]): Promise<number> {
	const mode: RenderMode = wantsJson(argv) ? "json" : "human";
	const found = await findDaemon({ tabs: true });
	const staleLockfile = found ? null : staleLockfileDiagnostic();
	const activeTabs = Array.isArray(found?.status.tabs) ? found.status.tabs : [];
	const active = found?.status.activeTab ?? activeTabs.find((tab) => typeof tab === "object" && tab && (tab as { active?: unknown }).active === true) ?? activeTabs[0];
	const commands = await loadCliCommands();
	const groups = commandGroupCounts(commands);
	const report = {
		command: "doctor",
		version: packageVersion(),
		cwd: process.cwd(),
		commandCount: commands.length,
		commandGroups: groups,
		webSecurityCommandCount: groups.security,
		daemon: {
			lockfile: lockfilePath(),
			running: Boolean(found),
			reachable: Boolean(found),
			expectedVersion: daemonVersion(),
			...(found ? {
				pid: found.info.pid,
				controlPort: found.info.controlPort,
				version: found.info.version,
				versionStale: !isDaemonVersionCurrent(found.info),
				bridgePort: found.status.bridgePort,
				bridgeRunning: found.status.running,
				extensionConnected: found.status.extensionConnected,
				toolCount: found.status.tools,
			} : {
				bridgePort: null,
				bridgeRunning: false,
				extensionConnected: false,
				staleLockfile,
			}),
		},
		activeTab: active ?? null,
		artifactRoot: path.join(process.cwd(), ".pi", "browser-artifacts"),
		recovery: {
			commands: [
				recoveryCommand("pi-browser daemon status --json", ["pi-browser", "daemon", "status", "--json"], "inspect daemon and bridge state"),
				recoveryCommand("pi-browser connect --wait --timeout-ms 15000 --json", ["pi-browser", "connect", "--wait", "--timeout-ms", "15000", "--json"], "start/reuse daemon and wait for browser extension readiness"),
				recoveryCommand("pi-browser tabs --action list --json", ["pi-browser", "tabs", "--action", "list", "--json"], "verify extension connectivity and list tabs"),
				recoveryCommand("pi-browser selftest --confirm --json", ["pi-browser", "selftest", "--confirm", "--json"], "run bounded live CLI smoke"),
			],
		},
	};
	if (mode === "json") return renderLocalJson(report);
	process.stdout.write(`pi-browser ${report.version}\ndaemon: ${report.daemon.running ? "running" : "not running"}\nextension: ${found?.status.extensionConnected === true ? "connected" : "not connected"}\n`);
	return EXIT.ok;
}

function parseConnectArgs(argv: string[], mode: RenderMode): { ok: true; wait: boolean; timeoutMs: number; tabs: boolean } | { ok: false; code: number } {
	const specs: FlagSpec[] = [
		{ name: "wait", flag: "--wait", kind: "boolean", required: false, description: "Wait until the browser extension is connected." },
		{ name: "timeoutMs", flag: "--timeout-ms", kind: "number", required: false, description: "Maximum readiness wait in milliseconds." },
		{ name: "tabs", flag: "--tabs", kind: "boolean", required: false, description: "Include full tabs[] instead of the default compact tabCount/activeTab fields." },
	];
	const parsed = parseArgs(specs, argv);
	if (!parsed.ok) return { ok: false, code: renderUsageError(parsed.error, renderMode(parsed.globals)) };
	if (parsed.value.globals.help) {
		process.stdout.write("pi-browser connect --wait --timeout-ms <ms> --json\n\nFlags:\n  --wait                         Wait until extensionConnected is true.\n  --timeout-ms <number>          Bound readiness wait. Default 15000.\n  --tabs                         Include full tabs[]. Default is compact tabCount/activeTab.\n  --json | --text | --help\n");
		return { ok: false, code: EXIT.ok };
	}
	const rawTimeout = parsed.value.params.timeoutMs;
	const timeoutMs = rawTimeout === undefined ? 15_000 : Number(rawTimeout);
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return { ok: false, code: renderUsageError("--timeout-ms must be a non-negative number", mode) };
	return { ok: true, wait: parsed.value.params.wait === true, timeoutMs: Math.floor(timeoutMs), tabs: parsed.value.params.tabs === true };
}

async function runConnectCommand(argv: string[]): Promise<number> {
	const mode: RenderMode = wantsJson(argv) ? "json" : "human";
	const parsed = parseConnectArgs(argv, mode);
	if (!parsed.ok) return parsed.code;
	const result = await connectBrowser({ wait: parsed.wait, timeoutMs: parsed.timeoutMs, cwd: process.cwd(), tabs: parsed.tabs });
	if (mode === "json") {
		writeJsonEnvelope(result.envelope as Parameters<typeof writeJsonEnvelope>[0]);
		return result.exitCode;
	}
	if (result.exitCode !== EXIT.ok) {
		process.stderr.write(`connect failed: ${String(result.envelope.message ?? "browser extension not connected")}\n`);
		return result.exitCode;
	}
	process.stdout.write(result.envelope.ready === true ? "ready\n" : "daemon/bridge running; extension not connected\n");
	return result.exitCode;
}

async function runStatusCommand(argv: string[]): Promise<number> {
	const mode: RenderMode = wantsJson(argv) ? "json" : "human";
	const parsed = parseArgs([{ name: "tabs", flag: "--tabs", kind: "boolean", required: false, description: "Include full tabs[] instead of the default compact tabCount/activeTab fields." }], argv);
	if (!parsed.ok) return renderUsageError(parsed.error, renderMode(parsed.globals));
	if (parsed.value.globals.help) {
		process.stdout.write("pi-browser status --json\n\nRead-only browser connection status. Does not start daemon or bridge.\n\nFlags:\n  --tabs                         Include full tabs[]. Default is compact tabCount/activeTab.\n");
		return EXIT.ok;
	}
	const env = await connectionStatus(process.cwd(), 15_000, { tabs: parsed.value.params.tabs === true });
	if (mode === "json") return renderLocalJson(env);
	process.stdout.write(`ready: ${env.ready === true ? "true" : "false"}\n`);
	return EXIT.ok;
}

async function runSelftestCommand(argv: string[]): Promise<number> {
	const mode: RenderMode = wantsJson(argv) ? "json" : "human";
	const confirmed = argv.includes("--confirm");
	if (!confirmed) return renderUsageError("selftest may create and close a temporary tab; rerun with --confirm", mode);
	const steps: Array<Record<string, unknown>> = [];
	let tabId: number | undefined;
	try {
		const create = await invokeTool("browser_tabs", { action: "create", url: "about:blank", active: true }, process.cwd());
		const createText = requireSelftestToolOk("create-temp-tab", create);
		const createEnv = parseSelftestJson(createText, "create-temp-tab") as { data?: { tabId?: number } };
		tabId = createEnv.data?.tabId;
		steps.push({ step: "create-temp-tab", ok: typeof tabId === "number", tabId });
		if (typeof tabId !== "number") throw new Error("selftest could not create a temporary tab");
		const exec = await invokeTool("browser_execute", { tabId, script: "document.title='Pi Selftest';document.body.textContent='pi-browser selftest ok';({title:document.title,text:document.body.textContent})" }, process.cwd());
		const execText = requireSelftestToolOk("execute", exec);
		const execOk = execText.includes("pi-browser selftest ok");
		steps.push({ step: "execute", ok: execOk });
		if (!execOk) throw new Error(`execute did not return expected marker: ${compactText(execText)}`);
		const observe = await invokeTool("browser_observe", { tabId, mode: "text", maxNodes: 50 }, process.cwd());
		const observeText = requireSelftestToolOk("observe-text", observe);
		const observeOk = observeText.includes("pi-browser selftest ok");
		steps.push({ step: "observe-text", ok: observeOk });
		if (!observeOk) throw new Error(`observe-text did not return expected marker: ${compactText(observeText)}`);
		const close = await invokeTool("browser_tabs", { action: "close", tabId }, process.cwd());
		requireSelftestToolOk("close-temp-tab", close);
		steps.push({ step: "close-temp-tab", ok: true, tabId });
		tabId = undefined;
		if (mode === "json") return renderLocalJson({ command: "selftest", steps, passed: steps.every((s) => s.ok === true) });
		process.stdout.write("selftest PASS\n");
		return EXIT.ok;
	} catch (error) {
		if (tabId !== undefined) {
			try {
				await invokeTool("browser_tabs", { action: "close", tabId }, process.cwd());
				steps.push({ step: "cleanup-temp-tab", ok: true, tabId });
			} catch {
				steps.push({ step: "cleanup-temp-tab", ok: false, tabId });
			}
		}
		const message = error instanceof Error ? error.message : String(error);
		if (mode === "json") {
			writeJsonEnvelope({ ok: false, exitCode: EXIT.toolError, code: "CLI_SELFTEST_FAILED", message, command: "selftest", steps });
			return EXIT.toolError;
		}
		process.stderr.write(`selftest FAIL: ${message}\n`);
		return EXIT.toolError;
	}
}

function renderMode(globals: GlobalFlags): RenderMode {
	if (globals.json) return "json";
	if (globals.text) return "human";
	return process.stdout.isTTY ? "human" : "json";
}

function splitLeadingGlobalFlags(argv: string[]): { globals: string[]; rest: string[] } {
	const globals: string[] = [];
	let i = 0;
	while (argv[i] === "--json" || argv[i] === "--text") {
		globals.push(argv[i]);
		i += 1;
	}
	return { globals, rest: argv.slice(i) };
}

function firstPositional(argv: string[]): { value?: string; rest: string[] } {
	const index = argv.findIndex((arg) => !arg.startsWith("--"));
	if (index < 0) return { rest: argv };
	return { value: argv[index], rest: [...argv.slice(0, index), ...argv.slice(index + 1)] };
}

async function runDaemonControl(action: string | undefined, argv: string[] = []): Promise<number> {
	const mode: RenderMode = wantsJson(argv) ? "json" : "human";
	if (action === "stop") {
		const stopped = await stopDaemon();
		if (mode === "json") return renderLocalJson({ command: "daemon.stop", stopped, ...(stopped ? {} : { staleLockfile: staleLockfileDiagnostic() }) });
		process.stdout.write(stopped ? "daemon stopped\n" : "no daemon running\n");
		return EXIT.ok;
	}
	if (action === "status") {
		const found = await findDaemon();
		if (!found) {
			if (mode === "json") return renderLocalJson({ command: "daemon.status", running: false, daemon: null, expectedVersion: daemonVersion(), staleLockfile: staleLockfileDiagnostic() });
			process.stdout.write("daemon: not running\n");
			return EXIT.ok;
		}
		const status = {
			command: "daemon.status",
			running: true,
			pid: found.info.pid,
			controlPort: found.info.controlPort,
			version: found.info.version,
			expectedVersion: daemonVersion(),
			versionStale: !isDaemonVersionCurrent(found.info),
			...found.status,
		};
		if (mode === "json") return renderLocalJson(status);
		process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
		return EXIT.ok;
	}
	if (action === "start") {
		// Foreground: own the process until a signal or /shutdown. Auto-start spawns this detached.
		const { startDaemon } = await import("./daemon.js");
		const handle = await startDaemon({ onShutdown: () => process.exit(EXIT.ok) });
		process.stderr.write(`[pi-browser] daemon listening on 127.0.0.1:${handle.controlPort}\n`);
		for (const sig of ["SIGINT", "SIGTERM"] as const) {
			process.on(sig, () => {
				// Force-exit even if close() hangs, so a signalled daemon always terminates.
				const force = setTimeout(() => process.exit(EXIT.ok), 1_500);
				force.unref();
				void handle.close().finally(() => process.exit(EXIT.ok));
			});
		}
		await new Promise<never>(() => {}); // keep alive
		return EXIT.ok; // unreachable
	}
	return renderUsageError("usage: pi-browser daemon <start|stop|status>", mode);
}

export async function main(argv: string[]): Promise<number> {
	const leading = splitLeadingGlobalFlags(argv);
	const [sub, ...rest] = leading.rest;
	const commandArgv = [...leading.globals, ...rest];
	if (!sub || sub === "--help" || sub === "-h") { printHelp(); return EXIT.ok; }
	if (sub === "daemon") {
		const action = firstPositional(commandArgv);
		return runDaemonControl(action.value, commandArgv);
	}
	if (sub === "connect") return await runConnectCommand(commandArgv);
	if (sub === "status") return await runStatusCommand(commandArgv);
	if (sub === "commands") return await runCommandsCommand(commandArgv);
	if (sub === "schema") return await runSchemaCommand(commandArgv);
	if (sub === "validate") return await runValidateCommand(commandArgv);
	if (sub === "doctor") return await runDoctorCommand(commandArgv);
	if (sub === "selftest") return await runSelftestCommand(commandArgv);

	const cmd = (await loadCliCommands()).find((c) => c.subcommand === sub);
	if (!cmd) return renderUsageError(`unknown command "${sub}"; run 'pi-browser --help'`, wantsJson(commandArgv) ? "json" : "human");

	const translated = translateNaturalActionArgv(cmd, commandArgv);
	if (!translated.ok) return renderUsageError(translated.error, renderMode(translated.globals));
	const specs = invocationFlagSpecs(cmd, translated.natural?.action);
	const parsed = parseArgs(specs, translated.argv);
	if (!parsed.ok) return renderUsageError(parsed.error, renderMode(parsed.globals));
	if (parsed.value.globals.help) { printCommandHelp(cmd, translated.natural); return EXIT.ok; }

	const cliParams = applyCliOnlyParams(cmd, parsed.value.params);
	if (!cliParams.ok) return renderUsageError(cliParams.error, renderMode(parsed.value.globals), EXIT.input);
	const coerced = coerceParams(cmd.parameters, cliParams.params);
	if (!coerced.ok) return renderUsageError(coerced.error, renderMode(parsed.value.globals));
	const cliInvoke = translated.natural
		? {
			command: cmd.subcommand,
			routing: "natural",
			naturalSubcommand: kebabAction(translated.natural.action),
			action: translated.natural.action,
		}
		: legacyActionUsed(cmd, commandArgv)
			? {
				command: cmd.subcommand,
				routing: "advancedCompatibility",
				compatibilityInterface: "--action/--params",
				action: typeof coerced.args.action === "string" ? coerced.args.action : undefined,
			}
			: {
				command: cmd.subcommand,
				routing: cmd.name === "browser_command" ? "nativeEscapeHatch" : "standard",
				...(cmd.name === "browser_command" ? { compatibilityInterface: "command --command" } : {}),
			};

	// Only execution is delegated to the daemon; the caller cwd rides along so
	// artifacts/memory land under the caller's .pi/, not the daemon's.
	try {
		const result = await invokeTool(cmd.name, coerced.args, process.cwd(), cliInvoke);
		return renderResult(result, renderMode(parsed.value.globals));
	} catch (error) {
		if (error instanceof DaemonUnavailableError) {
			return renderUnavailableError(error.message, renderMode(parsed.value.globals));
		}
		throw error;
	}
}
