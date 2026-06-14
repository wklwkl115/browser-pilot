import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectTools } from "./generate-tool-docs.mjs";
import { managedBlockContent, preserveMarkdownTableCells, renderManagedBlock, renderMarkdownTable, replaceManagedBlock } from "./lib/managed-blocks.mjs";
import { inputMatchesChangedFile, normalizeRel, walkFiles } from "./lib/repo-introspection.mjs";
import { BARREL, PURE_CORE, PURE_CROSSCUTTING, RUNTIME } from "../tests/contracts/drift/abml-core-manifest.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

function read(rel) {
	return readFileSync(path.join(root, rel), "utf8");
}

function writeOrCheck(rel, next) {
	const target = path.join(root, rel);
	const current = readFileSync(target, "utf8");
	if (current === next) return;
	if (checkOnly) {
		throw new Error(`${rel} managed blocks are stale; run npm run docs:sync`);
	}
	writeFileSync(target, next, "utf8");
}

function parseSections(text, prefix) {
	const sections = [];
	let name = null;
	let buf = [];
	for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
		if (line.startsWith(prefix) && !line.startsWith(`${prefix}#`)) {
			if (name !== null) sections.push({ name, body: buf.join("\n").trim() });
			name = line.slice(prefix.length).trim();
			buf = [];
		} else if (name !== null) {
			buf.push(line);
		}
	}
	if (name !== null) sections.push({ name, body: buf.join("\n").trim() });
	return sections;
}

