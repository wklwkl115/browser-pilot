/**
 * Render a command result to the terminal.
 *
 * --json / non-TTY → print the distilled envelope text verbatim (for agents/
 * scripts). TTY → a compact human view (summary + nextActions + artifact +
 * diagnostics). Errors go to stderr with recovery hints/actions. Exit codes let
 * scripts branch.
 */
import { isRecord } from "../../utils/records.js";
import { classifyBrowserOperationEnvelope } from "../../kernels/session/browserOperation.js";
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

function operationDispatchLine(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	let acknowledged = "ack unknown";
	if (value.acknowledged === true) acknowledged = "acknowledged";
	else if (value.acknowledged === false) acknowledged = "not acknowledged";
	let lifecycle: string | undefined;
	if (typeof value.settledAt === "number") lifecycle = "settled";
	else if (value.finished === true) lifecycle = "finished";
	else if (value.started === true) lifecycle = "started";
	return `dispatch: ${acknowledged}${lifecycle ? ` · ${lifecycle}` : ""}`;
}

function operationOutcomeLine(env: Record<string, unknown>): string | undefined {
	if (typeof env.classification !== "string") return undefined;
	const verified = env.completionVerified === true ? "completion verified" : "completion unverified";
	return `outcome: ${env.classification} · ${verified}${typeof env.code === "string" ? ` · ${env.code}` : ""}`;
}

function operationBusinessLine(value: unknown): string | undefined {
	if (!isRecord(value) || typeof value.status !== "string") return undefined;
	const source = typeof value.source === "string" ? ` · ${value.source}` : "";
	const reason = typeof value.reason === "string" ? ` · ${value.reason}` : "";
	return `business: ${value.status}${source}${reason}`;
}

function operationSemanticLine(value: unknown): string | undefined {
	if (!isRecord(value) || typeof value.provider !== "string") return undefined;
	const stability = typeof value.stability === "string" ? ` · ${value.stability}` : "";
	const summary = isRecord(value.effect) && isRecord(value.effect.summary) ? value.effect.summary : undefined;
	const effect = typeof summary?.hasSemanticEffect === "boolean" ? ` · effect ${summary.hasSemanticEffect ? "observed" : "not observed"}` : "";
	return `semantic: ${value.provider}${stability}${effect}`;
}

function operationContinuationLine(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const next = typeof value.next === "string" ? value.next : "unspecified";
	const replay = typeof value.replay === "string" ? ` · replay ${value.replay}` : "";
	const reason = typeof value.reason === "string" ? ` · ${value.reason}` : "";
	return `continuation: ${next}${replay}${reason}`;
}

function operationHumanLines(env: Record<string, unknown>): string[] {
	const commandName = typeof env.commandName === "string" ? env.commandName : "browser operation";
	const status = typeof env.status === "string" ? env.status : "unknown";
	const completion = isRecord(env.completion) && typeof env.completion.source === "string" ? `completion: ${env.completion.source}` : undefined;
	return [
		`${bold(commandName)} · ${status}`,
		operationOutcomeLine(env),
		typeof env.operationId === "string" ? `operation: ${env.operationId}` : undefined,
		operationDispatchLine(env.dispatch),
		completion,
		operationBusinessLine(env.business),
		operationSemanticLine(env.semantic),
		operationContinuationLine(env.continuation),
	].filter((line): line is string => line !== undefined);
}

