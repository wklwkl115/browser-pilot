import { Buffer } from "node:buffer";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { compactStep, contentTypeOf, extractTitle, fetchWithRedirects, normalizeHeaders, normalizeProbeTargets, responseBodyHash, sanitizeFetchHeaders } from "../shared/http";
import { asString, isRecord, normalizeMethod, positiveInt, sha256Hex, stringList, tryJson } from "../shared/normalize";
import type { CrawlOptions, HeaderMap, WebFetchOptions } from "../shared/types";

const GRAPHQL_INTROSPECTION_QUERY = "query PiBrowserToolsIntrospection { __schema { queryType { name } mutationType { name } subscriptionType { name } types { name fields { name args { name } } } } }";

function normalizeUrlForVisit(url: string): string {
	const parsed = new URL(url);
	parsed.hash = "";
	return parsed.toString();
}

function safeArchiveSegment(value: string, fallback = "source") {
	const normalized = value.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 80);
	return normalized || fallback;
}

function sourceMapArchiveRelativePath(url: string, sourceName: string, index: number): string {
	const mapKey = `source-map-${sha256Hex(url).slice(0, 12)}`;
	const normalized = sourceName.replace(/^[a-z]+:\/+/i, "").replace(/[?#].*$/, "").replace(/\\/g, "/");
	const segments = normalized.split("/").filter(Boolean).slice(-4).map((part, partIndex) => safeArchiveSegment(part, `part-${partIndex + 1}`));
	const fileName = `${String(index + 1).padStart(3, "0")}-${segments.pop() || "source.txt"}`;
	const parent = segments.length ? segments.join("/") : "sources";
	return path.posix.join("source-maps", mapKey, parent, fileName);
}

async function createCrawlArtifactRoot(): Promise<string> {
	const artifactBaseDir = path.resolve(process.cwd(), ".pi", "browser-artifacts");
	await mkdir(artifactBaseDir, { recursive: true });
	return mkdtemp(path.join(artifactBaseDir, "crawl-"));
}

function resolveSourceMapSourceUrl(sourceName: string, sourceRoot: string | undefined, mapUrl: string): string | undefined {
	if (/^[a-z]+:\/\//i.test(sourceName)) return normalizeUrlForVisit(sourceName);
	if (/^(?:webpack|ng|file):/i.test(sourceName)) return undefined;
	const raw = sourceRoot ? `${sourceRoot.replace(/\/$/, "")}/${sourceName.replace(/^\//, "")}` : sourceName;
	return absolutizeMaybe(raw, mapUrl);
}

function extractVersionTokens(value: string): string[] {
	const out: string[] = [];
	for (const match of value.matchAll(/\b(?:v?\d+(?:[._-]\d+){0,3}|[a-f0-9]{7,})\b/gi)) out.push(match[0]);
	return out;
}

function knownFilePaths(value: unknown): string[] {
	const mode = String(value || "none").toLowerCase();
	if (mode === "all" || mode === "true") return ["/robots.txt", "/sitemap.xml", "/openapi.json", "/swagger.json", "/v3/api-docs", "/api-docs", "/graphql", "/manifest.json", "/site.webmanifest", "/service-worker.js", "/sw.js"];
	if (mode === "robotstxt" || mode === "robots" || mode === "robots.txt") return ["/robots.txt"];
	if (mode === "sitemapxml" || mode === "sitemap" || mode === "sitemap.xml") return ["/sitemap.xml"];
	if (mode === "api" || mode === "openapi" || mode === "swagger") return ["/openapi.json", "/swagger.json", "/v3/api-docs", "/api-docs"];
	if (mode === "graphql") return ["/graphql"];
	if (mode === "webapp" || mode === "manifest" || mode === "serviceworker") return ["/manifest.json", "/site.webmanifest", "/service-worker.js", "/sw.js"];
	return [];
}

function normalizeCrawlSeeds(options: CrawlOptions): string[] {
	const seeds = normalizeProbeTargets({ url: options.url, urls: options.urls, paths: options.paths, defaultScheme: options.defaultScheme });
	const known = knownFilePaths(options.knownFiles);
	const withKnown = [...seeds];
	for (const seed of seeds) for (const knownPath of known) withKnown.push(new URL(knownPath, seed).toString());
	return [...new Set(withKnown.map(normalizeUrlForVisit))];
}

function inScope(url: string, seedOrigins: Set<string>, sameOrigin: boolean): boolean {
	if (!/^https?:\/\//i.test(url)) return false;
	if (!sameOrigin) return true;
	try {
		return seedOrigins.has(new URL(url).origin);
	} catch {
		return false;
	}
}

function absolutizeMaybe(raw: string, baseUrl: string): string | undefined {
	const value = raw.replace(/&amp;/g, "&").trim();
	if (!value || /^(?:javascript|mailto|tel|data):/i.test(value)) return undefined;
	try {
		return normalizeUrlForVisit(new URL(value, baseUrl).toString());
	} catch {
		return undefined;
	}
}

function extractAttributeUrls(html: string, baseUrl: string) {
	const links: Array<{ url: string; kind: string }> = [];
	const attrRe = /\b(href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
	let match: RegExpExecArray | null;
	while ((match = attrRe.exec(html))) {
		const attr = match[1].toLowerCase();
		const url = absolutizeMaybe(match[2] || match[3] || match[4] || "", baseUrl);
		if (!url) continue;
		links.push({ url, kind: attr === "src" ? "resource" : attr === "action" ? "form" : "link" });
	}
	return links;
}

function extractScriptSources(html: string, baseUrl: string): string[] {
	const scripts = extractAttributeUrls(html, baseUrl).filter((item) => item.kind === "resource" && /\.(?:m?js)(?:[?#]|$)/i.test(item.url)).map((item) => item.url);
	return [...new Set(scripts)];
}

function extractManifestUrls(html: string, baseUrl: string): string[] {
	const out: string[] = [];
	const linkRe = /<link\b([^>]*\brel\s*=\s*(?:"[^"]*manifest[^"]*"|'[^']*manifest[^']*'|[^\s>]*manifest[^\s>]*)[^>]*)>/gi;
	let match: RegExpExecArray | null;
	while ((match = linkRe.exec(html))) {
		const href = match[1].match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
		const url = absolutizeMaybe(href?.[1] || href?.[2] || href?.[3] || "", baseUrl);
		if (url) out.push(url);
	}
	return [...new Set(out)];
}

function extractServiceWorkerUrls(text: string, baseUrl: string): string[] {
	const out: string[] = [];
	const re = /\bserviceWorker\s*\.\s*register\s*\(\s*["'`]([^"'`]+)["'`]/gi;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text))) {
		const url = absolutizeMaybe(match[1], baseUrl);
		if (url) out.push(url);
	}
	return [...new Set(out)];
}

function extractSourceMapUrls(text: string, baseUrl: string): string[] {
	const out: string[] = [];
	const re = /[#@]\s*sourceMappingURL\s*=\s*([^\s*]+)/gi;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text))) {
		const url = absolutizeMaybe(match[1], baseUrl);
		if (url) out.push(url);
	}
	return [...new Set(out)];
}

function extractForms(html: string, baseUrl: string) {
	const forms = [] as Array<{ method: string; action: string; inputNames: string[] }>;
	const formRe = /<form\b([\s\S]*?)>([\s\S]*?)<\/form>/gi;
	let match: RegExpExecArray | null;
	while ((match = formRe.exec(html))) {
		const attrs = match[1] || "";
		const body = match[2] || "";
		const method = (attrs.match(/\bmethod\s*=\s*["']?([^"'\s>]+)/i)?.[1] || "GET").toUpperCase();
		const actionRaw = attrs.match(/\baction\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
		const action = absolutizeMaybe(actionRaw?.[1] || actionRaw?.[2] || actionRaw?.[3] || baseUrl, baseUrl) || baseUrl;
		const inputNames = Array.from(body.matchAll(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)).map((item) => item[1] || item[2] || item[3]).filter(Boolean).slice(0, 40);
		forms.push({ method, action, inputNames });
	}
	return forms;
}

function endpointKindFor(url: string, fallback: string): string {
	if (/graphql/i.test(url)) return "graphql";
	if (/(?:openapi|swagger|api-docs)/i.test(url)) return "openapi";
	if (/(?:manifest\.json|site\.webmanifest)(?:[?#]|$)/i.test(url)) return "manifest";
	if (/(?:service-worker|sw)\.js(?:[?#]|$)/i.test(url)) return "service-worker";
	if (/\.map(?:[?#]|$)/i.test(url)) return "source-map";
	return fallback;
}

function extractStringUrls(text: string, baseUrl: string) {
	const out: Array<{ url: string; kind: string; method?: string; source?: string }> = [];
	const add = (raw: string, kind: string, method?: string, source?: string) => {
		const url = absolutizeMaybe(raw, baseUrl);
		if (url) out.push({ url, kind: endpointKindFor(url, kind), method, source });
	};
	let match: RegExpExecArray | null;
	const fetchRe = /\bfetch\s*\(\s*["'`]([^"'`]+)["'`](?:\s*,\s*([\s\S]{0,300}?))?\)/gi;
	while ((match = fetchRe.exec(text))) {
		const method = match[2]?.match(/\bmethod\s*:\s*["'`]([A-Z]+)["'`]/i)?.[1]?.toUpperCase();
		add(match[1], "fetch", method || "GET", "fetch");
	}
	const axiosRe = /\baxios(?:\s*\.\s*(get|post|put|patch|delete|head|options))?\s*\(\s*["'`]([^"'`]+)["'`]/gi;
	while ((match = axiosRe.exec(text))) add(match[2], "axios", (match[1] || "GET").toUpperCase(), "axios");
	const xhrRe = /\.open\s*\(\s*["'`]([A-Z]+)["'`]\s*,\s*["'`]([^"'`]+)["'`]/gi;
	while ((match = xhrRe.exec(text))) add(match[2], "xhr", match[1].toUpperCase(), "xhr");
	const literalRe = /["'`](\/[^"'`\s<>{}\\]*(?:api|admin|debug|internal|graphql|openapi|swagger|api-docs|v\d|manifest\.json|site\.webmanifest|service-worker|sw\.js|\.json|\.map)[^"'`\s<>{}\\]*)["'`]/gi;
	while ((match = literalRe.exec(text))) add(match[1], "endpoint", undefined, "literal");
	const absoluteRe = /["'`](https?:\/\/[^"'`\s<>{}\\]+)["'`]/gi;
	while ((match = absoluteRe.exec(text))) add(match[1], "endpoint", undefined, "literal");
	return [...new Map(out.map((item) => [`${item.kind}:${item.method || ""}:${item.url}`, item])).values()];
}

function extractKnownFileUrls(text: string, baseUrl: string) {
	const out: Array<{ url: string; kind: string }> = [];
	const patterns = [/^\s*Sitemap\s*:\s*(\S+)\s*$/gim, /<loc>\s*([^<\s]+)\s*<\/loc>/gi, /\bhttps?:\/\/[^\s<>'"]+/gi];
	for (const pattern of patterns) {
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(text))) {
			const url = absolutizeMaybe(match[1] || match[0], baseUrl);
			if (url) out.push({ url, kind: "known-file" });
		}
	}
	return [...new Map(out.map((item) => [item.url, item])).values()];
}

function decodeJsonPointerToken(value: string): string {
	return value.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveApiRef(root: Record<string, unknown>, ref: string): Record<string, unknown> | undefined {
	if (!ref.startsWith("#/")) return undefined;
	let current: unknown = root;
	for (const token of ref.slice(2).split("/").map(decodeJsonPointerToken)) {
		if (isRecord(current) || Array.isArray(current)) current = (current as Record<string, unknown>)[token];
		else return undefined;
	}
	return isRecord(current) ? current : undefined;
}

function dereferenceApiRecord(root: Record<string, unknown>, value: unknown, seen = new Set<string>()): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	const ref = asString(value.$ref);
	if (!ref) return value;
	if (seen.has(ref)) return undefined;
	const resolved = resolveApiRef(root, ref);
	return resolved ? dereferenceApiRecord(root, resolved, new Set([...seen, ref])) || resolved : undefined;
}

function apiSchemaType(value: unknown, root: Record<string, unknown>, seen = new Set<string>()): string | undefined {
	const schema = dereferenceApiRecord(root, value, seen);
	if (!schema) return undefined;
	if (typeof schema.type === "string") {
		if (schema.type === "array" && isRecord(schema.items)) return `array<${apiSchemaType(schema.items, root, seen) || "any"}>`;
		return schema.type;
	}
	if (Array.isArray(schema.enum) && schema.enum.length) return "enum";
	if (isRecord(schema.properties)) return "object";
	if (isRecord(schema.items)) return `array<${apiSchemaType(schema.items, root, seen) || "any"}>`;
	if (Array.isArray(schema.oneOf) && schema.oneOf.length) return "oneOf";
	if (Array.isArray(schema.anyOf) && schema.anyOf.length) return "anyOf";
	if (Array.isArray(schema.allOf) && schema.allOf.length) return "allOf";
	return undefined;
}

function collectApiSchemaFields(value: unknown, root: Record<string, unknown>, path: string, required: boolean, out: Array<Record<string, unknown>>, seen = new Set<string>()) {
	if (out.length >= 100) return;
	const schema = dereferenceApiRecord(root, value, seen);
	if (!schema) return;
	const properties = isRecord(schema.properties) ? Object.entries(schema.properties) : [];
	const items = isRecord(schema.items) ? schema.items : undefined;
	const variants = [schema.allOf, schema.oneOf, schema.anyOf].flatMap((item) => Array.isArray(item) ? item.filter(isRecord) : []);
	const type = apiSchemaType(schema, root, seen) || (properties.length ? "object" : items ? "array" : undefined);
	const enumValues = Array.isArray(schema.enum) ? schema.enum.slice(0, 10) : [];
	if (path && (!properties.length || enumValues.length || !type || type !== "object")) {
		const entry: Record<string, unknown> = { path, required, type };
		const format = asString(schema.format);
		if (format) entry.format = format;
		if (enumValues.length) entry.enumValues = enumValues;
		out.push(entry);
	}
	if (properties.length) {
		const requiredNames = new Set(stringList(schema.required));
		for (const [name, child] of properties) {
			collectApiSchemaFields(child, root, path ? `${path}.${name}` : name, requiredNames.has(name), out, seen);
			if (out.length >= 100) return;
		}
	}
	if (items) collectApiSchemaFields(items, root, path ? `${path}[]` : "[]", required, out, seen);
	for (const variant of variants) {
		collectApiSchemaFields(variant, root, path, required, out, seen);
		if (out.length >= 100) return;
	}
}

function summarizeApiSchema(value: unknown, root: Record<string, unknown>) {
	const type = apiSchemaType(value, root);
	const rawFields: Array<Record<string, unknown>> = [];
	collectApiSchemaFields(value, root, "", false, rawFields);
	const fields = Array.from(new Map(rawFields.filter((item) => typeof item.path === "string").map((item) => [`${item.path}:${item.type || ""}`, item])).values()).slice(0, 50);
	return { type, fieldCount: fields.length, fields };
}

function summarizeApiRequestBody(root: Record<string, unknown>, pathItem: Record<string, unknown>, operation: Record<string, unknown>) {
	const resolvedOperation = dereferenceApiRecord(root, operation) || operation;
	const parameters = [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []), ...(Array.isArray(resolvedOperation.parameters) ? resolvedOperation.parameters : [])].map((item) => dereferenceApiRecord(root, item) || item).filter(isRecord);
	if (typeof root.swagger === "string") {
		const contentTypes = [...new Set([...(stringList(root.consumes)), ...(stringList(pathItem.consumes)), ...(stringList(resolvedOperation.consumes))])].slice(0, 20);
		const bodySchemas = parameters.filter((item) => item.in === "body" && isRecord(item.schema)).map((item) => item.schema);
		const formFields = parameters.filter((item) => item.in === "formData").map((item) => ({ path: String(item.name), required: item.required === true, type: apiSchemaType(item.schema, root) || asString(item.type) || "string" }));
		const schemaFields = bodySchemas.flatMap((schema) => summarizeApiSchema(schema, root).fields.filter(isRecord));
		const fields = Array.from(new Map([...schemaFields, ...formFields].map((item) => [`${item.path}:${item.type || ""}`, item])).values()).slice(0, 50);
		if (!fields.length && !contentTypes.length) return undefined;
		return { required: bodySchemas.length > 0 ? parameters.some((item) => item.in === "body" && item.required === true) : formFields.some((item) => item.required === true), contentTypes, fieldCount: fields.length, fields };
	}
	const requestBody = dereferenceApiRecord(root, resolvedOperation.requestBody) || (isRecord(resolvedOperation.requestBody) ? resolvedOperation.requestBody : undefined);
	if (!requestBody) return undefined;
	const content = isRecord(requestBody.content) ? requestBody.content : {};
	const contentTypes = Object.keys(content).slice(0, 20);
	const fields: Array<Record<string, unknown>> = [];
	for (const mediaType of contentTypes) {
		const media = dereferenceApiRecord(root, content[mediaType]) || content[mediaType];
		if (!isRecord(media) || !isRecord(media.schema)) continue;
		for (const field of summarizeApiSchema(media.schema, root).fields.filter(isRecord)) fields.push(field);
	}
	const dedupedFields = Array.from(new Map(fields.map((item) => [`${item.path}:${item.type || ""}`, item])).values()).slice(0, 50);
	return { required: requestBody.required === true, contentTypes, fieldCount: dedupedFields.length, fields: dedupedFields };
}

function summarizeApiOperationParameters(root: Record<string, unknown>, pathItem: Record<string, unknown>, operation: Record<string, unknown>) {
	const parameters = [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])]
		.map((item) => dereferenceApiRecord(root, item) || item)
		.filter(isRecord)
		.filter((item) => typeof item.name === "string" && typeof item.in === "string")
		.map((item) => {
			const schema = isRecord(item.schema) ? item.schema : undefined;
			const normalized: Record<string, unknown> = {
				name: item.name,
				in: item.in,
				required: item.required === true,
				type: apiSchemaType(schema, root) || asString(item.type),
			};
			const format = schema ? asString(schema.format) : undefined;
			if (format) normalized.format = format;
			const enumValues = schema && Array.isArray(schema.enum) ? schema.enum.slice(0, 10) : [];
			if (enumValues.length) normalized.enumValues = enumValues;
			return normalized;
		});
	const dedupedParameters = Array.from(new Map(parameters.map((item) => [`${item.in}:${item.name}`, item])).values()).slice(0, 50);
	const requestBody = summarizeApiRequestBody(root, pathItem, operation);
	const counts = { path: 0, query: 0, header: 0, cookie: 0, formData: 0 };
	for (const item of dedupedParameters) {
		const key = String(item.in || "");
		if (key in counts) counts[key as keyof typeof counts] += 1;
	}
	return {
		parameters: dedupedParameters,
		parameterCount: dedupedParameters.length,
		requestBody,
		parameterSummary: {
			totalParameters: dedupedParameters.length,
			pathCount: counts.path,
			queryCount: counts.query,
			headerCount: counts.header,
			cookieCount: counts.cookie,
			formDataCount: counts.formData,
			requestBodyRequired: requestBody?.required === true,
			requestBodyContentTypes: requestBody?.contentTypes || [],
			requestBodyFieldCount: requestBody?.fieldCount || 0,
			requestBodyFields: requestBody?.fields || [],
		},
	};
}

function summarizeApiSpecParameters(endpoints: Array<Record<string, unknown>>) {
	const requestBodyContentTypes = new Set<string>();
	const requestBodyFields = new Map<string, Record<string, unknown>>();
	let totalParameters = 0;
	let operationsWithParameters = 0;
	let pathCount = 0;
	let queryCount = 0;
	let headerCount = 0;
	let cookieCount = 0;
	let formDataCount = 0;
	let requestBodyFieldCount = 0;
	for (const endpoint of endpoints) {
		const summary = isRecord(endpoint.parameterSummary) ? endpoint.parameterSummary : undefined;
		if (!summary) continue;
		totalParameters += Number(summary.totalParameters || 0);
		pathCount += Number(summary.pathCount || 0);
		queryCount += Number(summary.queryCount || 0);
		headerCount += Number(summary.headerCount || 0);
		cookieCount += Number(summary.cookieCount || 0);
		formDataCount += Number(summary.formDataCount || 0);
		requestBodyFieldCount += Number(summary.requestBodyFieldCount || 0);
		if (Number(summary.totalParameters || 0) > 0 || Number(summary.requestBodyFieldCount || 0) > 0) operationsWithParameters += 1;
		for (const contentType of stringList(summary.requestBodyContentTypes)) requestBodyContentTypes.add(contentType);
		for (const field of Array.isArray(summary.requestBodyFields) ? summary.requestBodyFields.filter(isRecord) : []) {
			if (typeof field.path === "string") requestBodyFields.set(`${field.path}:${field.type || ""}`, field);
		}
	}
	return {
		totalParameters,
		operationsWithParameters,
		pathCount,
		queryCount,
		headerCount,
		cookieCount,
		formDataCount,
		requestBodyFieldCount,
		requestBodyContentTypes: Array.from(requestBodyContentTypes).slice(0, 20),
		requestBodyFields: Array.from(requestBodyFields.values()).slice(0, 50),
	};
}

function parseApiSpecEndpoints(parsed: Record<string, unknown>, specUrl: string): Array<Record<string, unknown>> {
	const methods = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);
	const endpoints: Array<Record<string, unknown>> = [];
	let bases: string[] = [new URL(specUrl).origin];
	if (Array.isArray(parsed.servers)) {
		const serverUrls = parsed.servers.filter(isRecord).map((server) => asString(server.url)).filter(Boolean).map((serverUrl) => {
			const resolved = String(serverUrl).replace(/\{([^}]+)\}/g, (_match, name) => isRecord(parsed.variables) && isRecord(parsed.variables[name]) ? asString(parsed.variables[name].default) || name : name);
			return new URL(resolved, specUrl).toString();
		});
		if (serverUrls.length) bases = serverUrls;
	} else if (typeof parsed.swagger === "string") {
		const schemes = stringList(parsed.schemes).length ? stringList(parsed.schemes) : [new URL(specUrl).protocol.replace(/:$/, "")];
		const host = asString(parsed.host) || new URL(specUrl).host;
		const basePath = asString(parsed.basePath) || "/";
		bases = schemes.map((scheme) => `${scheme}://${host}${basePath.endsWith("/") ? basePath : `${basePath}/`}`);
	}
	const paths = isRecord(parsed.paths) ? parsed.paths : {};
	for (const [path, pathItemValue] of Object.entries(paths)) {
		const pathItem = dereferenceApiRecord(parsed, pathItemValue) || pathItemValue;
		if (!isRecord(pathItem)) continue;
		for (const [method, operationValue] of Object.entries(pathItem)) {
			if (!methods.has(method.toLowerCase())) continue;
			const operation = dereferenceApiRecord(parsed, operationValue) || operationValue;
			if (!isRecord(operation)) continue;
			const parameterDetails = summarizeApiOperationParameters(parsed, pathItem, operation);
			for (const base of bases) {
				const url = new URL(path.replace(/\{([^}]+)\}/g, "{$1}"), base).toString();
				endpoints.push({
					url,
					kind: "api-endpoint",
					method: method.toUpperCase(),
					source: "openapi",
					operationId: operation.operationId,
					summary: operation.summary,
					...parameterDetails,
				});
			}
		}
	}
	return endpoints.slice(0, 500);
}

function detectApiSpec(bodyText: string, url: string, contentType: string): Record<string, unknown> | undefined {
	if (!/(?:json|yaml|yml|text|openapi|swagger)/i.test(contentType) && !/(?:openapi|swagger|api-docs)(?:[/?#.]|$)/i.test(url)) return undefined;
	const parsed = tryJson(bodyText);
	if (isRecord(parsed)) {
		if (typeof parsed.openapi === "string") {
			const endpoints = parseApiSpecEndpoints(parsed, url);
			return { kind: "openapi", version: parsed.openapi, title: isRecord(parsed.info) ? parsed.info.title : undefined, endpointCount: endpoints.length, endpoints, parameterSummary: summarizeApiSpecParameters(endpoints) };
		}
		if (typeof parsed.swagger === "string") {
			const endpoints = parseApiSpecEndpoints(parsed, url);
			return { kind: "swagger", version: parsed.swagger, title: isRecord(parsed.info) ? parsed.info.title : undefined, endpointCount: endpoints.length, endpoints, parameterSummary: summarizeApiSpecParameters(endpoints) };
		}
	}
	if (/\bopenapi\s*:/i.test(bodyText)) return { kind: "openapi-yaml" };
	if (/\bswagger\s*:/i.test(bodyText)) return { kind: "swagger-yaml" };
	return undefined;
}

function detectGraphqlSchema(bodyText: string): Record<string, unknown> | undefined {
	const parsed = tryJson(bodyText);
	const data = isRecord(parsed) && isRecord(parsed.data) ? parsed.data : parsed;
	const schema = isRecord(data) && isRecord(data.__schema) ? data.__schema : undefined;
	if (!schema) return undefined;
	const types = Array.isArray(schema.types) ? schema.types.filter(isRecord) : [];
	const queryType = isRecord(schema.queryType) ? asString(schema.queryType.name) : undefined;
	const mutationType = isRecord(schema.mutationType) ? asString(schema.mutationType.name) : undefined;
	const subscriptionType = isRecord(schema.subscriptionType) ? asString(schema.subscriptionType.name) : undefined;
	const fieldsFor = (typeName?: string) => {
		const found = types.find((type) => type.name === typeName);
		return isRecord(found) && Array.isArray(found.fields)
			? found.fields.filter(isRecord).map((field) => ({ name: field.name, args: Array.isArray(field.args) ? field.args.filter(isRecord).map((arg) => arg.name).slice(0, 20) : [] })).slice(0, 100)
			: [];
	};
	return { kind: "graphql-introspection", typeCount: types.length, queryType, mutationType, subscriptionType, queryFields: fieldsFor(queryType), mutationFields: fieldsFor(mutationType), subscriptionFields: fieldsFor(subscriptionType) };
}

function shouldProbeGraphqlIntrospection(url: string, contentType: string): boolean {
	return endpointKindFor(url, "") === "graphql" || /graphql/i.test(contentType);
}

async function probeGraphqlIntrospection(url: string, headers: HeaderMap, options: WebFetchOptions): Promise<Record<string, unknown> | undefined> {
	const requestHeaders = sanitizeFetchHeaders({ ...headers, Accept: "application/json, application/graphql-response+json", "Content-Type": "application/json" }).headers;
	try {
		const exchange = await fetchWithRedirects({ url, method: "POST", headers: requestHeaders, body: JSON.stringify({ query: GRAPHQL_INTROSPECTION_QUERY }) }, { ...options, followRedirects: true, maxRedirects: positiveInt(options.maxRedirects, 3) });
		const final = exchange.final;
		const schema = detectGraphqlSchema(final.bodyText);
		return { source: "active-probe", url: final.url, status: final.status, bodyBytes: final.bodyBytes, bodySha256: responseBodyHash(final), redirects: exchange.chain.slice(0, -1).map(compactStep), schema, error: schema ? undefined : final.status >= 400 ? `GraphQL introspection probe returned ${final.status}` : undefined };
	} catch (error) {
		return { source: "active-probe", url, error: error instanceof Error ? error.message : String(error) };
	}
}

async function parseSourceMapDetails(bodyText: string, url: string, ensureArtifactRoot: () => Promise<string>): Promise<Record<string, unknown> | undefined> {
	if (!/\.map(?:[?#]|$)/i.test(url)) return undefined;
	const parsed = tryJson(bodyText);
	if (!isRecord(parsed)) return undefined;
	const sources = stringList(parsed.sources).slice(0, 500);
	const sourceRoot = asString(parsed.sourceRoot);
	const sourcesContent = Array.isArray(parsed.sourcesContent) ? parsed.sourcesContent.map((item) => asString(item) || "") : [];
	const endpointHints: Array<Record<string, unknown>> = [];
	for (const [index, content] of sourcesContent.entries()) {
		for (const endpoint of extractStringUrls(content, url)) endpointHints.push({ ...endpoint, kind: endpointKindFor(String(endpoint.url), "source-map-endpoint"), source: "source-map-content", sourceName: sources[index] });
	}
	for (const source of sources) {
		if (/\/(?:api|admin|debug|internal|graphql|openapi|swagger|api-docs|v\d)\b/i.test(source)) {
			const resolved = resolveSourceMapSourceUrl(source, sourceRoot, url);
			if (resolved) endpointHints.push({ url: resolved, kind: endpointKindFor(resolved, "source-map-source"), source: "source-map-source", sourceName: source });
		}
	}
	const archivedSources: Array<Record<string, unknown>> = [];
	let archiveRelativeDir: string | undefined;
	if (sourcesContent.length) {
		const artifactRoot = await ensureArtifactRoot();
		for (let index = 0; index < Math.min(sources.length, sourcesContent.length, 200); index += 1) {
			const sourceName = sources[index] || `source-${index + 1}.txt`;
			const content = sourcesContent[index] || "";
			const relativePath = sourceMapArchiveRelativePath(url, sourceName, index);
			const absolutePath = path.join(artifactRoot, relativePath);
			await mkdir(path.dirname(absolutePath), { recursive: true });
			await writeFile(absolutePath, content, "utf8");
			archiveRelativeDir = path.posix.dirname(relativePath);
			archivedSources.push({
				sourceName,
				resolvedUrl: resolveSourceMapSourceUrl(sourceName, sourceRoot, url),
				relativePath,
				bytes: Buffer.byteLength(content),
				sha256: sha256Hex(content),
				endpointHintCount: extractStringUrls(content, url).length,
			});
		}
	}
	return {
		kind: "source-map",
		version: parsed.version,
		file: parsed.file,
		sourceRoot,
		sourceCount: sources.length,
		sources: sources.slice(0, 100),
		sourcesContentCount: sourcesContent.length,
		namesCount: Array.isArray(parsed.names) ? parsed.names.length : undefined,
		endpointHints: endpointHints.slice(0, 200),
		archivedSourceCount: archivedSources.length,
		archiveRelativeDir,
		archivedSources,
	};
}

function extractServiceWorkerCacheRoutes(text: string, baseUrl: string): Array<Record<string, unknown>> {
	const routes: Array<Record<string, unknown>> = [];
	const add = (raw: string, source: string) => {
		const url = absolutizeMaybe(raw, baseUrl);
		if (url) routes.push({ url, kind: endpointKindFor(url, "service-worker-cache"), source });
	};
	let match: RegExpExecArray | null;
	const addAllRe = /\.addAll\s*\(\s*\[([\s\S]{0,4000}?)\]\s*\)/gi;
	while ((match = addAllRe.exec(text))) {
		for (const item of match[1].matchAll(/["'`]([^"'`]+)["'`]/g)) add(item[1], "cache.addAll");
	}
	const cacheCallRe = /(?:caches\s*\.\s*(?:match|open)|cache\s*\.\s*(?:match|put|add))\s*\(\s*["'`]([^"'`]+)["'`]/gi;
	while ((match = cacheCallRe.exec(text))) add(match[1], "cache-call");
	const requestRe = /new\s+Request\s*\(\s*["'`]([^"'`]+)["'`]/gi;
	while ((match = requestRe.exec(text))) add(match[1], "new Request");
	return [...new Map(routes.map((item) => [`${item.kind}:${item.url}`, item])).values()].slice(0, 200);
}

function extractServiceWorkerVersionSummary(text: string, baseUrl: string) {
	const cacheNames = new Set<string>();
	const versionTokens = new Set<string>();
	const importScripts: string[] = [];
	let match: RegExpExecArray | null;
	const cacheNameRe = /\bcaches\s*\.\s*(?:open|delete)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
	while ((match = cacheNameRe.exec(text))) {
		const cacheName = match[1].trim();
		if (!cacheName) continue;
		cacheNames.add(cacheName);
		for (const token of extractVersionTokens(cacheName)) versionTokens.add(token);
	}
	const importScriptsRe = /\bimportScripts\s*\(([^)]{0,4000})\)/gi;
	while ((match = importScriptsRe.exec(text))) {
		for (const item of match[1].matchAll(/["'`]([^"'`]+)["'`]/g)) {
			const url = absolutizeMaybe(item[1], baseUrl);
			const value = url || item[1];
			importScripts.push(value);
			for (const token of extractVersionTokens(value)) versionTokens.add(token);
		}
	}
	return {
		cacheNameCount: cacheNames.size,
		cacheNames: Array.from(cacheNames).slice(0, 50),
		importScriptCount: importScripts.length,
		importScripts: [...new Set(importScripts)].slice(0, 50),
		versionTokenCount: versionTokens.size,
		versionTokens: Array.from(versionTokens).slice(0, 50),
	};
}

function isHtml(headers: HeaderMap, url: string): boolean {
	const type = contentTypeOf(headers);
	return /html|xml/i.test(type) || /\.(?:html?|xml)(?:[?#]|$)/i.test(url) || (!type && !/\.[a-z0-9]{2,6}(?:[?#]|$)/i.test(url));
}

function isJavaScript(headers: HeaderMap, url: string): boolean {
	const type = contentTypeOf(headers);
	return /javascript|ecmascript/i.test(type) || /\.(?:m?js)(?:[?#]|$)/i.test(url);
}

export async function runBrowserCrawl(options: CrawlOptions) {
	const seeds = normalizeCrawlSeeds(options);
	const maxDepth = Math.min(5, positiveInt(options.maxDepth, 2));
	const maxPages = Math.min(500, positiveInt(options.maxPages, 50));
	const sameOrigin = options.sameOrigin !== false;
	const extractJs = options.extractJs !== false;
	const seedOrigins = new Set(seeds.map((seed) => new URL(seed).origin));
	const baseHeaders = normalizeHeaders(options.headers);
	const queue = seeds.map((url) => ({ url, depth: 0, source: "seed" }));
	const visited = new Set<string>();
	const pages: Array<Record<string, unknown>> = [];
	const endpoints = new Map<string, Record<string, unknown>>();
	const failures: Array<Record<string, unknown>> = [];
	let artifactRoot: string | undefined;
	const ensureArtifactRoot = async () => {
		if (artifactRoot) return artifactRoot;
		artifactRoot = await createCrawlArtifactRoot();
		return artifactRoot;
	};

	while (queue.length && pages.length < maxPages) {
		const next = queue.shift();
		if (!next) break;
		const url = normalizeUrlForVisit(next.url);
		if (visited.has(url) || !inScope(url, seedOrigins, sameOrigin)) continue;
		visited.add(url);
		try {
			const headers = { ...baseHeaders };
			const cookie = options.bindBrowserSession === true ? await options.cookieProvider?.(url) : undefined;
			if (cookie) headers.Cookie = cookie;
			const sanitized = sanitizeFetchHeaders(headers);
			const exchange = await fetchWithRedirects({ url, method: "GET", headers: sanitized.headers }, { ...options, followRedirects: true, maxRedirects: positiveInt(options.maxRedirects, 5) });
			const final = exchange.final;
			const type = contentTypeOf(final.headers);
			const htmlLike = isHtml(final.headers, final.url);
			const jsLike = isJavaScript(final.headers, final.url);
			const links = htmlLike ? extractAttributeUrls(final.bodyText, final.url) : [];
			const forms = htmlLike ? extractForms(final.bodyText, final.url) : [];
			const scripts = htmlLike ? extractScriptSources(final.bodyText, final.url) : [];
			const manifests = htmlLike ? extractManifestUrls(final.bodyText, final.url) : [];
			const serviceWorkers = (htmlLike || jsLike) ? extractServiceWorkerUrls(final.bodyText, final.url) : [];
			const sourceMaps = (htmlLike || jsLike) ? extractSourceMapUrls(final.bodyText, final.url) : [];
			const apiSpec = detectApiSpec(final.bodyText, final.url, type);
			let graphqlSchema = /graphql/i.test(final.url) || /__schema|__typename/i.test(final.bodyText) ? detectGraphqlSchema(final.bodyText) : undefined;
			let graphqlProbe: Record<string, unknown> | undefined;
			if (graphqlSchema) graphqlSchema = { ...graphqlSchema, source: "passive-response" };
			else if (shouldProbeGraphqlIntrospection(final.url, type)) {
				graphqlProbe = await probeGraphqlIntrospection(final.url, headers, options);
				if (isRecord(graphqlProbe) && isRecord(graphqlProbe.schema)) graphqlSchema = { ...graphqlProbe.schema, source: "active-probe", probeStatus: graphqlProbe.status, probeUrl: graphqlProbe.url, probeBodySha256: graphqlProbe.bodySha256 };
			}
			const sourceMapDetails = await parseSourceMapDetails(final.bodyText, final.url, ensureArtifactRoot);
			const serviceWorkerCacheRoutes = jsLike && endpointKindFor(final.url, "") === "service-worker" ? extractServiceWorkerCacheRoutes(final.bodyText, final.url) : [];
			const serviceWorkerVersionSummary = jsLike && endpointKindFor(final.url, "") === "service-worker" ? extractServiceWorkerVersionSummary(final.bodyText, final.url) : undefined;
			const serviceWorkerDetails = serviceWorkerCacheRoutes.length || (isRecord(serviceWorkerVersionSummary) && ((Number(serviceWorkerVersionSummary.cacheNameCount || 0) > 0) || (Number(serviceWorkerVersionSummary.importScriptCount || 0) > 0) || (Number(serviceWorkerVersionSummary.versionTokenCount || 0) > 0)))
				? { kind: "service-worker", cacheRouteCount: serviceWorkerCacheRoutes.length, cacheRoutes: serviceWorkerCacheRoutes, versionSummary: serviceWorkerVersionSummary }
				: undefined;
			const stringEndpoints = (htmlLike || jsLike) ? extractStringUrls(final.bodyText, final.url) : [];
			const knownFileUrls = /(?:robots\.txt|sitemap\.xml)(?:[?#]|$)/i.test(final.url) ? extractKnownFileUrls(final.bodyText, final.url) : [];
			const apiEndpointHints = isRecord(apiSpec) && Array.isArray(apiSpec.endpoints) ? apiSpec.endpoints.filter(isRecord) : [];
			const sourceMapEndpointHints = isRecord(sourceMapDetails) && Array.isArray(sourceMapDetails.endpointHints) ? sourceMapDetails.endpointHints.filter(isRecord) : [];
			const discoveryHints = [
				...stringEndpoints,
				...knownFileUrls,
				...apiEndpointHints,
				...sourceMapEndpointHints,
				...serviceWorkerCacheRoutes,
				...manifests.map((manifestUrl) => ({ url: manifestUrl, kind: "manifest", source: "link" })),
				...serviceWorkers.map((serviceWorkerUrl) => ({ url: serviceWorkerUrl, kind: "service-worker", source: "serviceWorker.register" })),
				...sourceMaps.map((sourceMapUrl) => ({ url: sourceMapUrl, kind: "source-map", source: "sourceMappingURL" })),
			];
			if (apiSpec) discoveryHints.push({ url: final.url, kind: String(apiSpec.kind || "api-spec"), source: "document" });
			const scopedEndpointHints = discoveryHints.filter((endpoint) => inScope(endpoint.url, seedOrigins, sameOrigin));
			for (const endpoint of [...scopedEndpointHints, ...forms.map((form) => ({ url: form.action, kind: "form", method: form.method, inputNames: form.inputNames })).filter((form) => inScope(form.url, seedOrigins, sameOrigin))]) {
				endpoints.set(`${endpoint.kind}:${endpoint.method || ""}:${endpoint.url}`, { ...endpoint, sourceUrl: final.url });
			}
			if (next.depth < maxDepth) {
				for (const link of links) if (inScope(link.url, seedOrigins, sameOrigin)) queue.push({ url: link.url, depth: next.depth + 1, source: final.url });
				for (const endpoint of scopedEndpointHints) queue.push({ url: endpoint.url, depth: next.depth + 1, source: final.url });
			}
			if (extractJs && htmlLike) {
				for (const scriptUrl of scripts) {
					if (inScope(scriptUrl, seedOrigins, sameOrigin) && !visited.has(scriptUrl)) queue.push({ url: scriptUrl, depth: Math.min(next.depth + 1, maxDepth), source: final.url });
				}
			}
			pages.push({
				url: final.url,
				seedUrl: url,
				depth: next.depth,
				source: next.source,
				status: final.status,
				contentType: type,
				title: htmlLike ? extractTitle(final.bodyText) : undefined,
				bodyBytes: final.bodyBytes,
				bodyTruncated: final.bodyTruncated,
				redirects: exchange.chain.slice(0, -1).map(compactStep),
				links: links.map((item) => item.url).slice(0, 200),
				scripts: scripts.slice(0, 100),
				manifests: manifests.slice(0, 50),
				serviceWorkers: serviceWorkers.slice(0, 50),
				sourceMaps: sourceMaps.slice(0, 50),
				sourceMapDetails,
				apiSpec,
				graphqlSchema,
				graphqlProbe,
				serviceWorkerDetails,
				forms,
				endpoints: scopedEndpointHints.map((item) => item.url).slice(0, 100),
				endpointDetails: scopedEndpointHints.slice(0, 100),
			});
		} catch (error) {
			failures.push({ url, depth: next.depth, source: next.source, error: error instanceof Error ? error.message : String(error) });
		}
	}
	const sourceArchiveCount = pages.reduce((sum, page) => sum + Number(isRecord(page.sourceMapDetails) ? page.sourceMapDetails.archivedSourceCount || 0 : 0), 0);
	const serviceWorkerCacheNames = Array.from(new Set(pages.flatMap((page) => isRecord(page.serviceWorkerDetails) && isRecord(page.serviceWorkerDetails.versionSummary) && Array.isArray(page.serviceWorkerDetails.versionSummary.cacheNames) ? page.serviceWorkerDetails.versionSummary.cacheNames.map(String) : []))).slice(0, 100);
	const serviceWorkerVersionTokens = Array.from(new Set(pages.flatMap((page) => isRecord(page.serviceWorkerDetails) && isRecord(page.serviceWorkerDetails.versionSummary) && Array.isArray(page.serviceWorkerDetails.versionSummary.versionTokens) ? page.serviceWorkerDetails.versionSummary.versionTokens.map(String) : []))).slice(0, 100);
	return { ok: failures.length === 0, generatedAt: new Date().toISOString(), seeds, maxDepth, maxPages, sameOrigin, artifactRoot, sourceArchiveCount, serviceWorkerCacheNames, serviceWorkerVersionTokens, pageCount: pages.length, endpointCount: endpoints.size, pages, endpoints: Array.from(endpoints.values()), failures };
}
