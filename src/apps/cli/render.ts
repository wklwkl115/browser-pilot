/**
 * Render a command result to the terminal.
 *
 * --json / non-TTY → print the distilled envelope text verbatim (for agents/
 * scripts). TTY → a compact human view (summary + nextActions + artifact +
 * diagnostics). Errors go to stderr with recovery hints/actions. Exit codes let
 * scripts branch.
 */
import { isRecord } from "../../utils/records.js";
import type { CliJsonEnvelope } from "./envelope.js";

export type RenderMode = "json" | "human";

export interface ToolResultLike {
	content: Array<{ type: string; text: string }>;
	details?: Record<string, unknown>;
	terminate?: boolean;
}

export const EXIT = { ok: 0, toolError: 1, usage: 2, unavailable: 3, input: 4 } as const;

const tty = Boolean(process.stdout.isTTY);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s);

function resultText(result: ToolResultLike): string {
	return (result.content ?? []).map((c) => c.text).join("\n");
}

function compact(value: unknown): string {
	const s = isRecord(value) || Array.isArray(value) ? JSON.stringify(value) : String(value);
	return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

function prettySummary(summary: unknown): string {
	if (!isRecord(summary)) return compact(summary);
	return Object.entries(summary)
		.slice(0, 12)
		.map(([k, v]) => `  ${k}: ${compact(v)}`)
		.join("\n");
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function uniqueStrings(values: string[]): string[] {
	return Array.from(new Set(values));
}

function renderHumanOk(text: string): number {
	let env: unknown;
	try { env = JSON.parse(text); } catch { process.stdout.write(`${text}\n`); return EXIT.ok; }
	if (!isRecord(env)) { process.stdout.write(`${text}\n`); return EXIT.ok; }
	const lines: string[] = [];
	if (typeof env.tool === "string") lines.push(bold(env.tool) + (typeof env.command === "string" ? ` · ${env.command}` : ""));
	if (env.summary !== undefined) lines.push(prettySummary(env.summary));
	if (isRecord(env.diagnostics) && Array.isArray(env.diagnostics.warnings)) lines.push(dim(`⚠ ${env.diagnostics.warnings.join("; ")}`));
	if (isRecord(env.saved) && typeof env.saved.path === "string") lines.push(dim(`artifact: ${env.saved.path}`));
	if (Array.isArray(env.nextActions) && env.nextActions.length) lines.push(dim(`next: ${env.nextActions.slice(0, 5).join(" | ")}`));
	process.stdout.write(`${lines.join("\n")}\n`);
	return EXIT.ok;
}

function renderHumanError(text: string): number {
	let env: unknown;
	try { env = JSON.parse(text); } catch { process.stderr.write(`${red("✗")} ${text}\n`); return EXIT.toolError; }
	const root = isRecord(env) ? env : {};
	const err = isRecord(root.error) ? root.error : root;
	const code = String(err.code ?? err.error_code ?? "ERROR");
	const msg = String(err.message ?? root.message ?? text);
	process.stderr.write(`${red(`✗ ${code}`)} ${msg}\n`);
	const recovery = isRecord(err.recovery) ? err.recovery : isRecord(root.recovery) ? root.recovery : undefined;
	if (recovery && typeof recovery.hint === "string") process.stderr.write(`${dim(`  ↳ ${recovery.hint}`)}\n`);
	const errDiagnostics = isRecord(err.diagnostics) ? err.diagnostics : undefined;
	const rootDiagnostics = isRecord(root.diagnostics) ? root.diagnostics : undefined;
	const nextActions = uniqueStrings([
		...stringList(recovery?.nextActions),
		...stringList(errDiagnostics?.nextActions),
		...stringList(rootDiagnostics?.nextActions),
	]).slice(0, 5);
	if (nextActions.length) process.stderr.write(`${dim(`  ↳ next: ${nextActions.join(" | ")}`)}\n`);
	return EXIT.toolError;
}

function parseJsonObject(text: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(text) as unknown;
		return isRecord(parsed) ? parsed : { value: parsed };
	} catch {
		return { message: text };
	}
}

function errorCode(env: Record<string, unknown>, fallback: string): string {
	if (typeof env.code === "string") return env.code;
	if (typeof env.error_code === "string") return env.error_code;
	if (isRecord(env.error) && typeof env.error.code === "string") return env.error.code;
	return fallback;
}

function quoteCliArg(value: string): string {
	return `"${value.replace(/"/g, '\\"')}"`;
}

function cliActionFromText(action: string, savedPath?: string): Record<string, unknown> | undefined {
	const artifactJson = action.match(/read_saved_artifact\s+mode=json\s+jsonPath=([^\s]+)/);
	if (artifactJson && savedPath) return {
		kind: "artifact-read",
		command: `browser-pilot artifact --path ${quoteCliArg(savedPath)} --mode json --json-path ${quoteCliArg(artifactJson[1])} --json`,
		argv: ["browser-pilot", "artifact", "--path", savedPath, "--mode", "json", "--json-path", artifactJson[1], "--json"],
		source: action,
	};
	const artifactText = action.match(/read_saved_artifact\s+mode=text/);
	if (artifactText && savedPath) return {
		kind: "artifact-read",
		command: `browser-pilot artifact --path ${quoteCliArg(savedPath)} --mode text --json`,
		argv: ["browser-pilot", "artifact", "--path", savedPath, "--mode", "text", "--json"],
		source: action,
	};
	const artifactOffset = action.match(/read_saved_artifact\s+offset=(\d+)/);
	if (artifactOffset && savedPath) return {
		kind: "artifact-read",
		command: `browser-pilot artifact --path ${quoteCliArg(savedPath)} --offset ${artifactOffset[1]} --json`,
		argv: ["browser-pilot", "artifact", "--path", savedPath, "--offset", artifactOffset[1], "--json"],
		source: action,
	};
	const baseline = action.match(/baseline:"([^"]+)"|baseline=([0-9a-f-]{16,})/i);
	if (baseline) {
		const snapshotId = baseline[1] ?? baseline[2];
		return {
			kind: "observe-baseline",
			command: `browser-pilot observe --baseline-snapshot-id ${snapshotId} --json`,
			argv: ["browser-pilot", "observe", "--baseline-snapshot-id", snapshotId, "--json"],
			source: action,
		};
	}
	return undefined;
}

