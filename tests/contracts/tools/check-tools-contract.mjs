import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.isAbsolute(rel) ? rel : path.join(root, rel), "utf8");
const packageJson = JSON.parse(read("package.json"));

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function registeredToolNames(rel) {
	const names = new Set();
	function visitFile(fileRel) {
		const sourceText = read(fileRel);
		const sf = ts.createSourceFile(fileRel, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		function visit(node) {
			if (ts.isObjectLiteralExpression(node)) {
				const prop = node.properties.find((item) => ts.isPropertyAssignment(item) && ts.isIdentifier(item.name) && item.name.text === "name");
				if (prop && ts.isPropertyAssignment(prop) && ts.isStringLiteralLike(prop.initializer) && prop.initializer.text.startsWith("browser_")) names.add(prop.initializer.text);
			}
			ts.forEachChild(node, visit);
		}
		visit(sf);
	}
	function walkRel(dirRel) {
		const dir = path.join(root, dirRel);
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const child = path.join(dirRel, entry.name).replace(/\\/g, "/");
			if (entry.isDirectory()) walkRel(child);
			else if (entry.name.endsWith(".ts")) visitFile(child);
		}
	}
	walkRel(rel);
	return names;
}

const registerToolsSource = read("src/tools/registerTools.ts");
const toolRegistrySource = read("src/tools/toolRegistry.ts");
const toolAdapterSource = read("src/tools/toolAdapter.ts");
const observeToolSource = read("src/tools/registerObserveTool.ts");
const executeToolSource = read("src/tools/registerExecuteTool.ts");
const commandToolSource = read("src/tools/registerCommandTool.ts");
const nativeActionTools = read("src/tools/registerNativeActionTools.ts");
const transferTools = read("src/tools/registerTransferTools.ts");
const evidenceTool = read("src/tools/registerEvidenceTool.ts");
const webSecurityFacade = read("src/tools/registerWebSecurityTools.ts");
const webSecurityRegisterIndex = read("src/tools/webSecurity/register/index.ts");
const webSecurityShared = read("src/tools/webSecurity/register/shared.ts");
const readme = read("README.md");
const skill = read("skills/pi-browser-tools/SKILL.md");

assert(registerToolsSource.split(/\r?\n/).length <= 30, "registerTools.ts must stay a thin composition entrypoint");
assert(registerToolsSource.includes("resolveBrowserToolRegistrars") && registerToolsSource.includes("for (const registerTool of resolveBrowserToolRegistrars(options))"), "registerTools.ts must consume declarative tool registrars");
assert(toolRegistrySource.includes("CORE_BROWSER_TOOL_REGISTRARS") && toolRegistrySource.includes("WEB_SECURITY_TOOL_REGISTRARS") && toolRegistrySource.includes("resolveBrowserToolRegistrars"), "toolRegistry.ts must define declarative core/security registries and resolver");
assert(toolRegistrySource.includes("registerFuzzTool") && toolRegistrySource.includes("registerSqliTool") && toolRegistrySource.includes("registerTemplateTool") && toolRegistrySource.includes("registerCrawlTool"), "toolRegistry.ts must use merged WebSecurity registrars");
assert(toolRegistrySource.includes("options.securityToolsEnabled === false"), "toolRegistry must support explicit core/security capability profile gating");

assert(toolAdapterSource.includes("defineBrowserTool") && toolAdapterSource.includes("runBrowserTool") && toolAdapterSource.includes("runWebSecurityTool"), "toolAdapter.ts must expose unified registration/execution adapters");
assert(toolAdapterSource.includes("sharedTabScopedToolParams") && toolAdapterSource.includes("runTool") && toolAdapterSource.includes("jsonToolResult") && toolAdapterSource.includes("textToolResult"), "toolAdapter.ts must centralize shared params and result helpers");
assert(toolAdapterSource.includes("withTrackedOperation") && toolAdapterSource.includes("artifactFallbackName") && toolAdapterSource.includes("bridgeNestedErrorResult"), "toolAdapter.ts must centralize operation/artifact/error helpers");

