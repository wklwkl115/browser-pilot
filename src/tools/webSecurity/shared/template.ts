import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import { tryJson } from "../../../utils/json";
import { SAFE_REGEX_DEFAULT_MAX_PATTERN_CHARS, unsafeRegexReason } from "../../../utils/safeRegex";
import { absoluteUrl, extractTitle, normalizeHeaders, parseSetCookieLine, redirectLocation, responseBodyHash } from "./http";
import { asString, isRecord, numericList, positiveInt, stringList } from "./normalize";
import type { FetchStep, HeaderMap, TemplateCheckOptions } from "./types";

export type TemplateDslMatcher = {
	type: string;
	part?: string;
	name?: string;
	status?: number[];
	words?: string[];
	regex?: string[];
	value?: string;
	negative?: boolean;
};

export type TemplateDslExtractor = {
	type: string;
	name?: string;
	part?: string;
	header?: string;
	cookie?: string;
	regex?: string[];
	group?: number;
	jsonPath?: string;
};

export type TemplateMatcher = {
	matchStatus?: number[];
	filterStatus?: number[];
	bodyIncludes?: string[];
	bodyRegex?: string[];
	headerIncludes?: Record<string, string>;
	headerRegex?: Record<string, string>;
	extractRegex?: string[];
	matchers?: TemplateDslMatcher[];
	extractors?: TemplateDslExtractor[];
	matcherMode?: "all" | "any";
};

export type TemplateDefinition = TemplateMatcher & {
	id: string;
	name?: string;
	description?: string;
	tags?: string[];
	method?: string;
	path?: string;
	paths?: string[];
	url?: string;
	headers?: HeaderMap;
	body?: string;
	bodyBase64?: string;
};

export const MAX_TEMPLATE_REGEX_PATTERN_CHARS = SAFE_REGEX_DEFAULT_MAX_PATTERN_CHARS;
export const MAX_TEMPLATE_REGEX_TEXT_CHARS = 64 * 1024;
const TEMPLATE_REGEX_ERROR_CODE = "TEMPLATE_REGEX_UNSAFE";

const BUILTIN_TEMPLATE_CHECKS: TemplateDefinition[] = [
	{ id: "exposure-env", name: ".env exposure", tags: ["exposure", "config"], paths: ["/.env", "/.env.local", "/.env.production"], matchStatus: [200], bodyRegex: ["^(?:APP_KEY|SECRET_KEY|DB_PASSWORD|DATABASE_URL|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)\\s*="] },
	{ id: "git-config", name: ".git/config exposure", tags: ["exposure", "git"], paths: ["/.git/config"], matchStatus: [200], bodyRegex: ["^\\s*\\[core\\]", "repositoryformatversion\\s*="] },
	{ id: "phpinfo", name: "phpinfo exposure", tags: ["php", "exposure"], paths: ["/phpinfo.php", "/info.php", "/php.php"], matchStatus: [200], bodyRegex: ["PHP Version|phpinfo\\(\\)"] },
	{ id: "openapi", name: "OpenAPI/Swagger document", tags: ["api", "docs"], paths: ["/openapi.json", "/swagger.json", "/v3/api-docs", "/api-docs"], matchStatus: [200], bodyRegex: ["(?:\\\"openapi\\\"\\s*:\\s*\\\"3\\.|\\\"swagger\\\"\\s*:\\s*\\\"2\\.0\\\")"] },
	{ id: "graphql", name: "GraphQL endpoint", tags: ["api", "graphql"], paths: ["/graphql?query=%7B__typename%7D", "/api/graphql?query=%7B__typename%7D"], matchStatus: [200], bodyRegex: ["__typename|GraphQL|Cannot query field|errors"] },
	{ id: "spring-actuator-env", name: "Spring actuator env", tags: ["spring", "actuator"], paths: ["/actuator/env", "/env"], matchStatus: [200], bodyRegex: ["propertySources|activeProfiles|spring\\.profiles"] },
];

export function templateVariablesFor(url: string, variables: unknown): Record<string, string> {
	const parsed = new URL(url);
	const vars: Record<string, string> = { baseUrl: parsed.origin, origin: parsed.origin, host: parsed.host, hostname: parsed.hostname, protocol: parsed.protocol.replace(/:$/, ""), path: parsed.pathname };
	if (isRecord(variables)) for (const [key, value] of Object.entries(variables)) vars[key] = asString(value) ?? JSON.stringify(value);
	return vars;
}