const COMMON_ARTIFACT_JSON_PATHS = ["data.content", "data.actionables", "data.list_hints"] as const;

function artifactReadCommand(path: string, jsonPath: string): Record<string, unknown> {
	return {
		kind: "artifact-read",
		command: `browser-pilot artifact --path ${quoteCliArg(path)} --mode json --json-path ${quoteCliArg(jsonPath)} --json`,
		argv: ["browser-pilot", "artifact", "--path", path, "--mode", "json", "--json-path", jsonPath, "--json"],
		source: `saved.path:${jsonPath}`,
	};
}

function enrichForCli(env: Record<string, unknown>): Record<string, unknown> {
	const additions: Record<string, unknown> = {};
	const saved = isRecord(env.saved) ? env.saved : undefined;
	const artifactReadCommandStrings = new Set<string>();
	if (saved && typeof saved.path === "string") {
		const savedPath = saved.path;
		const readCommands = [
			`browser-pilot artifact --path ${quoteCliArg(savedPath)} --mode json --json-path data --json`,
			...COMMON_ARTIFACT_JSON_PATHS.map((jsonPath) => String(artifactReadCommand(savedPath, jsonPath).command)),
			`browser-pilot artifact --path ${quoteCliArg(savedPath)} --mode search --query "<text>" --json`,
		];
		for (const command of readCommands) artifactReadCommandStrings.add(command);
		additions.artifacts = [{
			path: savedPath,
			kind: typeof env.tool === "string" ? env.tool : "browser-result",
			...(typeof saved.bytes === "number" ? { bytes: saved.bytes } : {}),
			...(typeof saved.chars === "number" ? { chars: saved.chars } : {}),
			...(saved.privacy ? { privacy: saved.privacy } : {}),
			readCommands,
		}];
	}
	const cliNextActions: Record<string, unknown>[] = [];
	if (Array.isArray(env.nextActions)) {
		for (const action of env.nextActions) {
			if (typeof action !== "string") continue;
			const cli = cliActionFromText(action, typeof saved?.path === "string" ? saved.path : undefined);
			if (cli?.kind === "artifact-read" && typeof cli.command === "string" && artifactReadCommandStrings.has(cli.command)) continue;
			if (cli) cliNextActions.push(cli);
		}
	}
	const snapshot = isRecord(env.snapshot) ? env.snapshot : undefined;
	if (typeof snapshot?.snapshotId === "string") {
		cliNextActions.push({
			kind: "observe-baseline",
			command: `browser-pilot observe --baseline-snapshot-id ${snapshot.snapshotId} --json`,
			argv: ["browser-pilot", "observe", "--baseline-snapshot-id", snapshot.snapshotId, "--json"],
			source: "snapshot.snapshotId",
		});
	}
	if (cliNextActions.length) additions.cliNextActions = cliNextActions;
	return { ...env, ...additions };
}

