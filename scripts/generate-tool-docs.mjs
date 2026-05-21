import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFile = path.join(root, "docs", "generated", "browser-tool-contract.generated.md");
const checkOnly = process.argv.includes("--check");

const SHARED_TOOL_PARAMS = ["tabId", "target", "detailLevel", "outputPath", "timeoutMs", "maxChars"];
const SHARED_WEB_SECURITY_PARAMS = ["tabId", "target", "detailLevel", "outputPath", "timeoutMs", "maxChars", "maxBodyBytes"];
const NATIVE_ACTION_PARAMS = ["action", "params", "tabId", "target", "detailLevel", "outputPath", "timeoutMs", "maxChars"];
const SHARED_TRANSFER_PARAMS = ["tabId", "target", "detailLevel", "outputPath", "timeoutMs", "maxChars"];

async function read(rel) {
	return await readFile(path.join(root, rel), "utf8");
}

async function walk(dirRel, predicate = () => true) {
	const dir = path.join(root, dirRel);
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const childRel = path.join(dirRel, entry.name).replace(/\\/g, "/");
		if (entry.isDirectory()) out.push(...await walk(childRel, predicate));
		else if (predicate(childRel)) out.push(childRel);
	}
	return out;
}

function escapeCell(value) {
	return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function isIdentStart(ch) {
	return /[A-Za-z_$]/.test(ch || "");
}

function findMatching(text, start, open = "{", close = "}") {
	let depth = 0;
	let quote = "";
	let escaped = false;
	for (let i = start; i < text.length; i += 1) {
		const ch = text[i];
		if (quote) {
			if (escaped) { escaped = false; continue; }
			if (ch === "\\") { escaped = true; continue; }
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
		if (ch === open) depth += 1;
		if (ch === close) {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function previousObjectStart(text, index) {
	for (let i = index; i >= 0; i -= 1) {
		if (text[i] === "{") return i;
	}
	return -1;
}

function stringProp(block, prop) {
	const re = new RegExp(`\\b${prop}\\s*:\\s*([\"\`])([\\s\\S]*?)\\1`);
	const match = block.match(re);
	return match ? match[2].replace(/\\`/g, "`").replace(/\\"/g, '"') : "";
}

function extractActionDescription(block) {
	return stringProp(block, "actionDescription");
}

function sharedTabScopedParamKeys(objectText) {
	const keys = [...SHARED_TOOL_PARAMS];
	const removeKey = (key) => {
		const index = keys.indexOf(key);
		if (index >= 0) keys.splice(index, 1);
	};
	if (/includeTabId\s*:\s*false/.test(objectText)) {
		removeKey("tabId");
		removeKey("target");
	}
	if (/includeTarget\s*:\s*false/.test(objectText)) removeKey("target");
	if (/includeDetailLevel\s*:\s*false/.test(objectText)) removeKey("detailLevel");
	if (/includeOutputPath\s*:\s*false/.test(objectText)) removeKey("outputPath");
	if (/includeTimeout\s*:\s*false/.test(objectText)) removeKey("timeoutMs");
	if (/includeMaxChars\s*:\s*false/.test(objectText)) removeKey("maxChars");
	return keys;
}

function topLevelKeys(objectText) {
	const keys = [];
	let depthParen = 0;
	let depthBrace = 0;
	let depthBracket = 0;
	let quote = "";
	let escaped = false;
	for (let i = 0; i < objectText.length; i += 1) {
		const ch = objectText[i];
		if (quote) {
			if (escaped) { escaped = false; continue; }
			if (ch === "\\") { escaped = true; continue; }
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
		if (ch === "(") depthParen += 1;
		else if (ch === ")") depthParen -= 1;
		else if (ch === "{") depthBrace += 1;
		else if (ch === "}") depthBrace -= 1;
		else if (ch === "[") depthBracket += 1;
		else if (ch === "]") depthBracket -= 1;
		if (depthParen !== 0 || depthBrace !== 0 || depthBracket !== 0 || !isIdentStart(ch)) continue;
		const rest = objectText.slice(i);
		const match = /^([A-Za-z_$][\w$]*)\s*:/.exec(rest);
		if (!match) continue;
		keys.push(match[1]);
		i += match[0].length - 1;
	}
	return keys;
}

function parameterKeys(block, file) {
	const paramsIndex = block.indexOf("parameters:");
	if (paramsIndex >= 0) {
		const objectCall = block.indexOf("Type.Object", paramsIndex);
		const objectStart = block.indexOf("{", objectCall);
		const objectEnd = objectStart >= 0 ? findMatching(block, objectStart) : -1;
		if (objectEnd > objectStart) {
			const objectText = block.slice(objectStart + 1, objectEnd);
			const keys = topLevelKeys(objectText).filter((key) => key !== "description");
			let merged = keys;
			if (objectText.includes("sharedWebSecurityParams()")) merged = [...SHARED_WEB_SECURITY_PARAMS, ...merged];
			if (objectText.includes("sharedWebSecurityBrowserSessionParams(")) merged = [...SHARED_TOOL_PARAMS, ...merged];
			if (objectText.includes("sharedWebSecurityResultParams()")) merged = [...sharedTabScopedParamKeys("includeTabId:false,includeTimeout:false"), ...merged];
			if (objectText.includes("sharedTransferParams()")) merged = [...SHARED_TRANSFER_PARAMS, ...merged];
			if (objectText.includes("sharedTabScopedToolParams(")) merged = [...sharedTabScopedParamKeys(objectText), ...merged];
			return Array.from(new Set(merged)).sort();
		}
	}
	if (file.endsWith("registerNativeActionTools.ts")) {
		const keys = [...NATIVE_ACTION_PARAMS];
		if (block.includes("sessionIdDescription")) keys.splice(3, 0, "sessionId");
		return keys;
	}
	return [];
}

function artifactInfo(block, file) {
	const supportsOutputPath = block.includes("outputPath")
		|| block.includes("OUTPUT_PATH_DESCRIPTION")
		|| block.includes("sharedTransferParams()")
		|| block.includes("sharedWebSecurityParams()")
		|| block.includes("sharedWebSecurityBrowserSessionParams(")
		|| block.includes("sharedWebSecurityResultParams()")
		|| block.includes("sharedTabScopedToolParams(");
	const fallbackName = block.match(/fallbackName\s*:\s*`([^`]+)`/)?.[1]
		|| block.match(/fallbackName\s*:\s*"([^"]+)"/)?.[1]
		|| block.match(/fallbackName\s*:\s*artifactFallbackName\(\s*"([^"]+)"/)?.[1]
		|| block.match(/artifactPrefix\s*:\s*"([^"]+)"/)?.[1]
		|| block.match(/fallbackPrefix\s*:\s*"([^"]+)"/)?.[1]
		|| "";
	const mode = supportsOutputPath || block.includes("artifactPrefix") ? "outputPath/artifact" : "inline-only";
	return fallbackName ? `${mode}; ${fallbackName.replace(/\$\{Date\.now\(\)\}/g, "<ts>").replace(/^(?!.*<ts>)(.+)$/, "$1-<ts>.json")}` : mode;
}

function extractToolsFromSource(file, text) {
	const tools = [];
	const seenAt = new Set();
	for (const match of text.matchAll(/\bname\s*:\s*"(browser_[^"]+)"/g)) {
		if (seenAt.has(match.index)) continue;
		seenAt.add(match.index);
		const start = previousObjectStart(text, match.index);
		const end = start >= 0 ? findMatching(text, start) : -1;
		if (start < 0 || end < start) continue;
		const block = text.slice(start, end + 1);
		const name = match[1];
		tools.push({
			name,
			label: stringProp(block, "label"),
			description: stringProp(block, "description"),
			promptSnippet: stringProp(block, "promptSnippet"),
			parameters: parameterKeys(block, file),
			actions: extractActionDescription(block),
			artifact: artifactInfo(block, file),
			file,
		});
	}
	return tools;
}

async function collectTools() {
	const files = await walk("src/tools", (rel) => rel.endsWith(".ts"));
	const all = [];
	for (const file of files) {
		if (file.includes("/summaries/") || file.includes("/browserNative/") || file.includes("/bridges/") || file.includes("/shared/")) continue;
		all.push(...extractToolsFromSource(file, await read(file)));
	}
	const byName = new Map();
	for (const tool of all) byName.set(tool.name, tool);
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function commandRequired(spec) {
	const fields = [];
	if (Array.isArray(spec.required)) fields.push(...spec.required);
	if (Array.isArray(spec.requiredAny)) fields.push(...spec.requiredAny.map((group) => `[${group.join("+")}]`));
	if (spec.methodSpecs) {
		for (const [method, methodSpec] of Object.entries(spec.methodSpecs)) {
			const methodFields = [];
			if (Array.isArray(methodSpec.required)) methodFields.push(...methodSpec.required);
			if (Array.isArray(methodSpec.requiredAny)) methodFields.push(...methodSpec.requiredAny.map((group) => `[${group.join("+")}]`));
			if (methodFields.length) fields.push(`${method}:${methodFields.join(",")}`);
		}
	}
	return fields.join(", ");
}

function collectNativeCommands(schema) {
	return Object.entries(schema.commands)
		.map(([name, spec]) => ({
			name,
			domain: spec.domain || "",
			tabScoped: spec.tabScoped === true ? "yes" : "no",
			methods: Array.isArray(spec.methods) ? spec.methods.join(", ") : "",
			required: commandRequired(spec),
			canonical: spec.canonical || schema.aliases?.[name] || "",
		}))
		.sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));
}

async function collectErrorCodes() {
	const files = [
		...await walk("src", (rel) => /\.(ts|mjs|js)$/.test(rel)),
		...await walk("bridge_src", (rel) => /\.(ts|mjs|js)$/.test(rel)),
	];
	const codes = new Map();
	const patterns = [
		/(?:BrowserBridgeError|tabsToolError|codedTransferError|ArtifactReaderError|piCdpError)\(\s*["']([A-Z][A-Z0-9_]{2,})["']/g,
		/\berror_code\s*:\s*"([A-Z][A-Z0-9_]{2,})"/g,
		/\bcode\s*:\s*"([A-Z][A-Z0-9_]{2,})"/g,
		/\.code\s*=\s*["']([A-Z][A-Z0-9_]{2,})["']/g,
	];
	for (const file of files) {
		const text = await read(file);
		for (const re of patterns) {
			for (const match of text.matchAll(re)) {
				if (!codes.has(match[1])) codes.set(match[1], new Set());
				codes.get(match[1]).add(file);
			}
		}
	}
	return [...codes.entries()].map(([code, sources]) => ({ code, sources: [...sources].sort() })).sort((a, b) => a.code.localeCompare(b.code));
}

function taxonomyDomain(code, category) {
	if (code === "INVALID_BROWSER_COMMAND") return "protocol";
	if (category?.startsWith("driver.")) return "driver";
	if (category === "tool.transfer" || category === "runtime.transfer") return "transfer";
	if (category === "tool.artifact") return "artifact";
	if (category === "tool.security") return "security";
	if (category === "runtime.network") return "network";
	if (category === "runtime.cdp") return "cdp";
	if (["runtime.page", "runtime.selector", "runtime.frame", "runtime.tab"].includes(category)) return "page";
	if (category?.startsWith("tool.")) return "tool";
	if (category?.startsWith("runtime.")) return "native";
	if (code.startsWith("ARTIFACT_")) return "artifact";
	if (code === "INVALID_TIMEOUT") return "tool";
	if (code.includes("CDP") || ["NO_TAB_ID", "SESSION_LIMIT", "ATTACH_FAILED", "DETACH_FAILED", "SEND_FAILED", "FRAME_EVAL_FAILED", "NO_METHOD", "FRAME_NOT_FOUND", "NO_SOURCE", "NO_IDENTIFIER", "SCRIPT_NOT_FOUND", "UNKNOWN_ACTION"].includes(code)) return "cdp";
	if (["ELEMENT_INDEX_OUT_OF_RANGE", "ELEMENT_NOT_CLICKABLE", "MEDIA_URL_NOT_FOUND"].includes(code)) return "page";
	return "unknown";
}

function taxonomyForCode(code, schema) {
	const entry = schema.errorCodes?.[code];
	if (entry) {
		return {
			code,
			domain: taxonomyDomain(code, entry.category || "runtime.internal"),
			category: entry.category || "runtime.internal",
			retryable: entry.retryable === true ? "yes" : "no",
			source: "schema",
		};
	}
	return {
		code,
		domain: taxonomyDomain(code, ""),
		category: code.startsWith("ARTIFACT_") ? "tool.artifact" : code === "INVALID_TIMEOUT" ? "tool.validation" : taxonomyDomain(code, "") === "cdp" ? "runtime.cdp" : taxonomyDomain(code, "") === "page" ? "runtime.page" : "unknown",
		retryable: /TIMEOUT|FAILED|DETACH|ATTACH|SEND/.test(code) ? "yes" : "no",
		source: "heuristic",
	};
}

function collectErrorTaxonomy(schema, errorCodes) {
	const local = new Map(errorCodes.map((item) => [item.code, item.sources]));
	const codes = new Set([...Object.keys(schema.errorCodes || {}), ...local.keys()]);
	return [...codes].sort().map((code) => ({ ...taxonomyForCode(code, schema), sources: local.get(code) || [] }));
}

function renderTable(headers, rows) {
	return [
		`| ${headers.join(" | ")} |`,
		`| ${headers.map(() => "---").join(" | ")} |`,
		...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
	].join("\n");
}

async function generate() {
	const schema = JSON.parse(await read("bridge/native_command_schema.json"));
	const tools = await collectTools();
	const nativeCommands = collectNativeCommands(schema);
	const errorCodes = await collectErrorCodes();
	const errorTaxonomy = collectErrorTaxonomy(schema, errorCodes);
	return `# Browser Tool Contract (Generated)\n\n` +
		`Generated by \`scripts/generate-tool-docs.mjs\`. Do not edit by hand.\n\n` +
		`## Source summary\n\n` +
		`- Tool metadata source: \`src/tools/**/register*.ts\` actual \`pi.registerTool\` metadata/config objects.\n` +
		`- Native command source: \`bridge/native_command_schema.json\` (${schema.name} ${schema.version}).\n` +
		`- Error taxonomy source: \`bridge/native_command_schema.json\` plus local \`src/**\` and \`bridge_src/**\` structured error declarations.\n\n` +
		`## Callable browser tools\n\n` +
		renderTable(["Tool", "Label", "Parameters", "Actions / command surface", "Artifact behavior", "Source"], tools.map((tool) => [
			`\`${tool.name}\``,
			tool.label,
			tool.parameters.map((item) => `\`${item}\``).join(", "),
			tool.actions || tool.promptSnippet || tool.description,
			tool.artifact,
			`\`${tool.file}\``,
		])) +
		`\n\n## Native bridge commands\n\n` +
		renderTable(["Command", "Domain", "Tab scoped", "Methods", "Required / method-required", "Canonical"], nativeCommands.map((command) => [
			`\`${command.name}\``, command.domain, command.tabScoped, command.methods, command.required, command.canonical,
		])) +
		`\n\n## Structured error taxonomy\n\n` +
		`Generated taxonomy keeps public error codes stable and adds compact \`taxonomy\` / \`diagnostics\` fields to Node-side normalized error output.\n\n` +
		renderTable(["Code", "Domain", "Category", "Retryable", "Source", "Local sources"], errorTaxonomy.map((item) => [
			`\`${item.code}\``,
			item.domain,
			item.category,
			item.retryable,
			item.source,
			item.sources.map((src) => `\`${src}\``).join(", "),
		])) +
		`\n\n## Artifact and privacy contract\n\n` +
		`- Tools exposing \`outputPath\` or result middleware preserve full evidence in local artifacts while summaries stay compact.\n` +
		`- Saved artifacts are classified as local raw evidence under \`.pi/browser-artifacts/\`; cleanup is manual and local-only.\n` +
		`- \`browser_artifact\` redacts cookie/token/authorization/body/postData/websocket payload values by default; \`redact:false\` is an explicit local raw-evidence read.\n` +
		`- WebSecurity tools use bounded local artifacts and shared distillation helpers; raw evidence stays local.\n` +
		`- Lifecycle fixture failure evidence is written to \`.pi/browser-artifacts/lifecycle-fixture-failure.json\` with cookie/token/authorization/body/postData-style fields redacted by key.\n`;
}

const output = await generate();
if (checkOnly) {
	if (!existsSync(outFile)) {
		console.error(`generated docs missing: ${path.relative(root, outFile)}`);
		process.exit(1);
	}
	const current = await readFile(outFile, "utf8");
	if (current !== output) {
		console.error(`generated docs are stale: run npm run docs:generate`);
		process.exit(1);
	}
	console.log("generated tool docs contract ok");
} else {
	await mkdir(path.dirname(outFile), { recursive: true });
	await writeFile(outFile, output, "utf8");
	console.log(JSON.stringify({ ok: true, file: path.relative(root, outFile) }, null, 2));
}
