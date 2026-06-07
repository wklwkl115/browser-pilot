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
import { buildCliCommands, type CliCommand } from "./registry.js";
import { buildFlagSpecs, parseArgs, coerceParams, wantsJson, type GlobalFlags, type FlagSpec } from "./flags.js";
import { renderResult, renderUsageError, renderUnavailableError, writeJsonEnvelope, EXIT, type RenderMode } from "./render.js";
import { invokeTool, DaemonUnavailableError } from "./client.js";
import { findDaemon, lockfilePath, stopDaemon } from "./daemonControl.js";
import { nativeToolMetadata } from "../src/protocol/nativeActionMetadata.js";
import { WEB_SECURITY_TOOL_NAMES } from "../src/tools/toolRegistry.js";

/** Left-align in a column; if the head already fills the column, keep a 2-space gap so the
 *  description never glues onto a long flag/subcommand. */
function pad(head: string, width: number): string {
	return head.length < width ? head.padEnd(width) : `${head}  `;
}

function printHelp(): void {
	const cmds = buildCliCommands();
	const lines = [
		"pi-browser — drive a live browser via the bridge daemon",
		"",
		"Usage:",
		"  pi-browser <command> [--flags]",
		"  pi-browser daemon <start|stop|status>",
		"  pi-browser commands --json",
		"  pi-browser schema <command> --json",
		"  pi-browser validate <command> --params @params.json --json",
		"  pi-browser doctor --json",
		"  pi-browser selftest --confirm --json",
		"",
		"Commands:",
	];
	for (const c of cmds) lines.push(`  ${pad(c.subcommand, 22)}${c.description ?? ""}`.trimEnd());
	lines.push("", "Run 'pi-browser <command> --help' for flags. Global: --json | --text | --help");
	process.stdout.write(`${lines.join("\n")}\n`);
}

type ActionParamMeta = { action: string; required?: readonly string[]; requiredAny?: readonly (readonly string[])[]; notes?: string };

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
	return specs;
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