export function normalizeJsonEnvelope(text: string | Record<string, unknown>, exitCode: number, fallbackCode: string): CliJsonEnvelope {
	const env = enrichForCli(typeof text === "string" ? parseJsonObject(text) : text);
	if (exitCode === EXIT.ok && env.ok !== false) return { ...env, ok: true, exitCode };
	return { ...env, ok: false, exitCode, code: errorCode(env, fallbackCode) };
}

export function writeJsonEnvelope(envelope: CliJsonEnvelope): void {
	process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * A command call failed if it hard-terminated OR the envelope itself signals an error.
 * Some tool errors (e.g. NO_TAB, browser_memory read-miss) return a normal-shaped
 * envelope with an error code / ok:false WITHOUT terminate:true — those must still
 * map to a non-zero exit code so scripts/agents can branch on `$?`.
 */
export function looksLikeToolError(text: string | Record<string, unknown>): boolean {
	const env = typeof text === "string" ? parseJsonObject(text) : text;
	if (!isRecord(env)) return false;
	if (env.failed === true || env.ok === false) return true;
	if (typeof env.error_code === "string") return true;
	if (isRecord(env.error) && (typeof env.error.code === "string" || typeof env.error.message === "string")) return true;
	// Coded-error / BrowserBridgeError shape: top-level code + taxonomy or *Error name.
	if (typeof env.code === "string" && (isRecord(env.taxonomy) || (typeof env.name === "string" && /Error$/.test(env.name)))) return true;
	if (isRecord(env.summary) && env.summary.ok === false) return true;
	return false;
}

/** Render a result; returns the process exit code. */
export function renderResult(result: ToolResultLike, mode: RenderMode): number {
	const text = resultText(result);
	const parsed = parseJsonObject(text);
	const isError = result.terminate === true || looksLikeToolError(parsed);
	if (mode === "json") {
		const exitCode = isError ? EXIT.toolError : EXIT.ok;
		writeJsonEnvelope(normalizeJsonEnvelope(parsed, exitCode, isError ? "TOOL_ERROR" : "OK"));
		return exitCode;
	}
	return isError ? renderHumanError(text) : renderHumanOk(text);
}

/** Render a CLI-level usage/parse error (not a command result). */
export function renderUsageError(message: string, mode: RenderMode = "human", exitCode: number = EXIT.usage): number {
	if (mode === "json") {
		writeJsonEnvelope({
			ok: false,
			exitCode,
			code: exitCode === EXIT.input ? "CLI_INPUT_ERROR" : "CLI_USAGE_ERROR",
			message,
			taxonomy: { domain: "cli", category: exitCode === EXIT.input ? "input" : "usage", retryable: false, source: "cli" },
			diagnostics: {},
			recovery: { hint: "Run browser-pilot --help or browser-pilot <command> --help." },
		});
		return exitCode;
	}
	process.stderr.write(`${red("error:")} ${message}\n`);
	return exitCode;
}

export function renderUnavailableError(message: string, mode: RenderMode = "human"): number {
	if (mode === "json") {
		writeJsonEnvelope({
			ok: false,
			exitCode: EXIT.unavailable,
			code: "CLI_DAEMON_UNAVAILABLE",
			message,
			taxonomy: { domain: "cli", category: "daemon", retryable: true, source: "cli" },
			diagnostics: {},
			recovery: {
				hint: "Check daemon and browser bridge readiness.",
				commands: ["browser-pilot connect --wait --timeout-ms 15000 --json", "browser-pilot status --json", "browser-pilot doctor --json", "browser-pilot daemon status --json"],
			},
		});
		return EXIT.unavailable;
	}
	process.stderr.write(`${red("error:")} browser-pilot daemon unavailable — ${message}\n`);
	return EXIT.unavailable;
}