const registeredTools = registeredToolNames("src/tools");
for (const name of [
	"browser_tabs", "browser_command", "browser_execute", "browser_observe", "browser_pick", "browser_download", "browser_upload", "browser_wait", "browser_network", "browser_hook", "browser_evidence", "browser_frame", "browser_screenshot", "browser_artifact", "browser_memory",
	"browser_crawl", "browser_fuzz", "browser_sqli", "browser_template", "browser_callback_oast", "browser_cookie_analyze", "browser_http_replay",
]) assert(registeredTools.has(name), `tool not registered: ${name}`);
for (const removed of ["browser_query", "browser_click", "browser_type", "browser_dom_snapshot", "browser_dom_click", "browser_dom_type", "browser_recon_probe", "browser_fuzz_paths", "browser_fuzz_vhosts", "browser_fuzz_params", "browser_sqli_probe", "browser_sqlmap_bridge", "browser_nuclei_bridge", "browser_template_check"]) {
	assert(!registeredTools.has(removed), `removed/merged tool must not be registered: ${removed}`);
}
for (const removedFile of ["src/tools/registerElementActionTools.ts", "src/tools/registerSemanticDomTools.ts", "src/actions/buildElementActionScript.ts", "src/dom/buildSemanticDomScript.ts"]) {
	assert(!existsSync(path.join(root, removedFile)), `removed split action source must not exist: ${removedFile}`);
}

assert(observeToolSource.includes('name: "browser_observe"') && observeToolSource.includes("normalizeObserveMode") && observeToolSource.includes("validateObserveParams"), "browser_observe must register one explicit-mode observation tool with mode validation");
assert(executeToolSource.includes("detectCommandLikeScript") && executeToolSource.includes("use browser_command for bridge commands"), "browser_execute must reject command-like JSON strings with a browser_command recovery hint");
assert(commandToolSource.includes('name: "browser_command"') && commandToolSource.includes('details: { mode: "command" }'), "browser_command must be the explicit command-only tool");
assert(nativeActionTools.includes("executeBrowserWaitWithSupervisor") && nativeActionTools.includes("allowZeroTimeout"), "native action tools must preserve durable wait supervision and immediate probes");
assert(transferTools.includes("confirm:true") && transferTools.includes("command.timeoutMs = timeoutMs"), "browser_upload/download must preserve explicit confirmation and command timeout injection");
assert(evidenceTool.includes("DEFAULT_OBSERVATION_TIMEOUT_MS") && evidenceTool.includes("withTrackedOperation"), "browser_evidence must keep longer observation timeout and tracked operations");

// Isolated/logged-out session: browser_tabs create gained an `incognito` option that opens a fresh
// incognito window (separate cookie jar) via the bridge, with an allowed-access recovery when the user
// hasn't enabled "Allow in incognito".
assert(read("src/tools/registerTabsTool.ts").includes("incognito: params.incognito === true"), "browser_tabs create must forward the incognito option to createTab");
// C2: browser_tabs must accept the universal output/control params (maxChars/detailLevel/redact/…) via
// the shared mixin like every other browser_* tool — real agents repeatedly passed maxChars/detailLevel
// and hit a hard "additional properties" reject. Guard against regressing back to a hand-rolled schema.
assert(read("src/tools/registerTabsTool.ts").includes("sharedTabScopedToolParams("), "browser_tabs must spread sharedTabScopedToolParams so it accepts the universal output params (maxChars/detailLevel/redact) — C2");
// H1 (same class as C2, real CTF session 2026-06-07): browser_artifact hand-rolls its schema and was
// missing `detailLevel`, so a {…,detailLevel:"summary"} call hard-rejected with "additional properties".
// It must accept detailLevel (as a no-op — output shape is set by mode) so the universal param agents
// pass everywhere does not error here.
assert(read("src/tools/registerArtifactTool.ts").includes("detailLevel:"), "browser_artifact must accept the universal detailLevel param (no-op) instead of hard-rejecting it — H1");
// C4: browser_memory was the last hand-rolled tool missing the universal output params; it must accept
// detailLevel/redact (no-op/threaded) so agents passing them everywhere don't hit a hard reject — this
// closes the C2/C3 class (every tool now accepts the universal output triad).
assert(read("src/tools/registerMemoryTool.ts").includes("detailLevel:") && read("src/tools/registerMemoryTool.ts").includes("redact:"), "browser_memory must accept the universal detailLevel/redact params instead of hard-rejecting them — C4");
// H2 (real CTF session 2026-06-07): action tools (wait/network/hook/frame) hard-rejected per-action
// keys placed at the TOP LEVEL (e.g. browser_wait {action:"navigate", url:"…"} -> "additional
// properties"). They must accept each action's required keys at top level (folded into params) while
// staying strict (unknown keys still rejected) — derived from the native metadata, not hand-listed.
assert(nativeActionTools.includes("actionPassthroughKeys(") && nativeActionTools.includes("body[k] = top"), "native action tools must fold top-level per-action keys into params (accept-natural-input) — H2");
assert(read("bridge_src/service_worker/core_commands.ts").includes("chrome.windows.create") && read("bridge_src/service_worker/core_commands.ts").includes("isAllowedIncognitoAccess"), "bridge tabs.create must open an incognito window and check isAllowedIncognitoAccess");

