import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerBrowserCommands } from "../src/tools/commands.ts";
import { registerBrowserTools } from "../src/tools/registerTools.ts";
import { extractRelativeImports, normalizeRel, resolveRelativeImport, walkEsmImportGraph, walkFiles } from "./lib/repo-introspection.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outRel = "docs/generated/code-map.generated.md";
const outPath = path.join(root, outRel);
const checkOnly = process.argv.includes("--check");

function read(rel) {
	return readFileSync(path.join(root, rel), "utf8");
}

function lineCount(rel) {
	const text = read(rel);
	return text.length === 0 ? 0 : text.split(/\r?\n/).length;
}

function sourceFiles(rel) {
	return walkFiles(rel, (file) => /\.(?:ts|tsx|js|mjs|json|md|html|css)$/i.test(file), root);
}

function renderTable(headers, rows) {
	return [
		`| ${headers.join(" | ")} |`,
		`| ${headers.map(() => "---").join(" | ")} |`,
		...rows.map((row) => `| ${row.join(" | ")} |`),
	].join("\n");
}

function cell(value) {
	return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function codeDirs() {
	const srcDirs = readdirSync(path.join(root, "src"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => `src/${entry.name}`);
	return [...srcDirs, "cli", "bridge_src", "capture-src", "scripts"].filter((rel) => existsSync(path.join(root, rel))).sort();
}

function directoryInventory() {
	return codeDirs().map((rel) => {
		const files = sourceFiles(rel);
		return [`\`${rel}\``, String(files.length), String(files.reduce((sum, file) => sum + lineCount(file), 0))];
	});
}

function importFanIn() {
	const files = [
		...sourceFiles("src"),
		...sourceFiles("cli"),
		...sourceFiles("bridge_src"),
		...sourceFiles("scripts"),
	].filter((file) => /\.(?:ts|tsx|mjs|js)$/.test(file));
	const counts = new Map();
	for (const file of files) {
		const text = read(file);
		for (const spec of extractRelativeImports(text)) {
			const resolved = resolveRelativeImport(file, spec, root);
			if (!resolved) continue;
			if (!counts.has(resolved)) counts.set(resolved, new Set());
			counts.get(resolved).add(file);
		}
	}
	return [...counts.entries()]
		.map(([target, importers]) => ({ target, count: importers.size }))
		.sort((a, b) => b.count - a.count || a.target.localeCompare(b.target))
		.slice(0, 20)
		.map((item) => [`\`${item.target}\``, String(item.count)]);
}

const SOURCE_STACK_EXCLUDES = new Set([
	"src/tools/relevanceTraceAdapter.ts",
	"src/tools/toolAdapter.ts",
	"src/tools/registerTools.ts",
	"src/tools/toolRegistry.ts",
	"src/tools/distillerRegistry.ts",
]);

function sourceFromStack(stack) {
	const hits = [];
	for (const line of String(stack || "").split(/\r?\n/)) {
		const match = line.match(/(?:\(|\s)(file:\/\/\/[^)\s]+|[A-Za-z]:\\[^)\s]+|\/[^)\s]+):\d+:\d+\)?$/);
		if (!match) continue;
		const absolute = match[1].startsWith("file:") ? fileURLToPath(match[1]) : match[1];
		const rel = normalizeRel(path.relative(root, absolute));
		if (!rel.startsWith("src/tools/")) continue;
		if (SOURCE_STACK_EXCLUDES.has(rel)) continue;
		hits.push(rel);
	}
	return hits[0] || hits.find((rel) => rel.startsWith("src/tools/")) || "unknown";
}

function createRecordingAdapter(records) {
	return {
		registerTool(definition) {
			records.tools.push({ name: definition.name, source: sourceFromStack(new Error().stack) });
		},
		registerCommand(name, definition) {
			records.commands.push({ name, description: definition?.description || "", source: sourceFromStack(new Error().stack) });
		},
	};
}

function fakeBridge() {
	return {
		snapshot() { return { extensionConnected: false, tabs: [], pending: [] }; },
		async sendCommand() { return { ok: true }; },
		async waitForExtensionReconnect() { return this.snapshot(); },
	};
}

function collectRegisteredSurface() {
	const records = { tools: [], commands: [] };
	const pi = createRecordingAdapter(records);
	const bridge = fakeBridge();
	const ensureStarted = async () => bridge;
	registerBrowserTools(pi, bridge, ensureStarted);
	registerBrowserCommands(pi, bridge, ensureStarted);
	records.tools.sort((a, b) => a.name.localeCompare(b.name));
	records.commands.sort((a, b) => a.name.localeCompare(b.name));
	return records;
}

