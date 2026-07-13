import type { CliCommand } from "./registry.js";
import { wantsJson, type GlobalFlags } from "./flags.js";
import { writeJsonEnvelope, EXIT, type RenderMode } from "./render.js";

/** Public catalog commands (19 tools; catalog/contract identity). */
export async function loadCliCommands(): Promise<CliCommand[]> {
	const registry = await import("./registry.js");
	return registry.buildCliCommands();
}

/** Runnable commands including agent-preview façade (view/act/read). */
export async function loadRunnableCliCommands(): Promise<CliCommand[]> {
	const registry = await import("./registry.js");
	return registry.buildRunnableCliCommands();
}

export function renderLocalJson(obj: Record<string, unknown>): number {
	writeJsonEnvelope({ ok: true, exitCode: EXIT.ok, ...obj });
	return EXIT.ok;
}

export function renderMode(globals: GlobalFlags): RenderMode {
	if (globals.json) return "json";
	if (globals.text) return "human";
	return process.stdout.isTTY ? "human" : "json";
}

export function splitLeadingGlobalFlags(argv: string[]): { globals: string[]; rest: string[] } {
	const globals: string[] = [];
	let index = 0;
	while (argv[index] === "--json" || argv[index] === "--text") {
		globals.push(argv[index]);
		index += 1;
	}
	return { globals, rest: argv.slice(index) };
}

export function firstPositional(argv: string[]): { value?: string; rest: string[] } {
	const index = argv.findIndex((arg) => !arg.startsWith("--"));
	if (index < 0) return { rest: argv };
	return { value: argv[index], rest: [...argv.slice(0, index), ...argv.slice(index + 1)] };
}

export function jsonMode(argv: string[]): RenderMode {
	return wantsJson(argv) ? "json" : "human";
}
