import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.isAbsolute(rel) ? rel : path.join(root, rel), "utf8");
function assert(condition, message) { if (!condition) throw new Error(message); }
function readToolSources() {
	return readdirSync(path.join(root, "src", "tools"))
		.filter((file) => file.endsWith(".ts"))
		.map((file) => read(path.join("src", "tools", file)))
		.join("\n");
}

const indexSource = read("index.ts");
assert(indexSource.includes("server.start().catch"), "extension startup must clear cached startPromise on start failure so later calls can retry");
assert(indexSource.includes("startPromise = undefined;\n\t\t\t\tthrow error;"), "extension startup retry path must reset and rethrow start errors");

const registerToolsSource = read("src/tools/registerTools.ts");
const toolSource = readToolSources();
assert(registerToolsSource.split(/\r?\n/).length <= 40, "registerTools.ts must stay a thin composition entrypoint");
assert(!registerToolsSource.includes("registerTool({"), "registerTools.ts must not directly register individual tools");
assert(!registerToolsSource.includes("waitCommandForAction"), "registerTools.ts must not own domain action mapping");
for (const name of ["browser_tabs", "browser_execute", "browser_scan", "browser_pick", "browser_content", "browser_query", "browser_click", "browser_type", "browser_dom_snapshot", "browser_dom_click", "browser_dom_type", "browser_download", "browser_upload", "browser_wait", "browser_network", "browser_hook", "browser_evidence", "browser_frame", "browser_html", "browser_screenshot", "browser_artifact"]) assert(toolSource.includes(`name: "${name}"`), `tool not registered: ${name}`);
assert(!toolSource.includes("PI_BROWSER_ENABLE_COMPAT_PRO"), "browser_pro compatibility gate must be removed");
assert(!toolSource.includes("name: \"browser_pro\""), "browser_pro tool must be removed");
assert(toolSource.includes("selectBrowser"), "browser selection action missing");
assert(toolSource.includes("For automation, call browser_tabs list or switch first"), "tab-scoped tools must warn agents to list/switch before automation");
assert(toolSource.includes("omitted tabId uses the mutable selected/active tab fallback"), "tabId fallback warning missing from tool prompts");
assert((toolSource.match(/TAB_SCOPED_TOOL_GUIDELINE/g) || []).length >= 6, "tab-scoped tools must reuse explicit tabId guidance");
assert((toolSource.match(/optionalTargetTabId\(/g) || []).length >= 6, "tab-scoped tabId parameters must reuse explicit fallback warning helper");
assert(toolSource.includes("NativeCommandParamsSchema"), "native tools must use one generic params schema and protocol validation");
assert((toolSource.match(/params: Type.Optional\(NativeCommandParamsSchema\)/g) || []).length >= 3, "native tool params must use generic protocol-backed schema");
for (const forbidden of ["NativeWaitCommandParamSchemas", "NativeNetworkCommandParamSchemas", "NativeHookCommandParamSchemas", "NativeFrameCommandParamSchemas", "NativeHtmlCommandParamSchemas", "NativeEvidenceCommandParamSchemas", "NativeWaitParamsSchema", "NativeNetworkParamsSchema", "NativeHookParamsSchema", "NativeFrameParamsSchema", "NativeHtmlParamsSchema", "NativeEvidenceParamsSchema"]) assert(!toolSource.includes(forbidden), `registerTools.ts must not duplicate native command params schema: ${forbidden}`);
assert(toolSource.includes("outputPath: Type.Optional(Type.String({ description: OUTPUT_PATH_DESCRIPTION }))"), "scan output path option missing");
assert(read("src/tools/registerScanTool.ts").includes("distilledTextResult"), "browser_scan must use result distillation middleware");
assert(read("src/tools/registerHtmlTool.ts").includes("distilledTextResult"), "browser_html must use result distillation middleware");
assert(read("src/tools/registerContentTool.ts").includes("distilledTextResult"), "browser_content must use result distillation middleware");
assert(read("src/tools/registerPickTool.ts").includes("distilledJsonResult"), "browser_pick must use result distillation middleware");
assert(read("src/tools/registerElementActionTools.ts").includes("distilledJsonResult"), "browser_query/click/type must use result distillation middleware");
assert(read("src/tools/registerElementActionTools.ts").includes("summarizeElementActionData"), "browser_query/click/type must use compact element summaries");
assert(read("src/tools/registerSemanticDomTools.ts").includes("distilledJsonResult"), "semantic DOM tools must use result distillation middleware");
assert(read("src/tools/registerSemanticDomTools.ts").includes("nodeIds are short-lived"), "semantic DOM tools must document short-lived nodeId lifecycle");
const transferTools = read("src/tools/registerTransferTools.ts");
assert(transferTools.includes("distilledJsonResult"), "browser_upload/download must use result distillation middleware");
assert(transferTools.includes("confirm:true"), "browser_upload must require explicit confirmation");
assert((transferTools.match(/command\.timeoutMs = timeoutMs/g) || []).length >= 2, "browser_upload/download must pass timeoutMs inside bridge commands");
assert(read("src/tools/registerScreenshotTool.ts").includes("fallback: params.fallback, timeoutMs"), "browser_screenshot must pass timeoutMs inside bridge commands");
const evidenceTool = read("src/tools/registerEvidenceTool.ts");
assert(evidenceTool.includes("distilledJsonResult"), "browser_evidence must use result distillation middleware");
assert(evidenceTool.includes("body.timeoutMs = timeoutMs"), "browser_evidence must pass timeoutMs inside bridge commands");
assert(read("src/tools/registerExecuteTool.ts").includes("distilledJsonResult"), "browser_execute must route raw JS/command data through result distillation middleware");
const nativeActionTools = read("src/tools/registerNativeActionTools.ts");
assert(nativeActionTools.includes("distilledJsonResult"), "native action tools must use result distillation middleware");
assert(nativeActionTools.includes("body.timeoutMs = timeoutMs"), "native action tools must pass timeoutMs inside bridge commands");
for (const prefix of ["wait-result", "network-result", "hook-result", "frame-result"]) assert(nativeActionTools.includes(`artifactPrefix: "${prefix}"`), `native action tool missing artifact prefix: ${prefix}`);
assert(!nativeActionTools.includes("return jsonResult(result"), "native action tools must not return raw command result directly");
assert(!read("src/tools/registerExecuteTool.ts").includes("return jsonResult(await server"), "browser_execute must not return raw bridge result directly");
assert(read("src/tools/resultMiddleware.ts").includes("./summaries/index"), "result middleware must use split summary modules");
assert(read("src/tools/budgets.ts").includes("TOOL_RESULT_BUDGETS"), "tool result budgets must be table-driven");
const skill = read("D:/Pi/agent/skills/pi-browser-tools/SKILL.md");
assert(skill.includes("tabId") && skill.includes("browser_tabs list"), "skill must document explicit tabId automation flow");
assert(skill.includes("browser_pick") && skill.includes("browser_content"), "skill must document pick/content flows");
assert(skill.includes("browser_query") && skill.includes("browser_click") && skill.includes("browser_type"), "skill must document query/click/type flows");
assert(skill.includes("browser_dom_snapshot") && skill.includes("browser_dom_click") && skill.includes("browser_dom_type"), "skill must document semantic DOM nodeId flows");
assert(skill.includes("browser_download") && skill.includes("browser_upload"), "skill must document upload/download flows");
assert(skill.includes("browser_execute") && skill.includes("browser_hook") && skill.includes("browser_frame"), "skill must document raw-data and advanced browser tools");
assert(skill.includes("summary") && skill.includes("browser_artifact"), "skill must document summary/artifact flow");
assert(!skill.includes("npm run check") && !skill.includes("smoke:browser"), "skill must not contain project development validation flow");
console.log("tools contract ok");