assert(String(packageJson.scripts?.["check:tools"] || "").includes("check-execute-tool.mjs"), "check:tools must run browser_execute monitor shape contract");
assert(String(packageJson.scripts?.["check:web-security"] || "").includes("check-web-security-tools.mjs"), "check:web-security must run the dedicated WebSecurity contract");

assert(webSecurityFacade.includes("registerFuzzTool") && webSecurityFacade.includes("registerSqliTool") && webSecurityFacade.includes("registerTemplateTool") && webSecurityFacade.includes("registerCrawlTool"), "registerWebSecurityTools.ts must export merged WebSecurity registrars");
assert(webSecurityRegisterIndex.includes("registerFuzzTool") && webSecurityRegisterIndex.includes("registerSqliTool") && webSecurityRegisterIndex.includes("registerTemplateTool") && webSecurityRegisterIndex.includes("registerCrawlTool"), "webSecurity/register/index.ts must export merged WebSecurity registrars");
assert(webSecurityShared.includes("runWebSecurityToolAdapter") && webSecurityShared.includes("createBrowserCookieProvider") && webSecurityShared.includes("executeWebSecurityToolShell = runWebSecurityTool"), "webSecurity shared shell must be a domain adapter over the unified tool adapter");
assert((webSecurityShared.match(/cmd: "cookies"/g) || []).length === 1, "browser-session cookie binding must remain centralized in one shared WebSecurity shell");

assert(readme.includes("browser_crawl") && readme.includes("browser_fuzz") && readme.includes("browser_sqli") && readme.includes("browser_template"), "README must document merged WebSecurity tools");
assert(readme.includes("runBrowserTool()") && readme.includes("runWebSecurityTool()"), "README must document unified adapter and WebSecurity domain adapter");
assert(skill.includes("browser_crawl {action:\"fingerprint\"}") && skill.includes("browser_fuzz {mode:\"path\"}") && skill.includes("browser_sqli") && skill.includes("browser_template"), "skill must document merged WebSecurity routes");
for (const removed of ["browser_recon_probe", "browser_fuzz_paths", "browser_fuzz_vhosts", "browser_fuzz_params", "browser_sqli_probe", "browser_sqlmap_bridge", "browser_nuclei_bridge", "browser_template_check"]) {
	assert(!skill.includes(removed), `skill must not document removed/merged WebSecurity tool: ${removed}`);
}

assert(read("src/tools/budgets.ts").includes("TOOL_RESULT_BUDGETS"), "tool result budgets must be table-driven");
for (const name of ["browser_crawl", "browser_fuzz", "browser_sqli", "browser_template", "browser_callback_oast", "browser_cookie_analyze", "browser_http_replay"]) {
	assert(read("src/tools/budgets.ts").includes(`${name}: 12_000`), `budget missing: ${name}`);
}
for (const removed of ["browser_recon_probe", "browser_fuzz_paths", "browser_fuzz_vhosts", "browser_fuzz_params", "browser_sqli_probe", "browser_sqlmap_bridge", "browser_nuclei_bridge", "browser_template_check"]) {
	assert(!read("src/tools/budgets.ts").includes(`${removed}:`), `removed/merged tool budget must not remain: ${removed}`);
}

console.log("tools contract ok");
