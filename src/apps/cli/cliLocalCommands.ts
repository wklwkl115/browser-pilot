import path from "node:path";
import { parseArgs, resolveParamValueReferences, type FlagSpec } from "./flags.js";
import { renderUsageError, writeJsonEnvelope, EXIT } from "./render.js";
import { buildCommandFlagSpecs, commandGroupCounts, kebabAction } from "./commandMetadata.js";
import { naturalActionForToken } from "./naturalRouting.js";
import { daemonContractReport, findDaemon, isDaemonReadyForReuse, lockfilePath } from "../daemon/daemonControl.js";
import { daemonVersion, packageVersion } from "../daemon/packageInfo.js";
import { staleLockfileDiagnostic } from "./connection.js";
import { pad } from "./help.js";
import { applyCliOnlyParams } from "./cliFileParams.js";
import { firstPositional, jsonMode, loadCliCommands, renderLocalJson, renderMode } from "./cliBasics.js";
import { splitLeadingGlobalFlags } from "./cliBasics.js";
import { validateBrowserCommandArguments } from "../../commands/commandValidation.js";
import { buildCommandCatalogV3, buildCommandSchemaV3 } from "./publicContract.js";

export async function runCommandsCommand(argv: string[]): Promise<number> {
	const mode = jsonMode(argv);
	const catalog = buildCommandCatalogV3(await loadCliCommands());
	if (mode === "json") {
		process.stdout.write(`${JSON.stringify(catalog)}\n`);
		return EXIT.ok;
	}
	for (const cmd of catalog.commands) process.stdout.write(`${pad(cmd.cli, 22)}${cmd.summary}\n`);
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
	const schema = buildCommandSchemaV3(cmd, naturalAction);
	if (mode === "json") {
		process.stdout.write(`${JSON.stringify(schema)}\n`);
		return EXIT.ok;
	}
	process.stdout.write(JSON.stringify(schema.parameters ?? {}, null, 2) + "\n");
	return EXIT.ok;
}

function extractParamsArg(argv: string[], mode: ReturnType<typeof jsonMode>) {
	const specs: FlagSpec[] = [{ name: "params", flag: "--params", kind: "json", required: true, description: "Parameter object to validate; supports inline JSON, @file, or stdin." }];
	const parsed = parseArgs(specs, argv);
	if (!parsed.ok) return { ok: false as const, code: renderUsageError(parsed.error, renderMode(parsed.globals)) };
	const params = parsed.value.params.params;
	if (!params || typeof params !== "object" || Array.isArray(params)) return { ok: false as const, code: renderUsageError("--params must resolve to a JSON object", mode, EXIT.input) };
	return { ok: true as const, params: params as Record<string, unknown> };
}

export async function runValidateCommand(argv: string[], writeJson: typeof writeJsonEnvelope = writeJsonEnvelope): Promise<number> {
	const mode = jsonMode(argv);
	const positional = firstPositional(argv);
	const cmdName = positional.value;
	if (!cmdName || cmdName.startsWith("--")) return renderUsageError("usage: browser-pilot validate <command> --params @params.json --json", mode);
	const cmd = (await loadCliCommands()).find((item) => item.subcommand === cmdName);
	if (!cmd) return renderUsageError(`unknown command "${cmdName}"; run browser-pilot commands --json`, mode);
	const actionPosition = validateActionPosition(positional.rest);
	const naturalAction = actionPosition.actionToken ? naturalActionForToken(cmd, actionPosition.actionToken) : undefined;
	if (actionPosition.actionToken && !naturalAction) return renderUsageError(`unknown ${cmd.subcommand} subcommand "${actionPosition.actionToken}"`, mode);
	const extracted = extractParamsArg(actionPosition.rest, mode);
	if (!extracted.ok) return extracted.code;
	const resolved = resolveParamValueReferences(buildCommandFlagSpecs(cmd), extracted.params);
	if (!resolved.ok) return renderUsageError(resolved.error, mode, EXIT.input);
	if (naturalAction && Object.prototype.hasOwnProperty.call(resolved.params, "action")) return renderUsageError(`browser-pilot validate ${cmd.subcommand} ${kebabAction(naturalAction)} cannot combine the action subcommand with params.action`, mode);
	const actionArgs = naturalAction ? { ...resolved.params, action: naturalAction } : resolved.params;
	const cliParams = applyCliOnlyParams(cmd, actionArgs);
	if (!cliParams.ok) return renderUsageError(cliParams.error, mode, EXIT.input);
	const validated = validateBrowserCommandArguments(cmd.def, cliParams.params);
	if (!validated.ok) {
		if (mode === "json") writeJson({ ok: false, exitCode: EXIT.usage, code: "CLI_VALIDATION_ERROR", command: "validate", name: cmd.subcommand, commandName: cmd.name, valid: false, issues: validated.issues, message: validated.error });
		else process.stderr.write(`invalid: ${cmd.subcommand} — ${validated.error}\n`);
		return EXIT.usage;
	}
	if (mode === "json") {
		writeJson({ ok: true, exitCode: EXIT.ok, command: "validate", name: cmd.subcommand, commandName: cmd.name, ...(naturalAction ? { naturalSubcommand: kebabAction(naturalAction), action: naturalAction } : {}), valid: true, args: validated.args });
		return EXIT.ok;
	}
	process.stdout.write(`valid: ${cmd.subcommand}\n`);
	return EXIT.ok;
}