function renderHumanOk(text: string, exitCode: number = EXIT.ok): number {
	let env: unknown;
	try { env = JSON.parse(text); } catch { process.stdout.write(`${text}\n`); return exitCode; }
	if (!isRecord(env)) { process.stdout.write(`${text}\n`); return exitCode; }
	const lines: string[] = [];
	if (env.schema === "browser-operation/v2") lines.push(...operationHumanLines(env));
	else if (typeof env.tool === "string") {
		lines.push(bold(env.tool) + (typeof env.command === "string" ? ` · ${env.command}` : ""));
	}
	if (env.summary !== undefined) lines.push(prettySummary(env.summary));
	if (isRecord(env.diagnostics) && Array.isArray(env.diagnostics.warnings)) lines.push(dim(`⚠ ${env.diagnostics.warnings.join("; ")}`));
	if (isRecord(env.saved) && typeof env.saved.path === "string") lines.push(dim(`artifact: ${env.saved.path}`));
	if (Array.isArray(env.nextActions) && env.nextActions.length) lines.push(dim(`next: ${env.nextActions.slice(0, 5).join(" | ")}`));
	process.stdout.write(`${lines.join("\n")}\n`);
	return exitCode;
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

type CliCommandDescriptor = {
	kind: string;
	command: string;
	argv?: string[];
	argvTemplate?: string[];
	pathRef?: string;
	jsonPath?: string;
	jsonPathRef?: string;
	offset?: string;
	source: string;
};

type ArtifactReadDescriptor = {
	command: string;
	argvTemplate: string[];
	pathRef: "path";
	jsonPathRef?: string;
};

const ARTIFACT_INSPECT_COMMAND = "browser-pilot artifact inspect --path <saved.path> --json";
const ARTIFACT_PATHS_COMMAND = "browser-pilot artifact paths --path <saved.path> --json";
const ARTIFACT_JSON_COMMAND = "browser-pilot artifact json --path <saved.path> --json-path <verified-json-path> --json";
const MAX_ARTIFACT_JSON_PATHS = 6;
const MAX_ARTIFACT_JSON_PATH_CHARS = 512;
const MAX_ARTIFACT_JSON_PATH_TOTAL_CHARS = 2_048;
const MAX_CLI_NEXT_ACTIONS = 6;
const MAX_CLI_REFERENCE_CHARS = 512;

function hintedJsonPathRef(jsonPaths: string[], jsonPath: string): string | undefined {
	const index = jsonPaths.indexOf(jsonPath);
	return index >= 0 ? `artifacts[0].jsonPaths[${index}]` : undefined;
}

function cliActionFromText(action: string, savedPathAvailable: boolean, jsonPaths: string[]): CliCommandDescriptor | undefined {
	const artifactJson = action.match(/read_saved_artifact\s+mode=json\s+jsonPath=([^\s]+)/);
	if (artifactJson && savedPathAvailable) {
		const jsonPathRef = hintedJsonPathRef(jsonPaths, artifactJson[1]);
		if (!jsonPathRef) return undefined;
		return {
			kind: "artifact-read",
			command: ARTIFACT_JSON_COMMAND,
			argvTemplate: ["browser-pilot", "artifact", "json", "--path", "<saved.path>", "--json-path", "<verified-json-path>", "--json"],
			pathRef: "artifacts[0].path",
			jsonPathRef,
			source: "nextActions",
		};
	}
	const artifactText = action.match(/read_saved_artifact\s+mode=text/);
	if (artifactText && savedPathAvailable) return {
		kind: "artifact-read",
		command: "browser-pilot artifact --path <saved.path> --mode text --json",
		argvTemplate: ["browser-pilot", "artifact", "--path", "<saved.path>", "--mode", "text", "--json"],
		pathRef: "artifacts[0].path",
		source: "nextActions",
	};
	const artifactOffset = action.match(/read_saved_artifact\s+offset=(\d{1,12})(?:\s|$)/);
	if (artifactOffset && savedPathAvailable) return {
		kind: "artifact-read",
		command: "browser-pilot artifact --path <saved.path> --offset <offset> --json",
		argvTemplate: ["browser-pilot", "artifact", "--path", "<saved.path>", "--offset", "<offset>", "--json"],
		pathRef: "artifacts[0].path",
		offset: artifactOffset[1],
		source: "nextActions",
	};
	const baseline = action.match(/baseline:"([^"]+)"|baseline=([0-9a-f-]{16,})/i);
	if (baseline) {
		const snapshotId = baseline[1] ?? baseline[2];
		if (!snapshotId || snapshotId.length > MAX_CLI_REFERENCE_CHARS) return undefined;
		return {
			kind: "observe-baseline",
			command: "browser-pilot observe --baseline-snapshot-id <snapshot.snapshotId> --json",
			argv: ["browser-pilot", "observe", "--baseline-snapshot-id", snapshotId, "--json"],
			source: "nextActions",
		};
	}
	return undefined;
}

