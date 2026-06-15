/**
 * browser-pilot CLI dispatch.
 *
 * `browser-pilot --help`            → list subcommands (one per registered tool)
 * `browser-pilot <cmd> --help`      → flags for that command
 * `browser-pilot <cmd> [--flags]`   → parse + coerce, then execute via the daemon
 * `browser-pilot daemon <start|stop|status>`  → daemon lifecycle
 *
 * Parsing/help is fully local (no browser startup); only execution is delegated
 * to the daemon. Default output is human on a TTY, JSON otherwise; --json/--text
 * override.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { CliCommand } from "./registry.js";
import { parseArgs, coerceParams, resolveParamValueReferences, wantsJson, type GlobalFlags, type FlagSpec } from "./flags.js";
import { looksLikeToolError, renderResult, renderUsageError, renderUnavailableError, writeJsonEnvelope, EXIT, type RenderMode, type ToolResultLike } from "./render.js";
import { invokeTool, DaemonUnavailableError } from "./client.js";
import { findDaemon, isDaemonVersionCurrent, lockfilePath, stopDaemon } from "./daemonControl.js";
import { daemonVersion, packageVersion } from "./packageInfo.js";
import { connectBrowser, connectionStatus, staleLockfileDiagnostic } from "./connection.js";
import { pad, printHelp } from "./help.js";
import { translateNaturalActionArgv, naturalActionForToken, legacyActionUsed } from "./naturalRouting.js";
import {
	actionSpecificFlagSpecs,
	artifactBehaviorMetadata,
	buildCommandFlagSpecs,
	commandGroup,
	commandGroupCounts,
	commandRouting,
	flagMetadata,
	invocationFlagSpecs,
	kebabAction,
	naturalRouting,
	naturalSubcommandMetadata,
	printCommandHelp,
	schemaForFlagSpecs,
} from "./commandMetadata.js";

async function loadCliCommands(): Promise<CliCommand[]> {
	const registry = await import("./registry.js");
	return registry.buildCliCommands();
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

function recoveryCommand(command: string, argv: string[], purpose: string): Record<string, unknown> {
	return { command, argv, purpose };
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
	if (!cmdName) return renderUsageError("usage: browser-pilot schema <command> --json", mode);
	const cmd = (await loadCliCommands()).find((c) => c.subcommand === cmdName);
	if (!cmd) return renderUsageError(`unknown command "${cmdName}"; run browser-pilot commands --json`, mode);
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
	if (!cmdName || cmdName.startsWith("--")) return renderUsageError("usage: browser-pilot validate <command> --params @params.json --json", mode);
	const cmd = (await loadCliCommands()).find((c) => c.subcommand === cmdName);
	if (!cmd) return renderUsageError(`unknown command "${cmdName}"; run browser-pilot commands --json`, mode);
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
				extension: found.status.extension,
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
				recoveryCommand("browser-pilot daemon status --json", ["browser-pilot", "daemon", "status", "--json"], "inspect daemon and bridge state"),
				recoveryCommand("browser-pilot connect --wait --timeout-ms 15000 --json", ["browser-pilot", "connect", "--wait", "--timeout-ms", "15000", "--json"], "start/reuse daemon and wait for browser extension readiness"),
				recoveryCommand("browser-pilot tabs --action list --json", ["browser-pilot", "tabs", "--action", "list", "--json"], "verify extension connectivity and list tabs"),
				recoveryCommand("browser-pilot selftest --confirm --json", ["browser-pilot", "selftest", "--confirm", "--json"], "run bounded live CLI smoke"),
			],
		},
	};
	if (mode === "json") return renderLocalJson(report);
	process.stdout.write(`browser-pilot ${report.version}\ndaemon: ${report.daemon.running ? "running" : "not running"}\nextension: ${found?.status.extensionConnected === true ? "connected" : "not connected"}\n`);
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
		process.stdout.write("browser-pilot connect --wait --timeout-ms <ms> --json\n\nFlags:\n  --wait                         Wait until extensionConnected is true.\n  --timeout-ms <number>          Bound readiness wait. Default 30000. For a fully\n                                 cold extension (browser just started), pass a\n                                 value above 60000 so the 1-minute wake alarm lands.\n  --tabs                         Include full tabs[]. Default is compact tabCount/activeTab.\n  --json | --text | --help\n");
		return { ok: false, code: EXIT.ok };
	}
	const rawTimeout = parsed.value.params.timeoutMs;
	const timeoutMs = rawTimeout === undefined ? 30_000 : Number(rawTimeout);
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
		process.stdout.write("browser-pilot status --json\n\nRead-only browser connection status. Does not start daemon or bridge.\n\nFlags:\n  --tabs                         Include full tabs[]. Default is compact tabCount/activeTab.\n");
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
		const exec = await invokeTool("browser_execute", { tabId, script: "document.title='Pi Selftest';document.body.textContent='browser-pilot selftest ok';({title:document.title,text:document.body.textContent})" }, process.cwd());
		const execText = requireSelftestToolOk("execute", exec);
		const execOk = execText.includes("browser-pilot selftest ok");
		steps.push({ step: "execute", ok: execOk });
		if (!execOk) throw new Error(`execute did not return expected marker: ${compactText(execText)}`);
		const observe = await invokeTool("browser_observe", { tabId, mode: "text", maxNodes: 50 }, process.cwd());
		const observeText = requireSelftestToolOk("observe-text", observe);
		const observeOk = observeText.includes("browser-pilot selftest ok");
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
		process.stderr.write(`[browser-pilot] daemon listening on 127.0.0.1:${handle.controlPort}\n`);
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
	return renderUsageError("usage: browser-pilot daemon <start|stop|status>", mode);
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
	if (!cmd) return renderUsageError(`unknown command "${sub}"; run 'browser-pilot --help'`, wantsJson(commandArgv) ? "json" : "human");

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