function validateActionPosition(argv: string[]): { actionToken?: string; rest: string[] } {
	const leading = splitLeadingGlobalFlags(argv);
	const token = leading.rest[0];
	if (!token || token.startsWith("--")) return { rest: argv };
	return { actionToken: token, rest: [...leading.globals, ...leading.rest.slice(1)] };
}

export async function runDoctorCommand(argv: string[]): Promise<number> {
	const mode = jsonMode(argv);
	const parsed = parseArgs([{ name: "check", flag: "--check", kind: "boolean", required: false, description: "Exit 1 when the local and daemon command contracts do not match." }], argv);
	if (!parsed.ok) return renderUsageError(parsed.error, renderMode(parsed.globals));
	if (parsed.value.globals.help) {
		process.stdout.write("browser-pilot doctor [--check] --json\n\nInspect local, daemon, bridge, extension, and command-contract state.\n");
		return EXIT.ok;
	}
	const found = await findDaemon({ tabs: true });
	const commands = await loadCliCommands();
	const groups = commandGroupCounts(commands);
	const contract = daemonContractReport(found);
	const report = {
		command: "doctor",
		version: packageVersion(),
		cwd: process.cwd(),
		commandCount: commands.length,
		commandGroups: groups,
		webSecurityCommandCount: groups.security,
		contract,
		daemon: doctorDaemon(found),
		activeTab: doctorActiveTab(found?.status.tabs, found?.status.activeTab),
		artifactRoot: path.join(process.cwd(), ".browser-pilot", "artifacts"),
		recovery: { commands: doctorRecoveryCommands() },
	};
	const failed = parsed.value.params.check === true && !contract.check.ok;
	if (mode === "json") {
		if (!failed) return renderLocalJson({ ...report, ...(parsed.value.params.check === true ? { checked: true } : {}) });
		writeJsonEnvelope({ ...report, checked: true, ok: false, exitCode: EXIT.toolError, code: contract.check.code } as unknown as Parameters<typeof writeJsonEnvelope>[0]);
		return EXIT.toolError;
	}
	process.stdout.write(`browser-pilot ${report.version}\ndaemon: ${report.daemon.running ? "running" : "not running"}\nextension: ${found?.status.extensionConnected === true ? "connected" : "not connected"}\n`);
	process.stdout.write(`contract: ${contract.check.ok ? "match" : "mismatch"}\n`);
	return failed ? EXIT.toolError : EXIT.ok;
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
		versionStale: !isDaemonReadyForReuse(found),
		bridgePort: found.status.bridgePort,
		bridgeRunning: found.status.running,
		readiness: found.status.readiness,
		extensionConnected: found.status.extensionConnected,
		extension: found.status.extension,
		health: found.status.health,
		toolCount: found.status.tools,
		contractIdentity: found.status.contractIdentity ?? null,
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
