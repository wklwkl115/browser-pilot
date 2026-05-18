import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { mergeCookieHeaders, normalizeProbeTargets, setCookieHeader, setHeaderCaseInsensitive } from "../shared/http";
import { asString, isRecord, positiveInt, stringList } from "../shared/normalize";
import { describeTextArtifact } from "../shared/artifacts";
import { buildReplayRequest, normalizeReplayOptions, replayInputOptions, replaySequenceInputs } from "../shared/replay";
import type { NucleiBridgeOptions, ReplayRequest } from "../shared/types";

export type NormalizedNucleiBridgeOptions = ReturnType<typeof normalizeReplayOptions> & {
	templatePaths: string[];
	workflowPaths: string[];
	templateIds: string[];
	tags: string[];
	excludeTags: string[];
	severities: string[];
	authors: string[];
	timeoutSeconds: number;
	retries: number;
	rateLimitPerSecond: number;
	concurrency: number;
	bulkSize: number;
	nucleiPath?: string;
	nucleiArgs: string[];
	extraArgs: string[];
	sequence: Array<{ input: unknown; source: string; label?: string }>;
	directTargets: string[];
	artifactRoot: string;
	processTimeoutMs: number;
};

type NucleiLauncher = {
	command: string;
	preArgs: string[];
	source: "param" | "env" | "auto";
};

type NucleiMatch = {
	templateId?: string;
	templatePath?: string;
	templateName?: string;
	severity?: string;
	tags: string[];
	authors: string[];
	type?: string;
	host?: string;
	matchedAt?: string;
	ip?: string;
	matcherName?: string;
	extractorName?: string;
	extractedResults: string[];
	timestamp?: string;
	curlPreview?: string;
	requestPreview?: string;
	responsePreview?: string;
};

function splitCsvWords(value: unknown): string[] {
	return stringList(value)
		.flatMap((item) => item.split(/[\s,]+/))
		.map((item) => item.trim())
		.filter(Boolean);
}

function splitPathSelectors(value: unknown): string[] {
	return stringList(value)
		.flatMap((item) => item.split(/[\r\n,]+/))
		.map((item) => item.trim())
		.filter(Boolean);
}

function stringArray(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((item) => asString(item)?.trim() || "").filter(Boolean);
	const single = asString(value)?.trim();
	if (!single) return [];
	return single.split(/[\r\n,]+/).map((item) => item.trim()).filter(Boolean);
}

function normalizeCliArgs(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((item) => asString(item)?.trim() || "").filter(Boolean);
	const single = asString(value)?.trim();
	return single ? single.split(/\s+/).map((item) => item.trim()).filter(Boolean) : [];
}

