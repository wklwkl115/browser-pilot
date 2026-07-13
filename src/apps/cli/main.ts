/**
 * browser-pilot CLI dispatch.
 *
 * Parsing/help is local; tool execution is delegated to the daemon.
 */
import { parseArgs, type GlobalFlags } from "./flags.js";
import { renderResult, renderUsageError, renderUnavailableError, writeJsonEnvelope, EXIT, type RenderMode } from "./render.js";
import { invokeTool, DaemonUnavailableError } from "./client.js";
import { printHelp } from "./help.js";
import { translateNaturalActionArgv, legacyActionUsed } from "./naturalRouting.js";
import { invocationFlagSpecs, kebabAction, nestNaturalActionParams, printCommandHelp } from "./commandMetadata.js";
import { loadCliCommands, loadRunnableCliCommands, renderMode, splitLeadingGlobalFlags } from "./cliBasics.js";
import { runCommandsCommand, runDoctorCommand, runSchemaCommand, runValidateCommand } from "./cliLocalCommands.js";
import { daemonAction, runConnectCommand, runDaemonControl, runStatusCommand } from "./cliConnectionCommands.js";
import { runSelftestCommand, selftestToolError } from "./cliSelftest.js";
import { runPairCommand } from "./cliPairCommand.js";
import { runLeaseCommand } from "./cliLeaseCommand.js";
import { runPairingsCommand, runRevokeCommand } from "./cliPairAdminCommands.js";
import { validateBrowserCommandArguments, type BrowserCommandValidationResult } from "../../commands/commandValidation.js";

export { selftestToolError };

export type OfflineToolInvocationResult =
	| { ok: true; commandName: string; args: Record<string, unknown>; action?: string }
	| { ok: false; error: string; issues?: Array<{ code: string; path: string; message: string }> };

/** Parse and validate a tool CLI example without starting/reusing the daemon. */
export async function validateToolInvocationOffline(sub: string, commandArgv: string[]): Promise<OfflineToolInvocationResult> {
	const cmd = (await loadRunnableCliCommands()).find((item) => item.subcommand === sub);
	if (!cmd) return { ok: false, error: `unknown command "${sub}"` };
	const translated = translateNaturalActionArgv(cmd, commandArgv);
	if (!translated.ok) return { ok: false, error: translated.error };
	const parsed = parseArgs(invocationFlagSpecs(cmd, translated.natural?.action), translated.argv);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	const params = nestNaturalActionParams(cmd, translated.natural?.action, parsed.value.params);
	const validated = validateBrowserCommandArguments(cmd.def, params);
	if (!validated.ok) return { ok: false, error: validated.error, issues: validated.issues };
	return { ok: true, commandName: cmd.name, args: validated.args, ...(translated.natural?.action ? { action: translated.natural.action } : {}) };
}

export async function main(argv: string[]): Promise<number> {
	const leading = splitLeadingGlobalFlags(argv);
	const [sub, ...rest] = leading.rest;
	const commandArgv = [...leading.globals, ...rest];
	if (!sub || sub === "--help" || sub === "-h") { printHelp(); return EXIT.ok; }
	if (sub === "daemon") return runDaemonControl(daemonAction(commandArgv), commandArgv);
	if (sub === "connect") return runConnectCommand(commandArgv);
	if (sub === "status") return runStatusCommand(commandArgv);
	if (sub === "commands") return runCommandsCommand(commandArgv);
	if (sub === "schema") return runSchemaCommand(commandArgv);
	if (sub === "validate") return runValidateCommand(commandArgv);
	if (sub === "doctor") return runDoctorCommand(commandArgv);
	if (sub === "selftest") return runSelftestCommand(commandArgv);
	if (sub === "pair") return runPairCommand(commandArgv);
	if (sub === "lease") return runLeaseCommand(commandArgv);
	if (sub === "revoke") return runRevokeCommand(commandArgv);
	if (sub === "pairings") return runPairingsCommand(commandArgv);
	// Built-in local subcommands stop above; every registered browser_* command flows through the daemon path below.
	return runToolCommand(sub, commandArgv);
}

async function runToolCommand(sub: string, commandArgv: string[]): Promise<number> {
	const cmd = (await loadRunnableCliCommands()).find((item) => item.subcommand === sub);
	if (!cmd) return renderUsageError(`unknown command "${sub}"; run 'browser-pilot --help'`, wantsJsonMode(commandArgv));
	const translated = translateNaturalActionArgv(cmd, commandArgv);
	if (!translated.ok) return renderUsageError(translated.error, renderMode(translated.globals));
	const parsed = parseInvocation(cmd, translated);
	if (typeof parsed === "number") return parsed;
	return invokeParsedCommand(cmd, commandArgv, translated, parsed);
}

function wantsJsonMode(argv: string[]): ReturnType<typeof renderMode> {
	const globals: GlobalFlags = { json: argv.includes("--json"), text: argv.includes("--text"), help: false };
	return renderMode(globals);
}

function parseInvocation(cmd: Awaited<ReturnType<typeof loadRunnableCliCommands>>[number], translated: { ok: true; argv: string[]; natural?: { action: string }; globals?: never }) {
	const specs = invocationFlagSpecs(cmd, translated.natural?.action);
	const parsed = parseArgs(specs, translated.argv);
	if (!parsed.ok) return renderUsageError(parsed.error, renderMode(parsed.globals));
	if (parsed.value.globals.help) {
		printCommandHelp(cmd, translated.natural);
		return EXIT.ok;
	}
	return parsed;
}

async function invokeParsedCommand(
	cmd: Awaited<ReturnType<typeof loadRunnableCliCommands>>[number],
	commandArgv: string[],
	translated: { ok: true; argv: string[]; natural?: { action: string } },
	parsed: ReturnType<typeof parseArgs> & { ok: true },
): Promise<number> {
	const params = nestNaturalActionParams(cmd, translated.natural?.action, parsed.value.params);
	const validated = validateBrowserCommandArguments(cmd.def, params);
	if (!validated.ok) return renderCommandValidationFailure(validated, renderMode(parsed.value.globals));
	try {
		const result = await invokeTool(cmd.name, validated.args, process.cwd(), cliInvokeMeta(cmd, commandArgv, translated.natural?.action, validated.args.action));
		return renderResult(result, renderMode(parsed.value.globals));
	} catch (error) {
		if (error instanceof DaemonUnavailableError) return renderUnavailableError(error.message, renderMode(parsed.value.globals), error.code);
		throw error;
	}
}

function renderCommandValidationFailure(result: Extract<BrowserCommandValidationResult, { ok: false }>, mode: RenderMode): number {
	if (mode === "json") {
		writeJsonEnvelope({ ok: false, exitCode: EXIT.usage, code: "CLI_VALIDATION_ERROR", message: result.error, issues: result.issues });
	} else {
		process.stderr.write(`error: ${result.error}\n`);
	}
	return EXIT.usage;
}

function cliInvokeMeta(cmd: Awaited<ReturnType<typeof loadCliCommands>>[number], commandArgv: string[], action?: string, coercedAction?: unknown): Record<string, unknown> {
	if (action) return { command: cmd.subcommand, routing: "natural", naturalSubcommand: kebabAction(action), action };
	if (legacyActionUsed(cmd, commandArgv)) return { command: cmd.subcommand, routing: "advancedCompatibility", compatibilityInterface: "--action/--params", action: typeof coercedAction === "string" ? coercedAction : undefined };
	return { command: cmd.subcommand, routing: cmd.name === "browser_command" ? "nativeEscapeHatch" : "standard", ...(cmd.name === "browser_command" ? { compatibilityInterface: "command --command" } : {}) };
}
