import path from "node:path";
import { coerceParams, parseArgs, resolveParamValueReferences, type FlagSpec } from "./flags.js";
import { renderUsageError, EXIT } from "./render.js";
import { artifactBehaviorMetadata, actionSpecificFlagSpecs, buildCommandFlagSpecs, commandGroup, commandGroupCounts, commandRouting, flagMetadata, kebabAction, naturalRouting, naturalSubcommandMetadata, schemaForFlagSpecs } from "./commandMetadata.js";
import { naturalActionForToken } from "./naturalRouting.js";
import { findDaemon, isDaemonVersionCurrent, lockfilePath } from "../daemon/daemonControl.js";
import { daemonVersion, packageVersion } from "../daemon/packageInfo.js";
import { staleLockfileDiagnostic } from "./connection.js";
import { pad } from "./help.js";
import { applyCliOnlyParams } from "./cliFileParams.js";
import { firstPositional, jsonMode, loadCliCommands, renderLocalJson, renderMode } from "./cliBasics.js";

export async function runCommandsCommand(argv: string[]): Promise<number> {
	const mode = jsonMode(argv);
	const commands = (await loadCliCommands()).map((cmd) => ({
		name: cmd.subcommand,
		commandName: cmd.name,
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

export async function runSchemaCommand(argv: string[]): Promise<number> {
	const mode = jsonMode(argv);
	const first = firstPositional(argv);
	const cmdName = first.value;
	if (!cmdName) return renderUsageError("usage: browser-pilot schema <command> --json", mode);
	const cmd = (await loadCliCommands()).find((item) => item.subcommand === cmdName);
	if (!cmd) return renderUsageError(`unknown command "${cmdName}"; run browser-pilot commands --json`, mode);
	const second = firstPositional(first.rest);
	const naturalAction = second.value ? naturalActionForToken(cmd, second.value) : undefined;
	if (second.value && !naturalAction) return renderUsageError(`unknown ${cmd.subcommand} subcommand "${second.value}"`, mode);
	if (mode === "json") return renderLocalJson(schemaJson(cmd, naturalAction));
	process.stdout.write(JSON.stringify(cmd.parameters ?? {}, null, 2) + "\n");
	return EXIT.ok;
}

function schemaJson(cmd: Awaited<ReturnType<typeof loadCliCommands>>[number], naturalAction?: string): Record<string, unknown> {
	return {
		command: "schema",
		name: cmd.subcommand,
		commandName: cmd.name,
		...(naturalAction ? { naturalSubcommand: kebabAction(naturalAction), action: naturalAction } : {}),
		agentCli: naturalAction ? naturalRouting(naturalAction) : commandRouting(cmd),
		artifactBehavior: artifactBehaviorMetadata(),
		schema: naturalAction ? schemaForFlagSpecs(cmd, actionSpecificFlagSpecs(cmd, naturalAction)) : cmd.parameters ?? {},
		flags: flagMetadata(cmd, naturalAction),
		...(!naturalAction && naturalSubcommandMetadata(cmd) ? { subcommands: naturalSubcommandMetadata(cmd) } : {}),
	};
}

function extractParamsArg(argv: string[], mode: ReturnType<typeof jsonMode>) {
	const specs: FlagSpec[] = [{ name: "params", flag: "--params", kind: "json", required: true, description: "Parameter object to validate; supports inline JSON, @file, or stdin." }];
	const parsed = parseArgs(specs, argv);
	if (!parsed.ok) return { ok: false as const, code: renderUsageError(parsed.error, renderMode(parsed.globals)) };
	const params = parsed.value.params.params;
	if (!params || typeof params !== "object" || Array.isArray(params)) return { ok: false as const, code: renderUsageError("--params must resolve to a JSON object", mode, EXIT.input) };
	return { ok: true as const, params: params as Record<string, unknown> };
}

export async function runValidateCommand(argv: string[]): Promise<number> {
	const mode = jsonMode(argv);
	const positional = firstPositional(argv);
	const cmdName = positional.value;
	if (!cmdName || cmdName.startsWith("--")) return renderUsageError("usage: browser-pilot validate <command> --params @params.json --json", mode);
	const cmd = (await loadCliCommands()).find((item) => item.subcommand === cmdName);
	if (!cmd) return renderUsageError(`unknown command "${cmdName}"; run browser-pilot commands --json`, mode);
	const extracted = extractParamsArg(positional.rest, mode);
	if (!extracted.ok) return extracted.code;
	const resolved = resolveParamValueReferences(buildCommandFlagSpecs(cmd), extracted.params);
	if (!resolved.ok) return renderUsageError(resolved.error, mode, EXIT.input);
	const prepared = (cmd.def.prepareArguments ? cmd.def.prepareArguments(resolved.params) : resolved.params) as Record<string, unknown>;
	const cliParams = applyCliOnlyParams(cmd, prepared);
	if (!cliParams.ok) return renderUsageError(cliParams.error, mode, EXIT.input);
	const coerced = coerceParams(cmd.parameters, cliParams.params);
	if (!coerced.ok) return renderUsageError(coerced.error, mode);
	if (mode === "json") return renderLocalJson({ command: "validate", name: cmd.subcommand, commandName: cmd.name, valid: true, args: coerced.args });
	process.stdout.write(`valid: ${cmd.subcommand}\n`);
	return EXIT.ok;
}

export async function runDoctorCommand(argv: string[]): Promise<number> {
	const mode = jsonMode(argv);
	const found = await findDaemon({ tabs: true });
	const commands = await loadCliCommands();
	const groups = commandGroupCounts(commands);
	const report = {
		command: "doctor",
		version: packageVersion(),
		cwd: process.cwd(),
		commandCount: commands.length,
		commandGroups: groups,
		webSecurityCommandCount: groups.security,
		daemon: doctorDaemon(found),
		activeTab: doctorActiveTab(found?.status.tabs, found?.status.activeTab),
		artifactRoot: path.join(process.cwd(), ".browser-pilot", "artifacts"),
		recovery: { commands: doctorRecoveryCommands() },
	};
	if (mode === "json") return renderLocalJson(report);
	process.stdout.write(`browser-pilot ${report.version}\ndaemon: ${report.daemon.running ? "running" : "not running"}\nextension: ${found?.status.extensionConnected === true ? "connected" : "not connected"}\n`);
	return EXIT.ok;
}

function doctorDaemon(found: Awaited<ReturnType<typeof findDaemon>>): Record<string, unknown> {
	if (!found) return { lockfile: lockfilePath(), running: false, reachable: false, expectedVersion: daemonVersion(), bridgePort: null, bridgeRunning: false, extensionConnected: false, staleLockfile: staleLockfileDiagnostic() };
	return {
		lockfile: lockfilePath(),
		running: true,
		reachable: true,
		expectedVersion: daemonVersion(),
		pid: found.info.pid,
		controlPort: found.info.controlPort,
		version: found.info.version,
		versionStale: !isDaemonVersionCurrent(found.info),
		bridgePort: found.status.bridgePort,
		bridgeRunning: found.status.running,
		extensionConnected: found.status.extensionConnected,
		extension: found.status.extension,
		toolCount: found.status.tools,
	};
}

function doctorActiveTab(tabs: unknown, activeTab: unknown): unknown {
	const activeTabs = Array.isArray(tabs) ? tabs : [];
	return activeTab ?? activeTabs.find((tab) => typeof tab === "object" && tab && (tab as { active?: unknown }).active === true) ?? activeTabs[0] ?? null;
}

function doctorRecoveryCommands(): Array<Record<string, unknown>> {
	return [
		{ command: "browser-pilot daemon status --json", argv: ["browser-pilot", "daemon", "status", "--json"], purpose: "inspect daemon and bridge state" },
		{ command: "browser-pilot connect --wait --timeout-ms 15000 --json", argv: ["browser-pilot", "connect", "--wait", "--timeout-ms", "15000", "--json"], purpose: "start/reuse daemon and wait for browser extension readiness" },
		{ command: "browser-pilot tabs --action list --json", argv: ["browser-pilot", "tabs", "--action", "list", "--json"], purpose: "verify extension connectivity and list tabs" },
		{ command: "browser-pilot selftest --confirm --json", argv: ["browser-pilot", "selftest", "--confirm", "--json"], purpose: "run bounded live CLI smoke" },
	];
}
