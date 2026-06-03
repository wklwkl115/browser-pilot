/**
 * Render a tool result to the terminal.
 *
 * --json / non-TTY → print the distilled envelope text verbatim (for agents/
 * scripts). TTY → a compact human view (summary + nextActions + artifact +
 * diagnostics). Errors go to stderr with the recovery hint. Exit codes let
 * scripts branch.
 */
import { isRecord } from "../src/utils/records.js";

export type RenderMode = "json" | "human";

export interface ToolResultLike {
	content: Array<{ type: string; text: string }>;
	details?: Record<string, unknown>;
	terminate?: boolean;
}

export const EXIT = { ok: 0, toolError: 1, usage: 2, unavailable: 3 } as const;

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
	return EXIT.toolError;
}

/**
 * A tool call failed if it hard-terminated OR the envelope itself signals an error.
 * Some tool errors (e.g. NO_TAB, browser_memory read-miss) return a normal-shaped
 * envelope with an error code / ok:false WITHOUT terminate:true — those must still
 * map to a non-zero exit code so scripts/agents can branch on `$?`.
 */
export function looksLikeToolError(text: string): boolean {
	let env: unknown;
	try { env = JSON.parse(text); } catch { return false; }
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
	const isError = result.terminate === true || looksLikeToolError(text);
	if (mode === "json") {
		const out = text.endsWith("\n") ? text : `${text}\n`;
		(isError ? process.stderr : process.stdout).write(out);
		return isError ? EXIT.toolError : EXIT.ok;
	}
	return isError ? renderHumanError(text) : renderHumanOk(text);
}

/** Render a CLI-level usage/parse error (not a tool result). */
export function renderUsageError(message: string): number {
	process.stderr.write(`${red("error:")} ${message}\n`);
	return EXIT.usage;
}