function artifactReadCommand(): ArtifactReadDescriptor {
	return {
		command: ARTIFACT_JSON_COMMAND,
		argvTemplate: ["browser-pilot", "artifact", "json", "--path", "<saved.path>", "--json-path", "<verified-json-path>", "--json"],
		pathRef: "path",
		jsonPathRef: "jsonPaths[0]",
	};
}

function artifactDiscoveryCommands(): ArtifactReadDescriptor[] {
	return [
		{ command: ARTIFACT_INSPECT_COMMAND, argvTemplate: ["browser-pilot", "artifact", "inspect", "--path", "<saved.path>", "--json"], pathRef: "path" },
		{ command: ARTIFACT_PATHS_COMMAND, argvTemplate: ["browser-pilot", "artifact", "paths", "--path", "<saved.path>", "--json"], pathRef: "path" },
	];
}

function hintedArtifactJsonPaths(env: Record<string, unknown>): string[] {
	const hints = isRecord(env.artifact_hints) ? env.artifact_hints : undefined;
	const paths = isRecord(hints?.jsonPaths) ? Object.values(hints.jsonPaths).filter((value): value is string => typeof value === "string" && value.length > 0) : [];
	const preferred = Array.isArray(hints?.preferredReads)
		? hints.preferredReads.flatMap((item) => isRecord(item) && typeof item.jsonPath === "string" && item.jsonPath ? [item.jsonPath] : [])
		: [];
	const bounded: string[] = [];
	const seen = new Set<string>();
	let chars = 0;
	for (const jsonPath of [...preferred, ...paths]) {
		if (seen.has(jsonPath) || jsonPath.length > MAX_ARTIFACT_JSON_PATH_CHARS || chars + jsonPath.length > MAX_ARTIFACT_JSON_PATH_TOTAL_CHARS) continue;
		seen.add(jsonPath);
		bounded.push(jsonPath);
		chars += jsonPath.length;
		if (bounded.length >= MAX_ARTIFACT_JSON_PATHS) break;
	}
	return bounded;
}

function artifactReadCommands(jsonPaths: string[]): ArtifactReadDescriptor[] {
	return [
		...artifactDiscoveryCommands(),
		...(jsonPaths[0] ? [artifactReadCommand()] : []),
	];
}

function artifactReadKey(value: Pick<CliCommandDescriptor, "command" | "jsonPath" | "jsonPathRef">): string {
	return JSON.stringify([value.command, value.jsonPath ?? value.jsonPathRef?.replace(/^artifacts\[0\]\./, "")]);
}

function cliArtifactContext(env: Record<string, unknown>, saved: Record<string, unknown> | undefined): {
	descriptor?: Record<string, unknown>;
	jsonPaths: string[];
	readKeys: Set<string>;
} {
	if (typeof saved?.path !== "string") return { jsonPaths: [], readKeys: new Set<string>() };
	const jsonPaths = hintedArtifactJsonPaths(env);
	const readCommands = artifactReadCommands(jsonPaths);
	return {
		jsonPaths,
		readKeys: new Set(readCommands.map((command) => artifactReadKey(command))),
		descriptor: {
			path: saved.path,
			kind: typeof env.tool === "string" ? env.tool : "browser-result",
			...(typeof saved.bytes === "number" ? { bytes: saved.bytes } : {}),
			...(typeof saved.chars === "number" ? { chars: saved.chars } : {}),
			...(saved.privacy ? { privacy: saved.privacy } : {}),
			jsonPaths,
			readCommands,
		},
	};
}

