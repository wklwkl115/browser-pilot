import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import type { NativeErrorCode } from "../../../protocol/nativeErrorCodes.js";
import { createCodedError } from "../../../utils/codedError.js";
import { redactWebSecurityDiagnosticValue } from "./diagnostics.js";
import { isRecord } from "./normalize.js";

export type MatureBridgeLauncherSource = "param" | "env" | "auto";

export type MatureBridgeLauncher = {
	command: string;
	preArgs: string[];
	source: MatureBridgeLauncherSource;
};

export type MatureBridgeProbeAttempt = MatureBridgeLauncher & {
	versionArgs: string[];
	status: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	combined: string;
	matched: boolean;
	probeTimeoutMs: number;
	errorCode?: string;
	errorMessage?: string;
};

export type DetectMatureBridgeLauncherOptions = {
	bridgeName: string;
	explicitPath?: string;
	explicitArgs?: string[];
	envPathVar: string;
	envArgsVar: string;
	envArgs?: string[];
	autoCandidates: MatureBridgeLauncher[];
	versionArgs: string[];
	successPattern: RegExp;
	probeTimeoutMs?: number;
	allowLauncherOverride?: boolean;
};

type MatureBridgeToolErrorRecord = Error & { code: NativeErrorCode; details: Record<string, unknown> };

export function matureBridgeToolError(code: NativeErrorCode, message: string, details: Record<string, unknown> = {}): Error {
	return createCodedError({ name: "MatureBridgeError", code, message, details: { domain: "webSecurity", ...details } }) as MatureBridgeToolErrorRecord;
}

