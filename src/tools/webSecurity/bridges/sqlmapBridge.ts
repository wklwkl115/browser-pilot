import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { mergeCookieHeaders, setCookieHeader, setHeaderCaseInsensitive } from "../shared/http.js";
import { asString, isRecord, parseCommandArgs, positiveInt, stringList } from "../shared/normalize.js";
import { describeTextArtifact } from "../shared/artifacts.js";
import { detectMatureBridgeLauncher, assertMatureBridgeProcessResult, matureBridgeFailureRecord, matureBridgeToolError } from "../shared/matureBridge.js";
import { buildReplayRequest, normalizeReplayOptions, replayInputOptions, replaySequenceInputs } from "../shared/replay.js";
import type { ReplayRequest, SqlmapBridgeOptions } from "../shared/types.js";

export type NormalizedSqlmapBridgeOptions = ReturnType<typeof normalizeReplayOptions> & {
	paramNames: string[];
	technique?: string;
	dbms?: string;
	level: number;
	risk: number;
	threads: number;
	timeoutSeconds: number;
	retries: number;
	batch: boolean;
	flushSession: boolean;
	answers?: string;
	currentDb: boolean;
	currentUser: boolean;
	isDba: boolean;
	banner: boolean;
	tamper: string[];
	sqlmapPath?: string;
	sqlmapArgs: string[];
	extraArgs: string[];
	allowLauncherOverride: boolean;
	sequence: Array<{ input: unknown; source: string; label?: string }>;
	artifactRoot: string;
	processTimeoutMs: number;
};

type SqlmapLauncher = {
	command: string;
	preArgs: string[];
	source: "param" | "env" | "auto";
};

type SqlmapFinding = {
	parameter?: string;
	place?: string;
	type?: string;
	title?: string;
	payload?: string;
};

function splitCsvWords(value: unknown): string[] {
	return stringList(value)
		.flatMap((item) => item.split(/[\s,]+/))
		.map((item) => item.trim())
		.filter(Boolean);
}

function normalizeTechnique(value: unknown): string | undefined {
	const joined = splitCsvWords(value).join("").replace(/[^BEUSTQ]/gi, "").toUpperCase();
	return joined || undefined;
}

function normalizeSqlmapArgs(value: unknown): string[] {
	return parseCommandArgs(value);
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	return value === undefined ? fallback : value === true;
}

async function normalizeSqlmapBridgeOptions(options: SqlmapBridgeOptions): Promise<NormalizedSqlmapBridgeOptions> {
	const sequence = await replaySequenceInputs(options);
	const hasRequestTarget = sequence.length > 0 || options.rawRequest !== undefined || options.request !== undefined || options.har !== undefined || options.harPath !== undefined;
	const hasDirectUrlTarget = options.url !== undefined;
	if (!hasRequestTarget && !hasDirectUrlTarget) {
		throw matureBridgeToolError("MATURE_BRIDGE_TARGET_REQUIRED", "browser_sqlmap_bridge requires url, rawRequest, request, requests, sequence, or HAR input", {
			bridgeName: "sqlmap",
			toolName: "browser_sqlmap_bridge",
		});
	}
	const artifactBaseDir = path.resolve(process.cwd(), ".pi", "browser-artifacts");
	await mkdir(artifactBaseDir, { recursive: true });
	const artifactRoot = await mkdtemp(path.join(artifactBaseDir, "sqlmap-bridge-"));
	const processTimeoutMs = positiveInt(options.timeoutMs, 120_000);
	return {
		...normalizeReplayOptions(options),
		paramNames: splitCsvWords(options.paramNames),
		technique: normalizeTechnique(options.technique),
		dbms: asString(options.dbms)?.trim(),
		level: Math.min(5, Math.max(1, positiveInt(options.level, 1))),
		risk: Math.min(3, Math.max(1, positiveInt(options.risk, 1))),
		threads: Math.min(10, Math.max(1, positiveInt(options.threads, 1))),
		timeoutSeconds: Math.min(3600, Math.max(1, positiveInt(options.timeoutSeconds, Math.max(1, Math.ceil(processTimeoutMs / 1000))))),
		retries: Math.min(20, Math.max(0, positiveInt(options.retries, 3))),
		batch: normalizeBoolean(options.batch, true),
		flushSession: normalizeBoolean(options.flushSession, false),
		answers: asString(options.answers)?.trim(),
		currentDb: options.currentDb === true,
		currentUser: options.currentUser === true,
		isDba: options.isDba === true,
		banner: options.banner === true,
		tamper: splitCsvWords(options.tamper),
		sqlmapPath: asString(options.sqlmapPath)?.trim(),
		sqlmapArgs: normalizeSqlmapArgs(options.sqlmapArgs),
		extraArgs: normalizeSqlmapArgs(options.extraArgs),
		allowLauncherOverride: options.allowLauncherOverride === true,
		sequence,
		artifactRoot,
		processTimeoutMs,
	};
}