function escapeCell(value) {
	return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function isSourceFile(rel) {
	return /\.(?:ts|tsx|js|mjs|json|md|html|css)$/i.test(rel);
}

function fileLineCount(rel) {
	const text = read(rel);
	return text.length === 0 ? 0 : text.split(/\r?\n/).length;
}

function directoryStats(rel) {
	const files = walkFiles(rel, isSourceFile, root);
	return {
		files: files.length,
		lines: files.reduce((sum, file) => sum + fileLineCount(file), 0),
	};
}

function ensureManagedBlock(text, id, content, insert) {
	if (managedBlockContent(text, id)) return replaceManagedBlock(text, id, content);
	return insert(text, renderManagedBlock(id, content));
}

function assertNoEmptyCells(rows, keyIndex, valueIndex, label) {
	if (!checkOnly) return;
	const missing = rows
		.filter((row) => !String(row[valueIndex] || "").trim())
		.map((row) => row[keyIndex]);
	if (missing.length) throw new Error(`${label} missing hand judgment cell(s): ${missing.join(", ")}`);
}

function renderClaudeAgentsBlock() {
	const sections = parseSections(read("AGENTS.md"), "## ");
	const kept = ["Change Workflow", "Sync & Verification", "Code Search"];
	const filtered = sections.filter((section) => kept.includes(section.name));
	const ref = "> Full design principles, tool constitution, and architecture rules: see `AGENTS.md`. Only actionable workflow rules are inlined below.";
	return `${ref}\n\n${filtered.map((section) => `### ${section.name}\n\n${section.body}`).join("\n\n")}`;
}

function syncClaude() {
	const rel = "CLAUDE.md";
	const text = read(rel);
	const marker = "## Design, Governance & Workflow Rules (inlined from AGENTS.md)";
	const idx = text.indexOf(marker);
	if (idx < 0) throw new Error("CLAUDE.md missing AGENTS inline marker");
	const before = text.slice(0, idx + marker.length);
	const block = renderManagedBlock("claude-agents-inline", renderClaudeAgentsBlock());
	const next = `${before}\n\n${block}\n`;
	writeOrCheck(rel, next);
}

function renderToolIndex(tools) {
	const rows = tools.map((tool) => {
		const group = ["browser_crawl", "browser_fuzz", "browser_sqli", "browser_template", "browser_callback_oast", "browser_cookie_analyze", "browser_http_replay"].includes(tool.name) ? "security" : "core";
		return [`\`${escapeCell(tool.name)}\``, group, `\`${escapeCell(tool.file)}\``];
	});
	return renderMarkdownTable(["Tool", "Group", "Source"], rows);
}

async function syncReadme() {
	const rel = "README.md";
	let text = read(rel);
	const tools = await collectTools();
	const content = renderToolIndex(tools);
	if (managedBlockContent(text, "readme-tool-index")) {
		text = replaceManagedBlock(text, "readme-tool-index", content);
	} else {
		const heading = "## 工具清单";
		const idx = text.indexOf(heading);
		if (idx < 0) throw new Error("README.md missing tool list heading");
		const insertAt = text.indexOf("\n", idx + heading.length);
		text = `${text.slice(0, insertAt + 1)}\n${renderManagedBlock("readme-tool-index", content)}\n\n${text.slice(insertAt + 1)}`;
	}
	writeOrCheck(rel, text);
}

const ABML_ROLE_BY_FILE = Object.freeze({
	"types.ts": "Foundational types (locators, refs, actionability, errors, captures). No imports.",
	"refId.ts": "Pure pi-ref URI minting and summary placeholder ref IDs.",
	"refPolicy.ts": "Ref-access policy per kind (`defaultRefPolicyForKind`, `decideRefAccess`).",
	"actionabilityModel.ts": "Verb-to-actionability spec mapping; action-verb classification.",
	"entity.ts": "`Entity`/`EntityState`/`EntityStructure`/`EntityRelation` model plus builders.",
	"ax.ts": "DOM/AX merge core, AX-authoritative state/structure fusion, relation-anchor extraction.",
	"relations.ts": "ABML relationship graph materialization, dedupe, cap, and envelope relation summary.",
	"inference.ts": "ARIA pattern detection plus temporal form dependency over entities and relation summaries.",
	"diff.ts": "Temporal entity diff: appeared, disappeared, state/name changes, focused ref.",
	"stream.ts": "Capture-ref, network-entry, and event entity shaping.",
	"causal.ts": "Passive network-delta causal plane summary.",
	"grouping.ts": "ARIA-grounded grouping, descriptor derivation, scope helpers, display text normalization.",
	"identityBootstrap.ts": "Best-effort scan rect to DOMSnapshot backendNodeId bootstrap with fail-open diagnostics.",
	"nodeKey.ts": "Target-scoped backendNodeId key formatting plus legacy backend key compatibility.",
	"templating.ts": "Repeated sibling structure templating and compact instance handles.",
	"treeDiff.ts": "Template-level living diff over repeated structures.",
	"semanticRefAnchor.ts": "Pure semantic ref-anchor candidate and shadow-hash derivation.",
	"snapshotProjection.ts": "Living snapshot projection and attached template deltas.",
	"collections.ts": "Collection completeness and read-only continuation evidence for long, virtualized, lazy, and paginated structures.",
	"identityGraph.ts": "Pure semantic identity graph used to stabilize entity identity across observations.",
	"errors.ts": "`normalizeAbmlError` plus recovery shaping.",
	"verbs/router.ts": "Verb dispatch types and actionability/verification failure builders.",
	"verbs/click.ts": "Click verb decision logic.",
	"verbs/type.ts": "Type verb decision logic.",
	"verbs/scroll.ts": "Scroll verb decision logic.",
	"verbs/read.ts": "Read verb decision logic.",
	"verbs/frame.ts": "Frame verb decision logic.",
	"verbs/pierce.ts": "Pierce verb decision logic.",
});

const ABML_RUNTIME_REASON_BY_FILE = Object.freeze({
	"perceptionLedger.ts": "Live per-session perception ledger, render cache, and trace state.",
	"verbs/runtime.ts": "Orchestrator that reaches driver, scan, tools, resources, and live browser state.",
	"verbs/axRuntime.ts": "Driver/tool validation/resource integration for AX runtime work.",
	"verbs/frameRuntime.ts": "Driver/tool validation/resource integration for frame runtime work.",
	"verbs/pierceRuntime.ts": "Driver/tool validation/resource integration for pierce runtime work.",
	"verbs/visionRuntime.ts": "Node filesystem/path plus driver/resource integration for vision captures.",
	"verbs/integration.ts": "Driver-facing `createBrowserAbmlRuntime` wiring.",
});

const ABML_CROSSCUTTING_CLOSURE_BY_MODULE = Object.freeze({
	"utils/records": "(no imports)",
	"utils/errors": "-> `protocol/nativeErrorCodes`, `utils/records`, `utils/redaction`",
	"utils/redaction": "-> `utils/json`",
	"utils/json": "(no imports)",
	"protocol/nativeErrorCodes": "(no imports, generated)",
});

function renderAbmlTable(headers, rows, existing, preserveColumns = []) {
	const preserved = preserveMarkdownTableCells(existing, rows, { keyColumn: 0, preserveColumns });
	return renderMarkdownTable(headers, preserved);
}

function renderAbmlPureCore(existing) {
	const rows = PURE_CORE.map((file) => [`\`${escapeCell(file)}\``, escapeCell(ABML_ROLE_BY_FILE[file] || "")]);
	return renderAbmlTable(["File", "Role"], rows, existing, [1]);
}

function renderAbmlRuntime(existing) {
	const rows = RUNTIME.map((file) => [`\`${escapeCell(file)}\``, escapeCell(ABML_RUNTIME_REASON_BY_FILE[file] || "")]);
	return renderAbmlTable(["File", "Why runtime"], rows, existing, [1]);
}

function renderAbmlCrosscutting(existing) {
	const rows = PURE_CROSSCUTTING.map((module) => [`\`${escapeCell(module)}\``, escapeCell(ABML_CROSSCUTTING_CLOSURE_BY_MODULE[module] || "")]);
	return renderAbmlTable(["Module", "Closure"], rows, existing, [1]);
}

function syncAbmlKernelManifest() {
	const rel = "docs/abml-kernel-manifest.md";
	let text = read(rel);
	text = text.replace(/\*\*\d+ modules \+ an `index\.ts` barrel\.\*\*/, `**${PURE_CORE.length} modules + an \`${BARREL}\` barrel.**`);
	text = text.replace(/\*\*\d+ files\.\*\*/, `**${RUNTIME.length} files.**`);
	text = text.replace(/`src\/abml\/` also keeps \*\*\d+ thin re-export shims\*\*[\s\S]*?keeps its import path unchanged\./, `\`src/abml/\` also keeps **${PURE_CORE.length} thin re-export shims** at the old pure-core paths, so existing importers such as \`src/resources/resourceStore.ts\`, \`src/tools/summaries/scan.ts\`, \`src/tools/observeRunners.ts\`, the runtime verbs, and unit tests keep their import paths unchanged.`);
	text = text.replace(/The test holds the same lists below as the\s+machine-readable manifest; \*\*keep the two in sync\*\* — if they diverge, or a new file is added to/, "The tables below are generated from the same machine-readable manifest used by the test. If a new file is added to");
	text = text.replace(/## Pure core \([^)]*\)/, `## Pure core (${PURE_CORE.length} — zero browser/Node deps)`);
	text = text.replace(/## Runtime \([^)]*\)/, `## Runtime (${RUNTIME.length} — talk to the live browser)`);
	text = text.replace(/## Whitelisted cross-cutting modules \([^)]*\)/, `## Whitelisted cross-cutting modules (${PURE_CROSSCUTTING.length} — a pure-core file MAY import these)`);
	text = ensureManagedBlock(text, "abml-pure-core-manifest", renderAbmlPureCore(managedBlockContent(text, "abml-pure-core-manifest")), (current, block) => {
		const section = /## Pure core \([^)]*\)\n\n[\s\S]*?(?=\n## Runtime \()/;
		return current.replace(section, (match) => `${match.split(/\n\n/)[0]}\n\n${block}\n`);
	});
	text = ensureManagedBlock(text, "abml-runtime-manifest", renderAbmlRuntime(managedBlockContent(text, "abml-runtime-manifest")), (current, block) => {
		const section = /## Runtime \([^)]*\)\n\n[\s\S]*?(?=\n## Whitelisted cross-cutting modules \()/;
		return current.replace(section, (match) => `${match.split(/\n\n/)[0]}\n\n${block}\n`);
	});
	text = ensureManagedBlock(text, "abml-crosscutting-manifest", renderAbmlCrosscutting(managedBlockContent(text, "abml-crosscutting-manifest")), (current, block) => {
		const section = /## Whitelisted cross-cutting modules \([^)]*\)\n\n[\s\S]*?(?=\n## Kernel entry point)/;
		return current.replace(section, (match) => `${match.split(/\n\n/)[0]}\n\nEach has been verified **transitively pure** — its own dependency closure reaches no \`driver/tools/scan/resources/node\`. Adding to this whitelist requires re-verifying that closure; otherwise move the would-be consumer to RUNTIME instead.\n\n${block}\n`);
	});
	if (!text.includes("docs/abml-optimization-reference.md")) {
		text = text.replace("| [`docs/archive/abml-execution-plan.md`](archive/abml-execution-plan.md) | Historical execution contract (no longer the active queue — see `CURRENT.md` / `TODO.md`) | you want the historical phase log / file mapping |", "| [`docs/archive/abml-execution-plan.md`](archive/abml-execution-plan.md) | Historical execution contract (no longer the active queue — see `CURRENT.md` / `TODO.md`) | you want the historical phase log / file mapping |\n| [`docs/abml-optimization-reference.md`](abml-optimization-reference.md) | Optimization reference for ABML cost/precision tradeoffs | you are changing perception budgets, summaries, or optimization heuristics |");
	}
	writeOrCheck(rel, text);
}

const DIRECTORY_ADVICE = Object.freeze({
	"src/abml": "Runtime ABML integration and compatibility shims; kernel renames must co-change `src/abml-core/index.ts` and `tests/contracts/drift/kernel-export-inventory.json`.",
	"src/abml-core": "Pure ABML kernel; keep browser/Node deps out and verify `check:abml-core-boundary` plus targeted ABML contracts.",
	"src/capture": "Committed capture bundles and injection helpers; edit `capture-src/entries/*` first, then run `npm run sync:capture` and `check:capture`.",
	"src/content": "Content extraction runtime; pair with capture/page-script gates when touching page-world behavior.",
	"src/distill-core": "Pure distill kernel for salience, budgets, recovery, and token economy; verify distill and token gates.",
	"src/temporal-core": "Pure temporal control kernel for freshness, state-loss, budget, and sync planning; keep driver/browser/Node deps out and verify `check:temporal-core-boundary` plus temporal unit tests.",
	"src/driver": "Bridge server runtime; start at `BrowserBridgeServer.ts` facade, then the specific session/lease/wait/diagnostic module.",
	"src/frontend": "Harness-facing validation and usage logging; preserve redaction and CLI/Pi parity contracts.",
	"src/memory": "Runtime memory persistence and HMAC/profile services; keep local-only storage boundaries explicit.",
	"src/memory-core": "Pure memory kernel; keep host I/O out and verify memory-core boundary.",
	"src/pick": "Content-pick page helpers; verify content-pick/page-script checks.",
	"src/protocol": "Generated native protocol mirror; edit `bridge/native_command_schema.json` and run `npm run sync:protocol`.",
	"src/resources": "Artifact/resource store; verify artifact and summary consumers after schema changes.",
	"src/scan": "Scan page-world builder compatibility layer; source templates live in `capture-src/entries/*`.",
	"src/tools": "Callable tool surface; read `toolRegistry.ts`, registrar, `toolAdapter.ts`, `resultMiddleware.ts`, and summaries together.",
	"src/types": "Shared type declarations; check type and package surfaces.",
	"src/utils": "Shared utilities; pure-kernel imports must stay within whitelisted cross-cutting modules.",
	"src/validation": "Frontend/tool validation; preserve strict schema and CLI/Pi parity behavior.",
	"cli": "External `browser-pilot` CLI face; keep command metadata, flags, local commands, and daemon validation in sync.",
	"bridge_src": "MV3 extension source; run `build:bridge` before bridge/runtime checks.",
	"capture-src": "Editable page-world capture templates; generated bundles are under `src/capture/generated/`.",
});

function codeDirectories() {
	const srcEntries = readdirSync(path.join(root, "src"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => `src/${entry.name}`);
	return [...srcEntries, "cli", "bridge_src", "capture-src"].filter((rel) => existsSync(path.join(root, rel))).sort();
}

function detectedSeams(rel) {
	const seams = [];
	if (rel === "src/tools") seams.push("toolRegistry/registerTools", "toolAdapter/resultMiddleware", "observe", "webSecurity", "summaries");
	else if (rel === "src/driver") seams.push("server facade", "client registry", "tab/session router", "lease/queue", "wait/diagnostics");
	else if (rel === "src/abml") seams.push("runtime verbs", "pure-core shims", "perception ledger");
	else if (rel === "src/abml-core") seams.push("pure kernel", "barrel", "verb decisions");
	else if (rel === "bridge_src") seams.push("service worker", "offscreen transport", "page scripts", "protocol copy");
	else if (rel === "capture-src") seams.push("editable templates", "sync:capture source");
	else if (rel === "cli") seams.push("flags", "local commands", "daemon", "JSON envelopes");
	else {
		const files = walkFiles(rel, isSourceFile, root);
		if (files.some((file) => /index\.(?:ts|js|mjs)$/.test(file))) seams.push("index/barrel");
		if (files.some((file) => file.includes("generated/"))) seams.push("generated output");
		if (files.some((file) => /test|fixture/i.test(file))) seams.push("fixture/test helpers");
	}
	return seams.length ? seams.join(", ") : "leaf module group";
}

function renderMaintainerInventory(existing) {
	const rows = codeDirectories().map((rel) => {
		const stats = directoryStats(rel);
		return [`\`${rel}\``, String(stats.files), String(stats.lines), escapeCell(detectedSeams(rel)), escapeCell(DIRECTORY_ADVICE[rel] || "")];
	});
	const preserved = preserveMarkdownTableCells(existing, rows, { keyColumn: 0, preserveColumns: [4] });
	assertNoEmptyCells(preserved, 0, 4, "docs/maintainer-map.md layer inventory");
	return renderMarkdownTable(["Directory", "Files", "Lines", "Detected seams", "Change-landing advice"], preserved);
}

function syncMaintainerMap() {
	const rel = "docs/maintainer-map.md";
	let text = read(rel);
	const content = renderMaintainerInventory(managedBlockContent(text, "maintainer-layer-inventory"));
	text = ensureManagedBlock(text, "maintainer-layer-inventory", content, (current, block) => {
		const heading = "## Layer Inventory";
		if (current.includes(heading)) return current.replace(`${heading}\n\n`, `${heading}\n\n${block}\n\n`);
		return current.replace("## 运行链路", `## Layer Inventory\n\n${block}\n\n## 运行链路`);
	});
	writeOrCheck(rel, text);
}

const PLAYBOOKS = Object.freeze([
	{
		id: "Envelope/summary field",
		files: ["src/tools/summaries/outputSchemas.ts", "src/tools/summaries/registerBuiltinDistillers.ts", "src/tools/summaries/", "src/tools/resultMiddleware.ts", "tests/contracts/tools/check-summaries.mjs"],
	},
	{
		id: "Native bridge command",
		files: ["bridge/native_command_schema.json", "scripts/sync-native-protocol.mjs", "tests/contracts/protocol/check-browser-pilot-bridge.mjs", "tests/contracts/protocol/check-bridge-build.mjs"],
	},
	{
		id: "Environment flag",
		files: ["tests/contracts/drift/check-env-flags.mjs", "src/tools/observe/renderCache.ts", "src/frontend/usageLog.ts", "src/driver/BrowserBridgeServer.ts"],
	},
	{
		id: "Recovery/error text",
		files: ["src/tools/resultMiddleware.ts", "src/utils/errors.ts", "tests/contracts/tools/check-errors.mjs", "tests/contracts/drift/check-recovery-boundary.mjs"],
	},
	{
		id: "Kernel export rename",
		files: ["src/abml-core/", "src/abml/", "src/abml-core/index.ts", "tests/contracts/drift/kernel-export-inventory.json", "tests/contracts/drift/check-surface-liveness.mjs"],
	},
	{
		id: "New tool",
		files: ["src/tools/toolRegistry.ts", "src/tools/registerTools.ts", "src/tools/registerNativeActionTools.ts", "src/tools/toolAdapter.ts", "docs/generated/browser-tool-contract.generated.md"],
	},
]);

function scriptsForFiles(files) {
	const impact = JSON.parse(read("tests/contracts/drift/check-impact-map.json"));
	const hits = new Set();
	for (const node of Object.values(impact.nodes || {})) {
		if (!node?.script) continue;
		for (const file of files) {
			if ((node.inputs || []).some((input) => inputMatchesChangedFile(input, file))) {
				hits.add(node.script);
				break;
			}
		}
	}
	return [...hits].sort();
}

function renderPlaybookGateTable() {
	const rows = PLAYBOOKS.map((playbook) => [
		escapeCell(playbook.id),
		playbook.files.map((file) => `\`${escapeCell(file)}\``).join("<br>"),
		scriptsForFiles(playbook.files).slice(0, 12).map((script) => `\`${escapeCell(script)}\``).join("<br>"),
	]);
	return renderMarkdownTable(["Playbook", "Listed files", "Impact-map checks"], rows);
}

function syncAgentDevelopment() {
	const rel = "docs/agent-development.md";
	let text = read(rel);
	const content = renderPlaybookGateTable();
	text = ensureManagedBlock(text, "change-path-playbook-gates", content, (current, block) => {
		const heading = "## Change-path Playbooks";
		if (current.includes(heading)) return current.replace(`${heading}\n\n`, `${heading}\n\n${block}\n\n`);
		return `${current.trimEnd()}\n\n${heading}\n\n${block}\n`;
	});
	writeOrCheck(rel, text);
}

try {
	syncClaude();
	await syncReadme();
	syncAbmlKernelManifest();
	syncMaintainerMap();
	syncAgentDevelopment();
	console.log(checkOnly ? "managed doc blocks ok" : "managed doc blocks synced");
} catch (error) {
	console.error(error.message);
	process.exit(1);
}
