import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function npmCliPath() {
	const candidate = process.env.npm_execpath || process.env.npm_execPath;
	return candidate && existsSync(candidate) ? candidate : undefined;
}

function npmCommand(args) {
	const cliPath = npmCliPath();
	if (cliPath) return { command: process.execPath, argv: [cliPath, ...args], shell: false };
	if (process.platform === "win32") return { command: "npm.cmd", argv: args, shell: true };
	return { command: "npm", argv: args, shell: false };
}

export function runNpmSync(args, options = {}) {
	const invocation = npmCommand(args);
	const result = spawnSync(invocation.command, invocation.argv, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		shell: invocation.shell,
		...options,
	});
	return {
		...result,
		ok: result.status === 0,
		command: invocation.command,
		argv: invocation.argv,
	};
}

export function throwIfNpmFailed(result, label = "npm") {
	if (result.status === 0) return result;
	const error = new Error(`${label} failed with exit ${result.status ?? result.error?.code ?? "unknown"}`);
	error.details = {
		command: result.command,
		argv: result.argv,
		status: result.status,
		signal: result.signal,
		errorCode: result.error?.code,
		errorMessage: result.error?.message,
		stdoutTail: String(result.stdout || "").slice(-4000),
		stderrTail: String(result.stderr || "").slice(-4000),
	};
	throw error;
}