function detectLauncher(options: NormalizedSqlmapBridgeOptions): SqlmapLauncher {
	return detectMatureBridgeLauncher({
		bridgeName: "sqlmap",
		explicitPath: options.sqlmapPath,
		explicitArgs: options.sqlmapArgs,
		envPathVar: "PI_SQLMAP_PATH",
		envArgsVar: "PI_SQLMAP_ARGS",
		envArgs: normalizeSqlmapArgs(process.env.PI_SQLMAP_ARGS),
		autoCandidates: [
			{ command: "sqlmap", preArgs: [], source: "auto" },
			{ command: "python", preArgs: ["-m", "sqlmap"], source: "auto" },
			{ command: "python3", preArgs: ["-m", "sqlmap"], source: "auto" },
			{ command: "py", preArgs: ["-m", "sqlmap"], source: "auto" },
		],
		versionArgs: ["--version"],
		successPattern: /sqlmap/i,
		allowLauncherOverride: options.allowLauncherOverride,
	});
}

function normalizeHeadersForRequestFile(request: ReplayRequest): Record<string, string> {
	const parsed = new URL(request.url);
	const headers = { ...request.headers };
	setHeaderCaseInsensitive(headers, "Host", parsed.host);
	if (request.body === undefined) {
		for (const key of Object.keys(headers)) if (key.trim().toLowerCase() === "content-length") delete headers[key];
	} else {
		setHeaderCaseInsensitive(headers, "Content-Length", String(Buffer.byteLength(request.body)));
	}
	return headers;
}

function serializeRawRequest(request: ReplayRequest): Buffer {
	const parsed = new URL(request.url);
	const headers = normalizeHeadersForRequestFile(request);
	const lines = [`${request.method} ${parsed.pathname}${parsed.search} HTTP/1.1`];
	for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
	const head = Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "utf8");
	if (request.body === undefined) return head;
	const body = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body, "utf8");
	return Buffer.concat([head, body]);
}

async function bindBrowserCookies(request: ReplayRequest, options: NormalizedSqlmapBridgeOptions): Promise<ReplayRequest> {
	if (!options.bindBrowserSession) return request;
	const browserCookie = await options.cookieProvider?.(request.url);
	if (!browserCookie) return request;
	const headers = { ...request.headers };
	const currentCookie = headers.Cookie ?? headers.cookie;
	if (options.cookieMode === "replace") setCookieHeader(headers, browserCookie);
	else if (options.cookieMode !== "preserve") setCookieHeader(headers, mergeCookieHeaders(currentCookie, browserCookie));
	else if (!currentCookie) setCookieHeader(headers, browserCookie);
	return { ...request, headers };
}

async function writeRequestFile(runDir: string, request: ReplayRequest): Promise<string> {
	const requestFile = path.join(runDir, "request.txt");
	await writeFile(requestFile, serializeRawRequest(request));
	return requestFile;
}