function chainForSource(source) {
	if (!source || source === "unknown") return "unknown";
	const graph = walkEsmImportGraph(source, { root });
	const files = graph.files.filter((file) => file !== source).slice(0, 4);
	return [`\`${source}\``, ...files.map((file) => `\`${file}\``)].join("<br>");
}

function surfaceRows(records) {
	return [
		...records.tools.map((item) => ["tool", `\`${cell(item.name)}\``, chainForSource(item.source)]),
		...records.commands.map((item) => ["command", `\`/${cell(item.name)}\``, chainForSource(item.source)]),
	];
}

function registriesRows() {
	return [
		["Tool registrar order", "`src/tools/toolRegistry.ts`", "`resolveBrowserToolRegistrars()`"],
		["Tool composition entry", "`src/tools/registerTools.ts`", "`registerBrowserTools()`"],
		["Slash-command namespace", "`src/tools/commands.ts`", "`registerBrowserCommands()`"],
		["Check graph", "`scripts/check-graph.mjs`", "`CHECK_GROUPS`"],
		["Kernel export inventory", "`tests/contracts/drift/kernel-export-inventory.json`", "`check:surface-liveness`"],
		["Impact map", "`tests/contracts/drift/check-impact-map.json`", "`sync:impact-map` / `check:impact-map`"],
	];
}

function generatedRows() {
	return [
		["`docs/generated/browser-tool-contract.generated.md`", "`src/tools/registerTools.ts`, `bridge/native_command_schema.json`", "`npm run docs:sync`", "`check:tool-docs`, `check:docs-sync`"],
		["`docs/generated/native-protocol.generated.md`", "`bridge/native_command_schema.json`", "`npm run sync:protocol`", "`check:protocol`"],
		["`docs/generated/code-map.generated.md`", "`src/`, `cli/`, `bridge_src/`, `scripts/`", "`npm run sync:code-map`", "`check:code-map`"],
		["`bridge/pi_browser_bridge/native_command_schema.json`", "`bridge/native_command_schema.json`", "`npm run sync:protocol`", "`check:protocol`"],
		["`bridge_src/service_worker/protocol.ts`", "`bridge/native_command_schema.json`", "`npm run sync:protocol`", "`check:protocol`"],
		["`src/protocol/nativeProtocol.ts`", "`bridge/native_command_schema.json`", "`npm run sync:protocol`", "`check:protocol`"],
		["`src/protocol/nativeActionMetadata.ts`", "`bridge/native_command_schema.json`", "`npm run sync:protocol`", "`check:protocol`"],
		["`src/protocol/nativeErrorCodes.ts`", "`bridge/native_command_schema.json`", "`npm run sync:protocol`", "`check:protocol`"],
		["`src/capture/generated/scanBundle.ts`", "`capture-src/entries/scanTemplate.ts`", "`npm run sync:capture`", "`check:capture`"],
		["`src/capture/generated/contentBundle.ts`", "`capture-src/entries/contentTemplate.ts`", "`npm run sync:capture`", "`check:capture`"],
		["`src/capture/generated/pickBundle.ts`", "`capture-src/entries/pickTemplate.ts`", "`npm run sync:capture`", "`check:capture`"],
		["`src/capture/generated/visionBundle.ts`", "`capture-src/entries/visionTemplate.ts`", "`npm run sync:capture`", "`check:capture`"],
	];
}

function renderCodeMap() {
	const records = collectRegisteredSurface();
	return `# Generated Code Map

> Generated by \`npm run sync:code-map\`. Do not edit by hand.

## Directory Inventory

${renderTable(["Directory", "Files", "Lines"], directoryInventory())}

## Top Fan-In Modules

${renderTable(["Module", "Importer count"], importFanIn())}

## Registered Tool And Command Surface

${renderTable(["Kind", "Name", "Source/import chain"], surfaceRows(records))}

## Registries As Indexes

${renderTable(["Index", "Source", "Read for"], registriesRows())}

## Generated Files

${renderTable(["Generated file", "Source of truth", "Sync command", "Guarding gate"], generatedRows())}
`;
}

const next = renderCodeMap();
if (checkOnly) {
	const current = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
	if (current !== next) {
		console.error(`${outRel} is stale; run npm run sync:code-map or npm run docs:sync`);
		process.exit(1);
	}
	console.log("code map ok");
} else {
	mkdirSync(path.dirname(outPath), { recursive: true });
	writeFileSync(outPath, next, "utf8");
	console.log(`code map synced: ${outRel}`);
}