function nonNegativeInt(value: unknown, fallback: number): number {
	const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

async function normalizeNucleiBridgeOptions(options: NucleiBridgeOptions): Promise<NormalizedNucleiBridgeOptions> {
	const sequence = await replaySequenceInputs(options);
	const hasRequestTarget = sequence.length > 0 || options.rawRequest !== undefined || options.request !== undefined;
	const hasDirectTargets = options.url !== undefined || options.urls !== undefined;
	const directTargets = hasRequestTarget || !hasDirectTargets
		? []
		: normalizeProbeTargets({ url: options.url, urls: options.urls, paths: options.paths, defaultScheme: options.defaultScheme });
	if (!hasRequestTarget && !directTargets.length) throw new Error("browser_nuclei_bridge requires url, urls, rawRequest, request, requests, sequence, or HAR input");
	const templatePaths = splitPathSelectors(options.templatePaths);
	const workflowPaths = splitPathSelectors(options.workflowPaths);
	const templateIds = splitCsvWords(options.templateIds);
	const tags = splitCsvWords(options.tags);
	const excludeTags = splitCsvWords(options.excludeTags);
	const severities = splitCsvWords(options.severities).map((item) => item.toLowerCase());
	const authors = splitCsvWords(options.authors);
	if (!templatePaths.length && !workflowPaths.length && !templateIds.length && !tags.length && !severities.length && !authors.length) {
		throw new Error("browser_nuclei_bridge requires explicit templatePaths, workflowPaths, templateIds, tags, authors, or severities");
	}
	const artifactBaseDir = path.resolve(process.cwd(), ".pi", "browser-artifacts");
	await mkdir(artifactBaseDir, { recursive: true });
	const artifactRoot = await mkdtemp(path.join(artifactBaseDir, "nuclei-bridge-"));
	const processTimeoutMs = positiveInt(options.timeoutMs, 120_000);
	return {
		...normalizeReplayOptions(options),
		templatePaths,
		workflowPaths,
		templateIds,
		tags,
		excludeTags,
		severities,
		authors,
		timeoutSeconds: Math.min(3600, Math.max(1, positiveInt(options.timeoutSeconds, Math.max(1, Math.ceil(processTimeoutMs / 1000))))),
		retries: Math.min(20, Math.max(0, nonNegativeInt(options.retries, 1))),
		rateLimitPerSecond: Math.min(1_000, Math.max(0, nonNegativeInt(options.rateLimitPerSecond, 0))),
		concurrency: Math.min(100, Math.max(1, positiveInt(options.concurrency, 10))),
		bulkSize: Math.min(100, Math.max(1, positiveInt(options.bulkSize, 10))),
		nucleiPath: asString(options.nucleiPath)?.trim(),
		nucleiArgs: normalizeCliArgs(options.nucleiArgs),
		extraArgs: normalizeCliArgs(options.extraArgs),
		sequence,
		directTargets,
		artifactRoot,
		processTimeoutMs,
	};
}

function detectLauncher(options: NormalizedNucleiBridgeOptions): NucleiLauncher {
	if (options.nucleiPath) return { command: options.nucleiPath, preArgs: options.nucleiArgs, source: "param" };
	const envPath = asString(process.env.PI_NUCLEI_PATH)?.trim();
	const envArgs = normalizeCliArgs(process.env.PI_NUCLEI_ARGS);
	const candidates: NucleiLauncher[] = [];
	if (envPath) candidates.push({ command: envPath, preArgs: envArgs, source: "env" });
	candidates.push({ command: "nuclei", preArgs: [], source: "auto" });
	for (const candidate of candidates) {
		const probe = spawnSync(candidate.command, [...candidate.preArgs, "-version"], { encoding: "utf8", timeout: 5_000, maxBuffer: 256_000, windowsHide: true });
		const combined = `${probe.stdout || ""}\n${probe.stderr || ""}`;
		if (!probe.error && (probe.status === 0 || /nuclei/i.test(combined))) return candidate;
	}
	throw new Error("browser_nuclei_bridge could not locate nuclei; set nucleiPath/nucleiArgs or PI_NUCLEI_PATH/PI_NUCLEI_ARGS, or install nuclei in PATH");
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

async function bindBrowserCookies(request: ReplayRequest, options: NormalizedNucleiBridgeOptions): Promise<ReplayRequest> {
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

function parseNucleiOutput(text: string): { matches: NucleiMatch[]; parseErrorCount: number } {
	const matches: NucleiMatch[] = [];
	let parseErrorCount = 0;
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			if (trimmed.startsWith("{") || trimmed.startsWith("[")) parseErrorCount += 1;
			continue;
		}
		if (!isRecord(parsed)) continue;
		const info = isRecord(parsed.info) ? parsed.info : {};
		const tags = stringArray(info.tags);
		const authors = stringArray(info.authors ?? info.author);
		const extractedResults = stringArray(parsed["extracted-results"] ?? parsed.extractedResults);
		matches.push({
			templateId: asString(parsed["template-id"] ?? parsed.templateId ?? parsed.templateID)?.trim(),
			templatePath: asString(parsed["template-path"] ?? parsed.templatePath)?.trim(),
			templateName: asString(info.name ?? parsed["template-name"] ?? parsed.templateName)?.trim(),
			severity: asString(info.severity ?? parsed.severity)?.trim()?.toLowerCase(),
			tags,
			authors,
			type: asString(parsed.type)?.trim(),
			host: asString(parsed.host)?.trim(),
			matchedAt: asString(parsed["matched-at"] ?? parsed.matchedAt ?? parsed.url)?.trim(),
			ip: asString(parsed.ip)?.trim(),
			matcherName: asString(parsed["matcher-name"] ?? parsed.matcherName)?.trim(),
			extractorName: asString(parsed["extractor-name"] ?? parsed.extractorName)?.trim(),
			extractedResults,
			timestamp: asString(parsed.timestamp)?.trim(),
			curlPreview: previewText(asString(parsed["curl-command"] ?? parsed.curlCommand) || ""),
			requestPreview: previewText(asString(parsed.request) || ""),
			responsePreview: previewText(asString(parsed.response) || ""),
		});
	}
	return { matches, parseErrorCount };
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

function buildNucleiArgs(launcher: NucleiLauncher, options: NormalizedNucleiBridgeOptions, requestFile: string, outputDir: string): string[] {
	const args = [...launcher.preArgs, "-jsonl", "-silent", "-duc", "-nc", "-rr", requestFile, "-sresp", "-srd", outputDir, "-timeout", String(options.timeoutSeconds), "-retries", String(options.retries), "-c", String(options.concurrency), "-bs", String(options.bulkSize)];
	if (options.rateLimitPerSecond > 0) args.push("-rl", String(options.rateLimitPerSecond));
	if (options.followRedirects) {
		args.push("-fr");
		if (options.maxRedirects > 0) args.push("-mr", String(options.maxRedirects));
	}
	for (const item of options.templatePaths) args.push("-t", item);
	for (const item of options.workflowPaths) args.push("-w", item);
	if (options.templateIds.length) args.push("-id", options.templateIds.join(","));
	if (options.tags.length) args.push("-tags", options.tags.join(","));
	if (options.excludeTags.length) args.push("-etags", options.excludeTags.join(","));
	if (options.severities.length) args.push("-severity", options.severities.join(","));
	if (options.authors.length) args.push("-author", options.authors.join(","));
	args.push(...options.extraArgs);
	return args;
}

async function executeNucleiRun(launcher: NucleiLauncher, normalized: NormalizedNucleiBridgeOptions, parent: NucleiBridgeOptions, input: { input: unknown; source: string; label?: string }, index: number) {
	const runDir = path.join(normalized.artifactRoot, `run-${index + 1}`);
	const outputDir = path.join(runDir, "nuclei-output");
	await mkdir(outputDir, { recursive: true });
	const stepOptions = input.source === "single" ? parent : replayInputOptions(input.input, parent);
	const request = await bindBrowserCookies(buildReplayRequest(stepOptions), normalized);
	const requestFile = await writeRequestFile(runDir, request);
	const args = buildNucleiArgs(launcher, normalized, requestFile, outputDir);
	const startedAt = Date.now();
	const result = spawnSync(launcher.command, args, { encoding: "buffer", timeout: normalized.processTimeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
	const durationMs = Date.now() - startedAt;
	const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : String(result.stdout || "");
	const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : String(result.stderr || "");
	const stdoutPath = path.join(runDir, "stdout.txt");
	const stderrPath = path.join(runDir, "stderr.txt");
	await writeFile(stdoutPath, stdout, "utf8");
	await writeFile(stderrPath, stderr, "utf8");
	const requestArtifact = await describeTextArtifact(requestFile, { artifactRoot: normalized.artifactRoot, kind: "request", label: "nuclei raw request", mediaType: "message/http" });
	const stdoutArtifact = await describeTextArtifact(stdoutPath, { artifactRoot: normalized.artifactRoot, kind: "stdout", label: "nuclei stdout" });
	const stderrArtifact = await describeTextArtifact(stderrPath, { artifactRoot: normalized.artifactRoot, kind: "stderr", label: "nuclei stderr" });
	const parsed = parseNucleiOutput(stdout);
	const outputFiles = await listArtifactFiles(runDir);
	if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`browser_nuclei_bridge failed to launch ${launcher.command}; executable was not found`);
	if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") throw new Error(`browser_nuclei_bridge timed out after ${normalized.processTimeoutMs}ms`);
	const matchTemplateIds = Array.from(new Set(parsed.matches.map((item) => item.templateId).filter(Boolean) as string[]));
	const matchSeverities = Array.from(new Set(parsed.matches.map((item) => item.severity).filter(Boolean) as string[]));
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
		matched: parsed.matches.length > 0,
		matchCount: parsed.matches.length,
		matchTemplateIds,
		matchSeverities,
		matches: parsed.matches,
		parseErrorCount: parsed.parseErrorCount,
		stdoutPath,
		stderrPath,
		stdoutPreview: previewText(stdout),
		stderrPreview: previewText(stderr),
	};
}

export async function runNucleiBridge(options: NucleiBridgeOptions) {
	const normalized = await normalizeNucleiBridgeOptions(options);
	const launcher = detectLauncher(normalized);
	const inputs = normalized.sequence.length
		? normalized.sequence
		: options.rawRequest !== undefined || options.request !== undefined
			? [{ input: options, source: "single", label: "target-1" }]
			: normalized.directTargets.map((url, index) => ({ input: { ...options, url }, source: "target", label: `target-${index + 1}` }));
	const runs: Array<Record<string, unknown>> = [];
	const failures: Array<Record<string, unknown>> = [];
	for (let index = 0; index < inputs.length; index += 1) {
		try {
			runs.push(await executeNucleiRun(launcher, normalized, options, inputs[index], index));
		} catch (error) {
			failures.push({ index, source: inputs[index].source, label: inputs[index].label, error: error instanceof Error ? error.message : String(error) });
		}
	}
	const matches = runs.flatMap((run) => Array.isArray(run.matches)
		? run.matches.map((match) => isRecord(match)
			? {
				runIndex: run.index,
				targetUrl: run.targetUrl,
				source: run.source,
				templateId: match.templateId,
				templatePath: match.templatePath,
				templateName: match.templateName,
				severity: match.severity,
				tags: match.tags,
				authors: match.authors,
				type: match.type,
				host: match.host,
				matchedAt: match.matchedAt,
				ip: match.ip,
				matcherName: match.matcherName,
				extractorName: match.extractorName,
				extractedResults: match.extractedResults,
				timestamp: match.timestamp,
				curlPreview: match.curlPreview,
				requestPreview: match.requestPreview,
				responsePreview: match.responsePreview,
			}
			: undefined).filter(Boolean)
		: []);
	const matchedTemplateIds = Array.from(new Set(matches.map((item) => asString(isRecord(item) ? item.templateId : undefined)).filter(Boolean) as string[]));
	const matchedSeverities = Array.from(new Set(matches.map((item) => asString(isRecord(item) ? item.severity : undefined)).filter(Boolean) as string[]));
	const matchedRunCount = runs.filter((run) => run.matched === true).length;
	const parseErrorCount = runs.reduce((sum, run) => sum + positiveInt(run.parseErrorCount, 0), 0);
	const artifacts = runs.flatMap((run) => Array.isArray(run.artifacts) ? run.artifacts.filter(isRecord) : []);
	return {
		ok: failures.length === 0 && runs.every((run) => run.ok !== false),
		generatedAt: new Date().toISOString(),
		launcher: { command: launcher.command, preArgs: launcher.preArgs, source: launcher.source },
		artifactRoot: normalized.artifactRoot,
		runCount: runs.length,
		targetCount: inputs.length,
		matchedRunCount,
		matchCount: matches.length,
		parseErrorCount,
		selectedTemplatePaths: normalized.templatePaths,
		selectedWorkflowPaths: normalized.workflowPaths,
		selectedTemplateIds: normalized.templateIds,
		selectedTags: normalized.tags,
		selectedExcludeTags: normalized.excludeTags,
		selectedSeverities: normalized.severities,
		selectedAuthors: normalized.authors,
		matchedTemplateIds,
		matchedSeverities,
		artifacts,
		runs,
		matches,
		failures,
	};
}