function redactSensitiveText(text: string): string {
	return text
		.replace(/((?:^|[\r\n])\s*(?:cookie|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)\s*:\s*)[^\r\n]*/gi, "$1[redacted]")
		.replace(/((?:cookie|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)\s*:\s*)[^\r\n'";]+/gi, "$1[redacted]")
		.replace(/("(?:cookie|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)"\s*:\s*)"[^"]*"/gi, "$1\"[redacted]\"")
		.replace(/((?:cookie|authorization|proxy-authorization|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)\s*=\s*)[^;\s,"'}]+/gi, "$1[redacted]");
}

function previewText(text: string, maxChars = 1_000): string | undefined {
	const trimmed = redactSensitiveText(text).replace(/\s+/g, " ").trim();
	if (!trimmed) return undefined;
	return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}

function parseSqlmapOutput(text: string): {
	vulnerable: boolean;
	dbmsFingerprints: string[];
	webServerOs?: string;
	webTechnology?: string;
	currentUser?: string;
	currentDatabase?: string;
	isDba?: boolean;
	banner?: string;
	findings: SqlmapFinding[];
} {
	const findings: SqlmapFinding[] = [];
	const lines = text.split(/\r?\n/);
	let current: SqlmapFinding | undefined;
	for (const line of lines) {
		const parameter = line.match(/^Parameter:\s+(.+?)\s+\(([^)]+)\)\s*$/i);
		if (parameter) {
			current = { parameter: parameter[1].trim(), place: parameter[2].trim() };
			findings.push(current);
			continue;
		}
		if (!current) continue;
		const type = line.match(/^\s*Type:\s+(.+)$/i);
		if (type) {
			current.type = type[1].trim();
			continue;
		}
		const title = line.match(/^\s*Title:\s+(.+)$/i);
		if (title) {
			current.title = title[1].trim();
			continue;
		}
		const payload = line.match(/^\s*Payload:\s+(.+)$/i);
		if (payload) {
			current.payload = payload[1].trim();
			continue;
		}
		if (!line.trim()) current = undefined;
	}
	const dbmsFingerprints = Array.from(new Set(Array.from(text.matchAll(/(?:back-end DBMS|the back-end DBMS is)\s*:?\s*([^\r\n]+)/gi)).map((match) => match[1].trim()).filter(Boolean)));
	const webServerOs = text.match(/web server operating system:\s*([^\r\n]+)/i)?.[1]?.trim();
	const webTechnology = text.match(/web application technology:\s*([^\r\n]+)/i)?.[1]?.trim();
	const currentUser = text.match(/current user:\s*'?([^'\r\n]+)'?/i)?.[1]?.trim();
	const currentDatabase = text.match(/current database:\s*'?([^'\r\n]+)'?/i)?.[1]?.trim();
	const isDbaText = text.match(/current user is DBA:\s*([^\r\n]+)/i)?.[1]?.trim().toLowerCase();
	const banner = text.match(/banner:\s*([^\r\n]+)/i)?.[1]?.trim();
	return {
		vulnerable: findings.length > 0 || /appears to be injectable|identified the following injection point/i.test(text),
		dbmsFingerprints,
		webServerOs,
		webTechnology,
		currentUser,
		currentDatabase,
		isDba: isDbaText === undefined ? undefined : ["true", "yes", "1"].includes(isDbaText),
		banner,
		findings,
	};
}

async function listArtifactFiles(rootDir: string, currentDir = rootDir, out: string[] = []): Promise<string[]> {
	const entries = await readdir(currentDir, { withFileTypes: true });
	for (const entry of entries) {
		if (out.length >= 200) break;
		const child = path.join(currentDir, entry.name);
		if (entry.isDirectory()) await listArtifactFiles(rootDir, child, out);
		else out.push(path.relative(rootDir, child).replace(/\\/g, "/"));
	}
	return out;
}

function buildSqlmapArgs(launcher: SqlmapLauncher, options: NormalizedSqlmapBridgeOptions, requestFile: string, outputDir: string): string[] {
	const args = [...launcher.preArgs, "-r", requestFile, "--output-dir", outputDir, "--disable-coloring", "--timeout", String(options.timeoutSeconds), "--retries", String(options.retries), "--threads", String(options.threads), "--level", String(options.level), "--risk", String(options.risk)];
	if (options.batch) args.push("--batch");
	if (options.flushSession) args.push("--flush-session");
	if (options.answers) args.push("--answers", options.answers);
	if (options.paramNames.length) args.push("-p", options.paramNames.join(","));
	if (options.dbms) args.push("--dbms", options.dbms);
	if (options.technique) args.push("--technique", options.technique);
	if (options.tamper.length) args.push("--tamper", options.tamper.join(","));
	if (options.currentDb) args.push("--current-db");
	if (options.currentUser) args.push("--current-user");
	if (options.isDba) args.push("--is-dba");
	if (options.banner) args.push("--banner");
	args.push(...options.extraArgs);
	return args;
}