function cliNextActionsForEnvelope(env: Record<string, unknown>, savedPathAvailable: boolean, jsonPaths: string[], readKeys: Set<string>): Record<string, unknown>[] {
	const actions: Record<string, unknown>[] = [];
	if (Array.isArray(env.nextActions)) {
		for (const action of env.nextActions) {
			if (actions.length >= MAX_CLI_NEXT_ACTIONS) break;
			if (typeof action !== "string") continue;
			const cli = cliActionFromText(action, savedPathAvailable, jsonPaths);
			if (cli?.kind === "artifact-read" && readKeys.has(artifactReadKey(cli))) continue;
			if (cli) actions.push(cli);
		}
	}
	const snapshot = isRecord(env.snapshot) ? env.snapshot : undefined;
	if (actions.length < MAX_CLI_NEXT_ACTIONS && typeof snapshot?.snapshotId === "string" && snapshot.snapshotId.length <= MAX_CLI_REFERENCE_CHARS) {
		actions.push({
			kind: "observe-baseline",
			command: "browser-pilot observe --baseline-snapshot-id <snapshot.snapshotId> --json",
			argv: ["browser-pilot", "observe", "--baseline-snapshot-id", snapshot.snapshotId, "--json"],
			source: "snapshot.snapshotId",
		});
	}
	return actions;
}

function enrichForCli(env: Record<string, unknown>): Record<string, unknown> {
	const additions: Record<string, unknown> = {};
	const saved = isRecord(env.saved) ? env.saved : undefined;
	const artifact = cliArtifactContext(env, saved);
	if (artifact.descriptor) additions.artifacts = [artifact.descriptor];
	const cliNextActions = cliNextActionsForEnvelope(env, typeof saved?.path === "string", artifact.jsonPaths, artifact.readKeys);
	if (cliNextActions.length) additions.cliNextActions = cliNextActions;
	return { ...env, ...additions };
}

export function normalizeJsonEnvelope(text: string | Record<string, unknown>, exitCode: number, fallbackCode: string): CliJsonEnvelope {
	const env = enrichForCli(typeof text === "string" ? parseJsonObject(text) : text);
	const operation = classifyBrowserOperationEnvelope(env);
	if (operation.kind === "operation") {
		const operationExit = operation.outcome.ok ? EXIT.ok : EXIT.toolError;
		return operation.outcome.ok
			? { ...env, ok: true, exitCode: operationExit }
			: { ...env, ok: false, exitCode: operationExit, code: operation.outcome.code ?? "OPERATION_PROTOCOL_ERROR" };
	}
	if (operation.kind === "malformed") {
		return { ...env, ok: false, exitCode: EXIT.toolError, code: operation.code, message: operation.message };
	}
	if (exitCode === EXIT.ok && env.ok !== false) return { ...env, ok: true, exitCode };
	return { ...env, ok: false, exitCode, code: errorCode(env, fallbackCode) };
}

export function writeJsonEnvelope(envelope: CliJsonEnvelope): void {
	process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

/**
 * A command call failed if it hard-terminated OR the envelope itself signals an error.
 * Some tool errors return a normal-shaped
 * envelope with an error code / ok:false WITHOUT terminate:true — those must still
 * map to a non-zero exit code so scripts/agents can branch on `$?`.
 */
export function looksLikeToolError(text: string | Record<string, unknown>): boolean {
	const env = typeof text === "string" ? parseJsonObject(text) : text;
	if (!isRecord(env)) return false;
	const operation = classifyBrowserOperationEnvelope(env);
	if (operation.kind === "operation") return !operation.outcome.ok;
	if (operation.kind === "malformed") return true;
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
	const operation = classifyBrowserOperationEnvelope(parsed);
	if (operation.kind === "operation") {
		const exitCode = operation.outcome.ok ? EXIT.ok : EXIT.toolError;
		if (mode === "json") {
			writeJsonEnvelope(normalizeJsonEnvelope(parsed, exitCode, operation.outcome.code ?? "OK"));
			return exitCode;
		}
		return renderHumanOk(text, exitCode);
	}
	if (operation.kind === "malformed") {
		const malformed = { ...parsed, ok: false as const, code: operation.code, message: operation.message };
		if (mode === "json") {
			writeJsonEnvelope({ ...malformed, exitCode: EXIT.toolError });
			return EXIT.toolError;
		}
		return renderHumanError(JSON.stringify(malformed));
	}
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

export function renderUnavailableError(message: string, mode: RenderMode = "human", code = "CLI_DAEMON_UNAVAILABLE"): number {
	if (mode === "json") {
		writeJsonEnvelope({
			ok: false,
			exitCode: EXIT.unavailable,
			code,
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