function previewText(text: string, maxChars = 400): string | undefined {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}…` : normalized;
}

function probeCandidate(candidate: MatureBridgeLauncher, options: Pick<DetectMatureBridgeLauncherOptions, "versionArgs" | "successPattern" | "probeTimeoutMs">): MatureBridgeProbeAttempt {
	const probeTimeoutMs = Math.max(500, Math.floor(options.probeTimeoutMs ?? 5_000));
	const result = spawnSync(candidate.command, [...candidate.preArgs, ...options.versionArgs], {
		encoding: "utf8",
		timeout: probeTimeoutMs,
		maxBuffer: 256_000,
		windowsHide: true,
	});
	const stdout = String(result.stdout || "");
	const stderr = String(result.stderr || "");
	const combined = `${stdout}\n${stderr}`;
	return {
		...candidate,
		versionArgs: [...options.versionArgs],
		status: result.status ?? null,
		signal: result.signal ?? null,
		stdout,
		stderr,
		combined,
		matched: !result.error && ((result.status ?? 1) === 0 || options.successPattern.test(combined)),
		probeTimeoutMs,
		errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
		errorMessage: result.error ? String(result.error.message || result.error) : undefined,
	};
}

function attemptDiagnostics(attempts: MatureBridgeProbeAttempt[]) {
	return attempts.map((attempt) => ({
		command: attempt.command,
		preArgs: attempt.preArgs,
		source: attempt.source,
		versionArgs: attempt.versionArgs,
		status: attempt.status,
		signal: attempt.signal,
		errorCode: attempt.errorCode,
		errorMessage: attempt.errorMessage,
		stdoutPreview: previewText(attempt.stdout),
		stderrPreview: previewText(attempt.stderr),
		combinedPreview: previewText(attempt.combined),
		probeTimeoutMs: attempt.probeTimeoutMs,
	}));
}

function failExplicitProbe(bridgeName: string, options: DetectMatureBridgeLauncherOptions, attempt: MatureBridgeProbeAttempt): never {
	const details = {
		bridgeName,
		source: attempt.source,
		command: attempt.command,
		preArgs: attempt.preArgs,
		versionArgs: attempt.versionArgs,
		probeTimeoutMs: attempt.probeTimeoutMs,
		envPathVar: options.envPathVar,
		envArgsVar: options.envArgsVar,
		attempts: attemptDiagnostics([attempt]),
	};
	if (attempt.errorCode === "ENOENT") {
		throw matureBridgeToolError("MATURE_BRIDGE_LAUNCHER_NOT_FOUND", `${bridgeName} launcher was not found at the explicit ${attempt.source} path`, details);
	}
	if (attempt.errorCode === "ETIMEDOUT") {
		throw matureBridgeToolError("MATURE_BRIDGE_LAUNCHER_PROBE_TIMEOUT", `${bridgeName} launcher probe timed out before version detection completed`, details);
	}
	throw matureBridgeToolError("MATURE_BRIDGE_LAUNCHER_PROBE_FAILED", `${bridgeName} launcher did not pass the version probe`, details);
}

export function detectMatureBridgeLauncher(options: DetectMatureBridgeLauncherOptions): MatureBridgeLauncher {
	const explicitPath = String(options.explicitPath || "").trim();
	if (explicitPath) {
		if (options.allowLauncherOverride !== true) {
			throw matureBridgeToolError("MATURE_BRIDGE_LAUNCHER_OVERRIDE_REQUIRED", `${options.bridgeName} explicit launcher overrides require allowLauncherOverride:true`, { bridgeName: options.bridgeName, source: "param", envPathVar: options.envPathVar, envArgsVar: options.envArgsVar });
		}
		const candidate = { command: explicitPath, preArgs: options.explicitArgs ?? [], source: "param" as const };
		const attempt = probeCandidate(candidate, options);
		if (attempt.matched) return candidate;
		return failExplicitProbe(options.bridgeName, options, attempt);
	}
	const envPath = String(process.env[options.envPathVar] || "").trim();
	if (envPath) {
		if (options.allowLauncherOverride !== true) {
			throw matureBridgeToolError("MATURE_BRIDGE_LAUNCHER_OVERRIDE_REQUIRED", `${options.bridgeName} environment launcher overrides require allowLauncherOverride:true`, { bridgeName: options.bridgeName, source: "env", envPathVar: options.envPathVar, envArgsVar: options.envArgsVar });
		}
		const candidate = { command: envPath, preArgs: options.envArgs ?? [], source: "env" as const };
		const attempt = probeCandidate(candidate, options);
		if (attempt.matched) return candidate;
	}
	const attempts = options.autoCandidates.map((candidate) => probeCandidate(candidate, options));
	const matched = attempts.find((attempt) => attempt.matched);
	if (matched) return { command: matched.command, preArgs: matched.preArgs, source: matched.source };
	const details = {
		bridgeName: options.bridgeName,
		envPathVar: options.envPathVar,
		envArgsVar: options.envArgsVar,
		versionArgs: options.versionArgs,
		attempts: attemptDiagnostics(attempts),
	};
	if (attempts.some((attempt) => attempt.errorCode === "ETIMEDOUT")) {
		throw matureBridgeToolError("MATURE_BRIDGE_LAUNCHER_PROBE_TIMEOUT", `${options.bridgeName} launcher auto-detection timed out`, details);
	}
	if (attempts.some((attempt) => attempt.errorCode && attempt.errorCode !== "ENOENT") || attempts.some((attempt) => attempt.status !== null && attempt.status !== 0)) {
		throw matureBridgeToolError("MATURE_BRIDGE_LAUNCHER_PROBE_FAILED", `${options.bridgeName} launcher auto-detection did not find a usable executable`, details);
	}
	throw matureBridgeToolError("MATURE_BRIDGE_LAUNCHER_NOT_FOUND", `${options.bridgeName} launcher was not found; configure an explicit path or install it in PATH`, details);
}

export function assertMatureBridgeProcessResult(bridgeName: string, launcher: MatureBridgeLauncher, args: string[], result: SpawnSyncReturns<Buffer | string>, processTimeoutMs: number): void {
	const error = result.error as NodeJS.ErrnoException | undefined;
	if (!error) return;
	const details = {
		domain: "webSecurity",
		bridgeName,
		source: launcher.source,
		command: launcher.command,
		preArgs: launcher.preArgs,
		args,
		processTimeoutMs,
		errorCode: error.code,
		errorMessage: String(error.message || error),
	};
	if (error.code === "ENOENT") throw matureBridgeToolError("MATURE_BRIDGE_LAUNCHER_NOT_FOUND", `${bridgeName} launcher executable was not found when starting the external process`, details);
	if (error.code === "ETIMEDOUT") throw matureBridgeToolError("MATURE_BRIDGE_PROCESS_TIMEOUT", `${bridgeName} external process timed out`, details);
	throw matureBridgeToolError("MATURE_BRIDGE_LAUNCH_FAILED", `${bridgeName} external process failed to start`, details);
}

export function matureBridgeFailureRecord(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		const extra = error as Error & { code?: unknown; details?: unknown };
		return {
			code: typeof extra.code === "string" ? extra.code : undefined,
			error: error.message,
			details: redactWebSecurityDiagnosticValue(isRecord(extra.details) ? extra.details : undefined),
		};
	}
	return { error: String(error) };
}