function printCommandHelp(cmd: CliCommand): void {
	const specs = buildCommandFlagSpecs(cmd);
	const lines = [`pi-browser ${cmd.subcommand}${cmd.description ? ` — ${cmd.description}` : ""}`, "", "Flags:"];
	for (const s of specs) {
		const meta = s.kind === "enum" && s.choices ? ` (${s.choices.join("|")})` : s.kind === "boolean" ? "" : ` <${s.kind}>`;
		lines.push(`  ${pad(`${s.flag}${meta}`, 30)}${s.required ? "[required] " : ""}${s.description ?? ""}`.trimEnd());
	}
	const actionParams = nativeActionParamsHelp(cmd.name);
	if (actionParams.length) {
		lines.push("", "Per-action --params keys (a JSON object; optional keys may also apply — see the action list above):", ...actionParams);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}

function packageVersion(): string {
	try {
		const pkg = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")) as { version?: unknown };
		return typeof pkg.version === "string" ? pkg.version : "unknown";
	} catch {
		return "unknown";
	}
}

function commandGroup(cmd: CliCommand): "core" | "security" {
	return WEB_SECURITY_TOOL_NAMES.has(cmd.name) ? "security" : "core";
}

function flagMetadata(cmd: CliCommand): Record<string, unknown>[] {
	return buildCommandFlagSpecs(cmd).map((spec) => ({
		name: spec.name,
		flag: spec.flag,
		kind: spec.kind,
		required: spec.required,
		...(spec.choices ? { choices: spec.choices } : {}),
		...(spec.description ? { description: spec.description } : {}),
		inputs: ["inline", ...(spec.kind === "json" || spec.kind === "array" || spec.kind === "string" ? ["@file", "stdin"] : [])],
	}));
}

function renderLocalJson(obj: Record<string, unknown>): number {
	writeJsonEnvelope({ ok: true, exitCode: EXIT.ok, ...obj });
	return EXIT.ok;
}

function runCommandsCommand(argv: string[]): number {
	const mode: RenderMode = wantsJson(argv) ? "json" : "human";
	const commands = buildCliCommands().map((cmd) => ({
		name: cmd.subcommand,
		toolName: cmd.name,
		group: commandGroup(cmd),
		description: cmd.description,
		flags: flagMetadata(cmd),
	}));
	if (mode === "json") return renderLocalJson({ command: "commands", commands });
	for (const cmd of commands) process.stdout.write(`${pad(String(cmd.name), 22)}${cmd.description ?? ""}\n`);
	return EXIT.ok;
}

function runSchemaCommand(argv: string[]): number {
	const mode: RenderMode = wantsJson(argv) ? "json" : "human";
	const cmdName = argv.find((arg) => !arg.startsWith("--"));
	if (!cmdName) return renderUsageError("usage: pi-browser schema <command> --json", mode);
	const cmd = buildCliCommands().find((c) => c.subcommand === cmdName);
	if (!cmd) return renderUsageError(`unknown command "${cmdName}"; run pi-browser commands --json`, mode);
	if (mode === "json") return renderLocalJson({ command: "schema", name: cmd.subcommand, toolName: cmd.name, schema: cmd.parameters ?? {}, flags: flagMetadata(cmd) });
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
	if (!parsed.ok) return { ok: false, code: renderUsageError(parsed.error, mode) };
	const params = parsed.value.params.params;
	if (!params || typeof params !== "object" || Array.isArray(params)) return { ok: false, code: renderUsageError("--params must resolve to a JSON object", mode, EXIT.input) };
	return { ok: true, params: params as Record<string, unknown> };
}

function runValidateCommand(argv: string[]): number {
	const mode: RenderMode = wantsJson(argv) ? "json" : "human";
	const [cmdName, ...rest] = argv;
	if (!cmdName || cmdName.startsWith("--")) return renderUsageError("usage: pi-browser validate <command> --params @params.json --json", mode);
	const cmd = buildCliCommands().find((c) => c.subcommand === cmdName);
	if (!cmd) return renderUsageError(`unknown command "${cmdName}"; run pi-browser commands --json`, mode);
	const extracted = extractParamsArg(rest, mode);
	if (!extracted.ok) return extracted.code;
	const prepared = (cmd.def.prepareArguments ? cmd.def.prepareArguments(extracted.params) : extracted.params) as Record<string, unknown>;
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
	const found = await findDaemon();
	const activeTabs = Array.isArray(found?.status.tabs) ? found.status.tabs : [];
	const active = activeTabs.find((tab) => typeof tab === "object" && tab && (tab as { active?: unknown }).active === true) ?? activeTabs[0];
	const report = {
		command: "doctor",
		version: packageVersion(),
		cwd: process.cwd(),
		commandCount: buildCliCommands().length,
		daemon: {
			lockfile: lockfilePath(),
			running: Boolean(found),
			...(found ? { pid: found.info.pid, controlPort: found.info.controlPort, bridgePort: found.status.bridgePort, extensionConnected: found.status.extensionConnected } : {}),
		},
		activeTab: active ?? null,
		artifactRoot: path.join(process.cwd(), ".pi", "browser-artifacts"),
		recovery: {
			commands: ["pi-browser daemon status --json", "pi-browser tabs --action list --json", "pi-browser selftest --confirm --json"],
		},
	};
	if (mode === "json") return renderLocalJson(report);
	process.stdout.write(`pi-browser ${report.version}\ndaemon: ${report.daemon.running ? "running" : "not running"}\nextension: ${found?.status.extensionConnected === true ? "connected" : "not connected"}\n`);
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
		const createText = create.content.map((c) => c.text).join("\n");
		const createEnv = JSON.parse(createText) as { data?: { tabId?: number } };
		tabId = createEnv.data?.tabId;
		steps.push({ step: "create-temp-tab", ok: typeof tabId === "number", tabId });
		if (typeof tabId !== "number") throw new Error("selftest could not create a temporary tab");
		const exec = await invokeTool("browser_execute", { tabId, script: "document.title='Pi Selftest';document.body.textContent='pi-browser selftest ok';({title:document.title,text:document.body.textContent})" }, process.cwd());
		const execText = exec.content.map((c) => c.text).join("\n");
		steps.push({ step: "execute", ok: execText.includes("pi-browser selftest ok") });
		const observe = await invokeTool("browser_observe", { tabId, mode: "text", maxNodes: 50 }, process.cwd());
		const observeText = observe.content.map((c) => c.text).join("\n");
		steps.push({ step: "observe-text", ok: observeText.includes("pi-browser selftest ok") });
		const close = await invokeTool("browser_tabs", { action: "close", tabId }, process.cwd());
		steps.push({ step: "close-temp-tab", ok: close.terminate !== true, tabId });
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

async function runDaemonControl(action: string | undefined, argv: string[] = []): Promise<number> {
	const mode: RenderMode = wantsJson(argv) ? "json" : "human";
	if (action === "stop") {
		const stopped = await stopDaemon();
		if (mode === "json") return renderLocalJson({ command: "daemon.stop", stopped });
		process.stdout.write(stopped ? "daemon stopped\n" : "no daemon running\n");
		return EXIT.ok;
	}
	if (action === "status") {
		const found = await findDaemon();
		if (!found) {
			if (mode === "json") return renderLocalJson({ command: "daemon.status", running: false, daemon: null });
			process.stdout.write("daemon: not running\n");
			return EXIT.ok;
		}
		const status = { command: "daemon.status", running: true, pid: found.info.pid, controlPort: found.info.controlPort, ...found.status };
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
	const [sub, ...rest] = argv;
	if (!sub || sub === "--help" || sub === "-h") { printHelp(); return EXIT.ok; }
	if (sub === "daemon") return runDaemonControl(rest[0], rest);
	if (sub === "commands") return runCommandsCommand(rest);
	if (sub === "schema") return runSchemaCommand(rest);
	if (sub === "validate") return runValidateCommand(rest);
	if (sub === "doctor") return await runDoctorCommand(rest);
	if (sub === "selftest") return await runSelftestCommand(rest);

	const cmd = buildCliCommands().find((c) => c.subcommand === sub);
	if (!cmd) return renderUsageError(`unknown command "${sub}"; run 'pi-browser --help'`, wantsJson(rest) ? "json" : "human");

	const specs = buildCommandFlagSpecs(cmd);
	const parsed = parseArgs(specs, rest);
	const requestedMode: RenderMode = wantsJson(rest) ? "json" : "human";
	if (!parsed.ok) return renderUsageError(parsed.error, requestedMode);
	if (parsed.value.globals.help) { printCommandHelp(cmd); return EXIT.ok; }

	const cliParams = applyCliOnlyParams(cmd, parsed.value.params);
	if (!cliParams.ok) return renderUsageError(cliParams.error, renderMode(parsed.value.globals), EXIT.input);
	const coerced = coerceParams(cmd.parameters, cliParams.params);
	if (!coerced.ok) return renderUsageError(coerced.error, renderMode(parsed.value.globals));

	// Only execution is delegated to the daemon; the caller cwd rides along so
	// artifacts/memory land under the caller's .pi/, not the daemon's.
	try {
		const result = await invokeTool(cmd.name, coerced.args, process.cwd());
		return renderResult(result, renderMode(parsed.value.globals));
	} catch (error) {
		if (error instanceof DaemonUnavailableError) {
			return renderUnavailableError(error.message, renderMode(parsed.value.globals));
		}
		throw error;
	}
}