export function applyTemplateVars(text: string, vars: Record<string, string>): string {
	return text.replace(/\\?\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, name) => match.startsWith("\\") ? match.slice(1) : vars[name] ?? "");
}

function parseTemplateFileContent(text: string, path: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		const parsed = tryJson(trimmed);
		if (parsed === undefined) throw new Error(`Invalid JSON template content in ${path}`);
		return parsed;
	}
	if (/\.ya?ml$/i.test(path) || /^[A-Za-z0-9_-]+\s*:/.test(trimmed)) return yaml.load(trimmed) ?? [];
	const parsed = tryJson(trimmed);
	if (parsed === undefined) throw new Error(`Invalid template content in ${path}; expected JSON or YAML`);
	return parsed;
}

export function normalizeDslMatchers(value: unknown): TemplateDslMatcher[] {
	return (Array.isArray(value) ? value : value !== undefined ? [value] : []).filter(isRecord).map((item) => ({
		type: String(item.type || item.kind || "word").toLowerCase(),
		part: asString(item.part) || asString(item.scope),
		name: asString(item.name) || asString(item.header),
		status: numericList(item.status ?? item.statuses),
		words: stringList(item.words ?? item.word ?? item.value),
		regex: stringList(item.regex ?? item.regexes ?? item.pattern),
		value: asString(item.value),
		negative: item.negative === true,
	}));
}

export function normalizeDslExtractors(value: unknown): TemplateDslExtractor[] {
	return (Array.isArray(value) ? value : value !== undefined ? [value] : []).filter(isRecord).map((item) => ({
		type: String(item.type || item.kind || "regex").toLowerCase(),
		name: asString(item.name),
		part: asString(item.part) || asString(item.scope),
		header: asString(item.header),
		cookie: asString(item.cookie),
		regex: stringList(item.regex ?? item.regexes ?? item.pattern),
		group: positiveInt(item.group, 0),
		jsonPath: asString(item.jsonPath ?? item.path),
	}));
}

function normalizeTemplate(value: unknown, index: number): TemplateDefinition | undefined {
	if (!isRecord(value)) return undefined;
	const id = asString(value.id)?.trim() || `custom-${index + 1}`;
	const template: TemplateDefinition = {
		id,
		name: asString(value.name),
		description: asString(value.description),
		tags: stringList(value.tags),
		method: asString(value.method),
		path: asString(value.path),
		paths: stringList(value.paths),
		url: asString(value.url),
		headers: normalizeHeaders(value.headers),
		body: asString(value.body),
		bodyBase64: asString(value.bodyBase64),
		matchStatus: numericList(value.matchStatus),
		filterStatus: numericList(value.filterStatus),
		bodyIncludes: stringList(value.bodyIncludes),
		bodyRegex: stringList(value.bodyRegex),
		headerIncludes: normalizeHeaders(value.headerIncludes),
		headerRegex: normalizeHeaders(value.headerRegex),
		extractRegex: stringList(value.extractRegex),
		matchers: normalizeDslMatchers(value.matchers),
		extractors: normalizeDslExtractors(value.extractors),
		matcherMode: String(value.matcherMode || value.matcherCondition || value["matchers-condition"] || "all").toLowerCase() === "any" ? "any" : "all",
	};
	return template;
}