async function executeSqlmapRun(launcher: SqlmapLauncher, normalized: NormalizedSqlmapBridgeOptions, parent: SqlmapBridgeOptions, input: { input: unknown; source: string; label?: string }, index: number) {
	const runDir = path.join(normalized.artifactRoot, `run-${index + 1}`);
	const outputDir = path.join(runDir, "sqlmap-output");
	await mkdir(outputDir, { recursive: true });
	const stepOptions = input.source === "single" ? parent : replayInputOptions(input.input, parent);
	const request = await bindBrowserCookies(buildReplayRequest(stepOptions), normalized);
	const requestFile = await writeRequestFile(runDir, request);
	const args = buildSqlmapArgs(launcher, normalized, requestFile, outputDir);
	const startedAt = Date.now();
	const result = spawnSync(launcher.command, args, { encoding: "buffer", timeout: normalized.processTimeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
	const durationMs = Date.now() - startedAt;
	const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : String(result.stdout || "");
	const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : String(result.stderr || "");
	const stdoutPath = path.join(runDir, "stdout.txt");
	const stderrPath = path.join(runDir, "stderr.txt");
	await writeFile(stdoutPath, stdout, "utf8");
	await writeFile(stderrPath, stderr, "utf8");
	const requestArtifact = await describeTextArtifact(requestFile, { artifactRoot: normalized.artifactRoot, kind: "request", label: "sqlmap raw request", mediaType: "message/http" });
	const stdoutArtifact = await describeTextArtifact(stdoutPath, { artifactRoot: normalized.artifactRoot, kind: "stdout", label: "sqlmap stdout" });
	const stderrArtifact = await describeTextArtifact(stderrPath, { artifactRoot: normalized.artifactRoot, kind: "stderr", label: "sqlmap stderr" });
	const parsed = parseSqlmapOutput(stdout);
	const outputFiles = await listArtifactFiles(runDir);
	assertMatureBridgeProcessResult("sqlmap", launcher, args, result, normalized.processTimeoutMs);
	return {
		ok: !result.error && (result.status ?? 0) === 0,
		index,
		source: input.source,
		label: input.label,
		targetUrl: request.url,
		requestMethod: request.method,
		requestFile,
		requestArtifact,
		stdoutArtifact,
		stderrArtifact,
		artifacts: [requestArtifact, stdoutArtifact, stderrArtifact],
		outputDir,
		outputFiles,
		launcher: { command: launcher.command, preArgs: launcher.preArgs, source: launcher.source },
		args,
		exitCode: result.status ?? (result.error ? 1 : 0),
		signal: result.signal ?? undefined,
		durationMs,
		vulnerable: parsed.vulnerable,
		dbmsFingerprints: parsed.dbmsFingerprints,
		webServerOs: parsed.webServerOs,
		webTechnology: parsed.webTechnology,
		currentUser: parsed.currentUser,
		currentDatabase: parsed.currentDatabase,
		isDba: parsed.isDba,
		banner: parsed.banner,
		findings: parsed.findings,
		findingCount: parsed.findings.length,
		stdoutPath,
		stderrPath,
		stdoutPreview: previewText(stdout),
		stderrPreview: previewText(stderr),
	};
}

export async function runSqlmapBridge(options: SqlmapBridgeOptions) {
	const normalized = await normalizeSqlmapBridgeOptions(options);
	const launcher = detectLauncher(normalized);
	const inputs = normalized.sequence.length ? normalized.sequence : [{ input: options, source: "single", label: "target-1" }];
	const runs: Array<Record<string, unknown>> = [];
	const failures: Array<Record<string, unknown>> = [];
	for (let index = 0; index < inputs.length; index += 1) {
		try {
			runs.push(await executeSqlmapRun(launcher, normalized, options, inputs[index], index));
		} catch (error) {
			failures.push({ index, source: inputs[index].source, label: inputs[index].label, ...matureBridgeFailureRecord(error) });
		}
	}
	const findings = runs.flatMap((run) => Array.isArray(run.findings) ? run.findings.map((finding) => isRecord(finding) ? { runIndex: run.index, targetUrl: run.targetUrl, source: run.source, parameter: finding.parameter, place: finding.place, type: finding.type, title: finding.title, payload: finding.payload } : undefined).filter(Boolean) : []);
	const dbmsFingerprints = Array.from(new Set(runs.flatMap((run) => Array.isArray(run.dbmsFingerprints) ? run.dbmsFingerprints.map(String) : [])));
	const currentUsers = Array.from(new Set(runs.map((run) => asString(run.currentUser)).filter(Boolean) as string[]));
	const currentDatabases = Array.from(new Set(runs.map((run) => asString(run.currentDatabase)).filter(Boolean) as string[]));
	const vulnerableRunCount = runs.filter((run) => run.vulnerable === true).length;
	const artifacts = runs.flatMap((run) => Array.isArray(run.artifacts) ? run.artifacts.filter(isRecord) : []);
	return {
		ok: failures.length === 0 && runs.every((run) => run.ok !== false),
		generatedAt: new Date().toISOString(),
		launcher: { command: launcher.command, preArgs: launcher.preArgs, source: launcher.source },
		artifactRoot: normalized.artifactRoot,
		runCount: runs.length,
		targetCount: inputs.length,
		vulnerableRunCount,
		findingCount: findings.length,
		dbmsFingerprints,
		currentUsers,
		currentDatabases,
		artifacts,
		runs,
		findings,
		failures,
	};
}