export async function loadTemplateDefinitions(options: TemplateCheckOptions): Promise<TemplateDefinition[]> {
	const selected = stringList(options.templateIds).flatMap((item) => item.split(/[,\s]+/)).filter(Boolean);
	const selectedSet = new Set(selected.map((item) => item.toLowerCase()));
	const inline = (Array.isArray(options.templates) ? options.templates : options.templates !== undefined ? [options.templates] : []).map(normalizeTemplate).filter((item): item is TemplateDefinition => !!item);
	const fromFile: TemplateDefinition[] = [];
	const templatePath = asString(options.templatePath)?.trim();
	let builtins = inline.length || templatePath ? [] : BUILTIN_TEMPLATE_CHECKS;
	if (selectedSet.size) builtins = selectedSet.has("all") ? BUILTIN_TEMPLATE_CHECKS : BUILTIN_TEMPLATE_CHECKS.filter((item) => selectedSet.has(item.id.toLowerCase()) || item.tags?.some((tag) => selectedSet.has(tag.toLowerCase())));
	if (templatePath) {
		const parsed = parseTemplateFileContent(await readFile(templatePath, "utf8"), templatePath);
		for (const item of Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.templates) ? parsed.templates : [parsed]) {
			const template = normalizeTemplate(item, fromFile.length);
			if (template) fromFile.push(template);
		}
	}
	const merged = [...builtins, ...inline, ...fromFile];
	const seen = new Set<string>();
	return merged.filter((item) => {
		const key = item.id;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function templateTargetsForBase(baseUrl: string, template: TemplateDefinition, variables: unknown): string[] {
	const vars = templateVariablesFor(baseUrl, variables);
	if (template.url) return [absoluteUrl(applyTemplateVars(template.url, vars), { baseUrl })];
	const paths = template.paths?.length ? template.paths : template.path ? [template.path] : [new URL(baseUrl).pathname + new URL(baseUrl).search];
	return paths.map((path) => new URL(applyTemplateVars(path, vars), baseUrl).toString());
}

function templatePartText(part: string | undefined, final: FetchStep, headersLower: HeaderMap, name?: string): string {
	const normalized = String(part || "body").toLowerCase();
	if (normalized === "status") return String(final.status);
	if (normalized === "header" || normalized === "headers") return name ? headersLower[name.trim().toLowerCase()] || "" : Object.entries(headersLower).map(([key, value]) => `${key}: ${value}`).join("\n");
	if (normalized === "title") return extractTitle(final.bodyText) || "";
	if (normalized === "all") return `${final.status}\n${Object.entries(headersLower).map(([key, value]) => `${key}: ${value}`).join("\n")}\n\n${final.bodyText}`;
	return final.bodyText;
}

function templateRegexInput(text: string): { text: string; truncated: boolean } {
	if (text.length <= MAX_TEMPLATE_REGEX_TEXT_CHARS) return { text, truncated: false };
	return { text: text.slice(0, MAX_TEMPLATE_REGEX_TEXT_CHARS), truncated: true };
}

function templateRegexIssue(pattern: string, reason: string, flags: string, textTruncated = false): Record<string, unknown> {
	return { error_code: TEMPLATE_REGEX_ERROR_CODE, reason, pattern, flags, maxPatternChars: MAX_TEMPLATE_REGEX_PATTERN_CHARS, maxTextChars: MAX_TEMPLATE_REGEX_TEXT_CHARS, textTruncated };
}

function compileTemplateRegex(pattern: string, flags: string, textTruncated = false): { regex?: RegExp; issue?: Record<string, unknown> } {
	const unsafeReason = unsafeRegexReason(pattern, MAX_TEMPLATE_REGEX_PATTERN_CHARS);
	if (unsafeReason) return { issue: templateRegexIssue(pattern, unsafeReason, flags, textTruncated) };
	try { return { regex: new RegExp(pattern, flags) }; }
	catch (error) { return { issue: templateRegexIssue(pattern, error instanceof Error ? error.message : String(error), flags, textTruncated) }; }
}

function testTemplateRegex(pattern: string, flags: string, text: string): { matched: boolean; issue?: Record<string, unknown>; textTruncated: boolean } {
	const input = templateRegexInput(text);
	const compiled = compileTemplateRegex(pattern, flags, input.truncated);
	if (!compiled.regex) return { matched: false, issue: compiled.issue, textTruncated: input.truncated };
	return { matched: compiled.regex.test(input.text), textTruncated: input.truncated };
}

function execTemplateRegex(pattern: string, flags: string, text: string, maxMatches = 20): { matches: RegExpExecArray[]; issue?: Record<string, unknown>; textTruncated: boolean } {
	const input = templateRegexInput(text);
	const normalizedFlags = flags.includes("g") ? flags : `${flags}g`;
	const compiled = compileTemplateRegex(pattern, normalizedFlags, input.truncated);
	const matches: RegExpExecArray[] = [];
	if (!compiled.regex) return { matches, issue: compiled.issue, textTruncated: input.truncated };
	if (maxMatches <= 0) return { matches, textTruncated: input.truncated };
	let match: RegExpExecArray | null;
	while ((match = compiled.regex.exec(input.text)) && matches.length < maxMatches) {
		matches.push(match);
		if (match[0] === "") compiled.regex.lastIndex += 1;
	}
	return { matches, textTruncated: input.truncated };
}

function regexIssueFields(result: { issue?: Record<string, unknown>; textTruncated?: boolean }): Record<string, unknown> {
	if (result.issue) return { regexIssue: result.issue };
	return result.textTruncated ? { regexInputTruncated: true, maxTextChars: MAX_TEMPLATE_REGEX_TEXT_CHARS } : {};
}

function evaluateDslMatcher(matcher: TemplateDslMatcher, final: FetchStep, headersLower: HeaderMap): Record<string, unknown> {
	let matched = false;
	const type = matcher.type || "word";
	const part = matcher.part || (type === "status" ? "status" : "body");
	const text = templatePartText(part, final, headersLower, matcher.name);
	if (type === "status") matched = matcher.status?.length ? matcher.status.includes(final.status) : text === matcher.value;
	else if (type === "word") matched = matcher.words?.length ? matcher.words.every((word) => text.includes(word)) : matcher.value !== undefined ? text.includes(matcher.value) : false;
	else if (type === "regex") matched = (matcher.regex || []).some((pattern) => testTemplateRegex(pattern, "im", text).matched);
	else if (type === "contains") matched = matcher.value !== undefined && text.includes(matcher.value);
	else if (type === "equals") matched = matcher.value !== undefined && text === matcher.value;
	if (matcher.negative) matched = !matched;
	const regexDiagnostics = type === "regex"
		? (matcher.regex || [])
			.map((pattern) => ({ pattern, ...regexIssueFields(testTemplateRegex(pattern, "im", text)) }))
			.filter((item) => ("regexIssue" in item) || ("regexInputTruncated" in item))
		: [];
	return { kind: `dsl:${type}`, matched, part, name: matcher.name, expected: matcher.status?.length ? matcher.status : matcher.words?.length ? matcher.words : (matcher.regex || []).length ? matcher.regex : matcher.value, negative: matcher.negative === true, ...(regexDiagnostics.length ? { regexDiagnostics } : {}) };
}

export function jsonPathParts(path: string): Array<string | number> {
	const out: Array<string | number> = [];
	const re = /([^.[\]]+)|\[(\d+|"[^"]+"|'[^']+')\]/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(path))) {
		if (match[1]) out.push(match[1]);
		else if (/^\d+$/.test(match[2])) out.push(Number(match[2]));
		else out.push(match[2].slice(1, -1));
	}
	return out.length ? out : [path];
}

function jsonPathValue(root: unknown, path: string): unknown {
	let current: any = root;
	for (const part of jsonPathParts(path.replace(/^\$\.?/, ""))) {
		current = current?.[part as any];
		if (current === undefined || current === null) return current;
	}
	return current;
}

export function evaluateDslExtractor(extractor: TemplateDslExtractor, final: FetchStep, headersLower: HeaderMap): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = [];
	const type = extractor.type || "regex";
	const part = extractor.part || (extractor.header ? "header" : "body");
	const text = templatePartText(part, final, headersLower, extractor.header || extractor.name);
	if (type === "header") {
		const value = headersLower[(extractor.header || extractor.name || "").trim().toLowerCase()];
		if (value !== undefined) out.push({ name: extractor.name || extractor.header, type, part: "header", value, values: [value] });
		return out;
	}
	if (type === "cookie") {
		const cookieName = extractor.cookie || extractor.name;
		for (const line of final.setCookie || []) {
			const parsed = parseSetCookieLine(line, "set-cookie");
			if (!parsed || (cookieName && parsed.name !== cookieName)) continue;
			out.push({ name: extractor.name || parsed.name, type, part: "header", cookie: parsed.name, value: parsed.value, values: [parsed.value], attributes: parsed.attributes });
			if (out.length >= 20) break;
		}
		return out;
	}
	if (type === "status") {
		out.push({ name: extractor.name || "status", type, part: "status", value: final.status, values: [final.status] });
		return out;
	}
	if (type === "title") {
		const value = extractTitle(final.bodyText);
		if (value !== undefined) out.push({ name: extractor.name || "title", type, part: "title", value, values: [value] });
		return out;
	}
	if (type === "location") {
		const value = redirectLocation(final.status, final.headers, final.url);
		if (value !== undefined) out.push({ name: extractor.name || "location", type, part: "header", value, values: [value] });
		return out;
	}
	if (type === "body-sha256" || type === "bodysha256" || type === "sha256") {
		const value = responseBodyHash(final);
		out.push({ name: extractor.name || "bodySha256", type: "body-sha256", part: "body", value, values: [value] });
		return out;
	}
	if (type === "json") {
		try {
			const value = jsonPathValue(JSON.parse(final.bodyText), extractor.jsonPath || "$");
			if (value !== undefined) out.push({ name: extractor.name || extractor.jsonPath, type, part: "body", jsonPath: extractor.jsonPath, value, values: Array.isArray(value) ? value : [value] });
		} catch {}
		return out;
	}
	for (const pattern of extractor.regex || []) {
		const result = execTemplateRegex(pattern, "igm", text, 20 - out.length);
		if (result.issue) {
			out.push({ name: extractor.name, type: "regex", part, pattern, skipped: true, ...result.issue });
			continue;
		}
		for (const match of result.matches) {
			const group = extractor.group || 0;
			const value = match[group] ?? match[0];
			out.push({ name: extractor.name, type: "regex", part, pattern, match: match[0], groups: match.slice(1, 6), group, value, values: [value], ...(result.textTruncated ? { regexInputTruncated: true, maxTextChars: MAX_TEMPLATE_REGEX_TEXT_CHARS } : {}) });
		}
		if (result.textTruncated && !result.matches.length) out.push({ name: extractor.name, type: "regex", part, pattern, skipped: true, regexInputTruncated: true, maxTextChars: MAX_TEMPLATE_REGEX_TEXT_CHARS });
		if (out.length >= 20) break;
	}
	return out;
}

export function evaluateTemplateMatcher(template: TemplateDefinition, final: FetchStep) {
	const checks: Array<Record<string, unknown>> = [];
	const headersLower: HeaderMap = {};
	for (const [name, value] of Object.entries(final.headers)) headersLower[name.trim().toLowerCase()] = value;
	if (template.matchStatus?.length) checks.push({ kind: "matchStatus", matched: template.matchStatus.includes(final.status), expected: template.matchStatus, actual: final.status });
	if (template.filterStatus?.length) checks.push({ kind: "filterStatus", matched: !template.filterStatus.includes(final.status), expected: template.filterStatus, actual: final.status });
	for (const expected of template.bodyIncludes || []) checks.push({ kind: "bodyIncludes", matched: final.bodyText.includes(expected), expected });
	for (const pattern of template.bodyRegex || []) {
		const result = testTemplateRegex(pattern, "im", final.bodyText);
		checks.push({ kind: "bodyRegex", matched: result.matched, expected: pattern, ...regexIssueFields(result) });
	}
	for (const [name, expected] of Object.entries(template.headerIncludes || {})) checks.push({ kind: "headerIncludes", header: name, matched: (headersLower[name.trim().toLowerCase()] || "").includes(expected), expected });
	for (const [name, pattern] of Object.entries(template.headerRegex || {})) {
		const result = testTemplateRegex(pattern, "i", headersLower[name.trim().toLowerCase()] || "");
		checks.push({ kind: "headerRegex", header: name, matched: result.matched, expected: pattern, ...regexIssueFields(result) });
	}
	for (const matcher of template.matchers || []) checks.push(evaluateDslMatcher(matcher, final, headersLower));
	const mode = template.matcherMode || "all";
	const matched = checks.length ? mode === "any" ? checks.some((item) => item.matched === true) : checks.every((item) => item.matched === true) : final.status >= 200 && final.status < 400;
	const extracts: Array<Record<string, unknown>> = [];
	for (const pattern of template.extractRegex || []) {
		const result = execTemplateRegex(pattern, "igm", final.bodyText, 20 - extracts.length);
		if (result.issue) {
			extracts.push({ name: "extractRegex", type: "regex", part: "body", pattern, skipped: true, ...result.issue });
			continue;
		}
		for (const match of result.matches) extracts.push({ name: "extractRegex", type: "regex", part: "body", pattern, match: match[0], groups: match.slice(1, 6), group: 0, value: match[0], values: [match[0]], ...(result.textTruncated ? { regexInputTruncated: true, maxTextChars: MAX_TEMPLATE_REGEX_TEXT_CHARS } : {}) });
		if (result.textTruncated && !result.matches.length) extracts.push({ name: "extractRegex", type: "regex", part: "body", pattern, skipped: true, regexInputTruncated: true, maxTextChars: MAX_TEMPLATE_REGEX_TEXT_CHARS });
		if (extracts.length >= 20) break;
	}
	for (const extractor of template.extractors || []) {
		for (const item of evaluateDslExtractor(extractor, final, headersLower)) {
			if (extracts.length < 20) extracts.push(item);
		}
	}
	return { matched, mode, checks, extracts };
}

export function dedupeTemplateResults(results: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
	const seen = new Set<string>();
	const out: Array<Record<string, unknown>> = [];
	for (const item of results) {
		const key = `${item.templateId}|${item.method}|${item.url}|${item.status}|${item.bodySha256 || ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}
	return out;
}
