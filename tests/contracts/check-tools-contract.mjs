import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
function resolveReadPath(rel) {
	if (path.isAbsolute(rel)) return rel;
	const drivePath = /^([A-Za-z]):[\\/](.*)$/.exec(rel);
	if (drivePath) return process.platform === "win32" ? rel : path.join("/mnt", drivePath[1].toLowerCase(), drivePath[2].replace(/\\/g, "/"));
	return path.join(root, rel);
}
const read = (rel) => readFileSync(resolveReadPath(rel), "utf8");
const normalizeNewlines = (text) => text.replace(/\r\n/g, "\n");
function assert(condition, message) { if (!condition) throw new Error(message); }
function readTypeScriptSources(rel) {
	const dir = path.join(root, rel);
	return readdirSync(dir, { withFileTypes: true })
		.flatMap((entry) => {
			const child = path.join(rel, entry.name);
			if (entry.isDirectory()) return [readTypeScriptSources(child)];
			return entry.name.endsWith(".ts") ? [read(child)] : [];
		})
		.join("\n");
}

function readToolSources() {
	return readTypeScriptSources("src/tools");
}

function readWebSecurityRegisterSources() {
	return [read("src/tools/registerWebSecurityTools.ts"), readTypeScriptSources("src/tools/webSecurity/register")].join("\n");
}

const indexSource = normalizeNewlines(read("index.ts"));
assert(/if \(!startPromise\) \{\s*startPromise = server\.start\(\)\.catch/.test(indexSource), "ensureStarted must cache the startup promise synchronously before awaiting it");
assert(indexSource.includes("server.start().catch"), "extension startup must clear cached startPromise on start failure so later calls can retry");
assert(indexSource.includes("startPromise = undefined;\n\t\t\t\tthrow error;"), "extension startup retry path must reset and rethrow start errors");

const registerToolsSource = read("src/tools/registerTools.ts");
const toolRegistrySource = read("src/tools/toolRegistry.ts");
const toolSource = readToolSources();
const packageJson = JSON.parse(read("package.json"));

const toolAdapterSource = read("src/tools/toolAdapter.ts");
function usesJsonDistillation(source) { return source.includes("distilledJsonResult") || (source.includes("jsonToolResult") && toolAdapterSource.includes("distilledJsonResult")); }
function usesTextDistillation(source) { return source.includes("distilledTextResult") || (source.includes("textToolResult") && toolAdapterSource.includes("distilledTextResult")); }
function preservesBridgeResult(source) { return source.includes("distilledJsonResult(result,") || source.includes("jsonToolResult(result,"); }
function passesBodyTimeout(source) { return source.includes("body.timeoutMs = timeoutMs") || source.includes("applyDefaultTimeout(body, timeoutMs)"); }
function usesBridgeNestedError(source) { return source.includes("new BrowserBridgeError(record.error_code") || (source.includes("bridgeNestedErrorResult") && toolAdapterSource.includes("new BrowserBridgeError(record.error_code")); }
assert(registerToolsSource.split(/\r?\n/).length <= 30, "registerTools.ts must stay a very thin composition entrypoint");
assert(!registerToolsSource.includes("registerTool({"), "registerTools.ts must not directly register individual tools");
assert(!registerToolsSource.includes("waitCommandForAction"), "registerTools.ts must not own domain action mapping");
assert(registerToolsSource.includes("resolveBrowserToolRegistrars") && registerToolsSource.includes("for (const registerTool of resolveBrowserToolRegistrars(options))"), "registerTools.ts must consume declarative tool registrars instead of hard-coded per-tool calls");
assert(toolRegistrySource.includes("CORE_BROWSER_TOOL_REGISTRARS") && toolRegistrySource.includes("WEB_SECURITY_TOOL_REGISTRARS") && toolRegistrySource.includes("resolveBrowserToolRegistrars"), "toolRegistry.ts must define declarative core/security registries and resolver");
assert((toolRegistrySource.match(/register[A-Z][A-Za-z]+Tool/g) || []).length >= 20, "toolRegistry.ts must enumerate the browser tool registrars explicitly");
for (const name of ["browser_tabs", "browser_command", "browser_execute", "browser_observe", "browser_pick", "browser_download", "browser_upload", "browser_wait", "browser_network", "browser_hook", "browser_evidence", "browser_frame", "browser_screenshot", "browser_artifact", "browser_recon_probe", "browser_crawl", "browser_fuzz_paths", "browser_fuzz_vhosts", "browser_sqli_probe", "browser_sqlmap_bridge", "browser_nuclei_bridge", "browser_template_check", "browser_callback_oast", "browser_cookie_analyze", "browser_fuzz_params", "browser_http_replay"]) assert(toolSource.includes(`name: "${name}"`), `tool not registered: ${name}`);
for (const removed of ["browser_query", "browser_click", "browser_type", "browser_dom_snapshot", "browser_dom_click", "browser_dom_type"]) assert(!toolSource.includes(`name: "${removed}"`), `removed split action tool must not be registered: ${removed}`);
for (const removedFile of ["src/tools/registerElementActionTools.ts", "src/tools/registerSemanticDomTools.ts", "src/actions/buildElementActionScript.ts", "src/dom/buildSemanticDomScript.ts"]) assert(!existsSync(path.join(root, removedFile)), `removed split action source must not exist: ${removedFile}`);
assert(!toolSource.includes("PI_BROWSER_ENABLE_COMPAT_PRO"), "browser_pro compatibility gate must be removed");
assert(!toolSource.includes("name: \"browser_pro\""), "browser_pro tool must be removed");
assert(toolSource.includes("selectBrowser"), "browser selection action missing");
const bridgeServerSource = read("src/driver/BrowserBridgeServer.ts");
const tabRouterSource = read("src/driver/BrowserTabSessionRouter.ts");
const driverTypesSource = read("src/driver/types.ts");
assert(bridgeServerSource.includes("Selected browser has no active tabs") && (tabRouterSource.includes("firstActiveSessionIdForClient(ws)") || tabRouterSource.includes("firstActiveSessionIdForClient(ws, browserSessionId)")) && bridgeServerSource.includes("validation.spec.tabScoped && tabId === undefined"), "selectBrowser must clear implicit target for empty selected browsers and tab-scoped implicit commands must return NO_TAB");
assert(tabRouterSource.includes("preferredImplicitSessionId") && tabRouterSource.includes("session.active === true") && (tabRouterSource.includes("session.id === this.latestSessionId") || tabRouterSource.includes("session.id === browserSession.latestSessionId")), "selectBrowser/default fallback must prefer active tabs, then a valid latest tab, before deterministic first-live fallback");
assert(tabRouterSource.includes("sessionIdForTab") && driverTypesSource.includes("browserId: string") && tabRouterSource.includes("liveSessionForTabId") && !bridgeServerSource.includes("this.sessions.get(String(tabId))") && !tabRouterSource.includes("this.sessions.get(String(tabId))"), "BrowserBridgeServer tab sessions must be keyed by browser-scoped session id, not bare numeric tabId");
assert(tabRouterSource.includes("AMBIGUOUS_TAB_ID") && tabRouterSource.includes("Multiple connected browsers expose the same tabId"), "duplicate numeric tabIds across browsers must not route through an unscoped arbitrary session");
assert(bridgeServerSource.includes('throw new BrowserBridgeError("TAB_NOT_FOUND"') && bridgeServerSource.includes("Target browser tab is not connected") && !/private socketForTab[\s\S]*?return this\.clients\.requireExtensionClient\(\)/.test(bridgeServerSource), "explicit tabId without a live session must fail locally instead of falling back to another browser socket");
assert(bridgeServerSource.split(/\r?\n/).length <= 520 && tabRouterSource.split(/\r?\n/).length <= 270, "BrowserBridgeServer must stay a thin facade after driver split");
const tabsTool = read("src/tools/registerTabsTool.ts");
assert(tabsTool.includes("function requireTabsActionTabId"), "browser_tabs switch/close must validate tabId before calling the bridge");
assert(tabsTool.includes("browser_tabs ${action} requires a valid tabId"), "browser_tabs tabId validation must return a clear action-specific error");
assert(tabsTool.includes('action === "switch" || action === "close"') && tabsTool.includes('action === "attachtab" || action === "detachtab"') && tabsTool.includes('requireTabsActionTabId(action, params.tabId)'), "browser_tabs must require tabId for switch/close/attachTab/detachTab actions");
assert(!tabsTool.includes('server.closeTab(params.tabId ?? ""') && !tabsTool.includes('server.switchTab(params.tabId ?? ""'), "browser_tabs must not pass empty-string tabId fallbacks to server methods");
assert(tabsTool.includes("function normalizeCreateTabUrl") && tabsTool.includes("INVALID_TAB_URL") && tabsTool.includes("javascript:"), "browser_tabs create must validate malformed/script URLs before starting the bridge");
assert(!tabsTool.includes('server.createTab(params.url || "about:blank"'), "browser_tabs create must not pass raw URL values directly to server.createTab");
assert(toolSource.includes("For automation, call browser_tabs list or switch first"), "tab-scoped tools must warn agents to list/switch before automation");
assert(toolSource.includes("omitted tabId uses the mutable selected/active tab fallback"), "tabId fallback warning missing from tool prompts");
assert((toolSource.match(/TAB_SCOPED_TOOL_GUIDELINE/g) || []).length >= 6, "tab-scoped tools must reuse explicit tabId guidance");
assert(((toolSource.match(/optionalTargetTabId\(/g) || []).length + (toolSource.match(/sharedTabScopedToolParams\(/g) || []).length) >= 6, "tab-scoped tabId parameters must reuse explicit fallback warning helper");
assert(toolAdapterSource.includes("sharedTabScopedToolParams") && toolAdapterSource.includes("toolTimeoutMs") && toolAdapterSource.includes("jsonToolResult") && toolAdapterSource.includes("textToolResult") && toolAdapterSource.includes("runTool"), "tool adapter must centralize shared params, timeout, result distillation, and error wrapping");
assert(toolSource.includes("NativeCommandParamsSchema"), "native tools must use one generic params schema and protocol validation");
assert((toolSource.match(/params: Type.Optional\(NativeCommandParamsSchema\)/g) || []).length >= 3, "native tool params must use generic protocol-backed schema");
for (const forbidden of ["NativeWaitCommandParamSchemas", "NativeNetworkCommandParamSchemas", "NativeHookCommandParamSchemas", "NativeFrameCommandParamSchemas", "NativeHtmlCommandParamSchemas", "NativeEvidenceCommandParamSchemas", "NativeWaitParamsSchema", "NativeNetworkParamsSchema", "NativeHookParamsSchema", "NativeFrameParamsSchema", "NativeHtmlParamsSchema", "NativeEvidenceParamsSchema"]) assert(!toolSource.includes(forbidden), `registerTools.ts must not duplicate native command params schema: ${forbidden}`);
assert(toolSource.includes("outputPath: Type.Optional(Type.String({ description: OUTPUT_PATH_DESCRIPTION }))") || toolSource.includes("sharedTabScopedToolParams"), "scan output path option missing");
const observeToolSource = read("src/tools/registerObserveTool.ts");
const observeRunnerSource = read("src/tools/observeRunners.ts");
assert(usesTextDistillation(observeRunnerSource), "browser_observe scan/content/html paths must use result distillation middleware");
assert(observeToolSource.includes('name: "browser_observe"') && observeToolSource.includes("normalizeObserveMode") && observeToolSource.includes("validateObserveParams"), "browser_observe must register one explicit-mode observation tool with mode validation");
assert(observeRunnerSource.includes("withTrackedOperation") && observeRunnerSource.includes("createObservationSnapshot") && read("src/tools/registerTabsTool.ts").includes("action === \"snapshot\""), "observe/tabs must expose tracked operations and explicit snapshot metadata");
assert((observeRunnerSource.includes("jsonToolResult(tabsOnlyData") || observeRunnerSource.includes("toolName: \"browser_observe\"")) && (observeRunnerSource.includes("artifactValue: { ...result, tabs_count") || observeRunnerSource.includes("artifactValue: { ...observation, tabs_count")), "browser_observe scan/tabs must preserve tabsOnly and full scan metadata through result distillation artifacts");
assert(observeRunnerSource.includes("artifactValue: result") || observeRunnerSource.includes("artifactValue: { ...result, operation, snapshot: snapshotMeta }"), "browser_observe html outputPath artifacts must preserve the full bridge result envelope");
assert(observeRunnerSource.includes("bridgeNestedErrorResult") && usesBridgeNestedError(observeRunnerSource), "browser_observe html bridge ok:false errors must preserve stable bridge error_code such as SELECTOR_NOT_FOUND");
assert(!observeRunnerSource.includes("body.maxChars =") && !observeRunnerSource.includes("body.max_chars ="), "browser_observe html top-level maxChars must remain a return budget and must not become a bridge capture maxChars");
assert(observeRunnerSource.includes("artifactValue: { ...result, navigation: navigationData }") || observeRunnerSource.includes("artifactValue: { ...result.result, navigation: result.navigationData }") || observeRunnerSource.includes("artifactValue: { ...result.result, navigation: result.navigationData, operation, snapshot: snapshotMeta }"), "browser_observe content outputPath artifacts must preserve structured extraction and navigation metadata");
assert(observeRunnerSource.includes("executeBrowserWaitWithSupervisor") && !observeRunnerSource.includes("server.sendCommand({ cmd: \"wait.navigateAndWait\""), "browser_observe content URL navigation must route through the durable wait supervisor");
assert(observeRunnerSource.includes("normalizeContentTimeoutMs(params.timeoutMs)") && !observeRunnerSource.includes("Math.max(timeoutMs"), "browser_observe content must not silently expand user timeoutMs during extraction");
assert(usesJsonDistillation(read("src/tools/registerPickTool.ts")), "browser_pick must use result distillation middleware");
const transferTools = read("src/tools/registerTransferTools.ts");
assert(usesJsonDistillation(transferTools), "browser_upload/download must use result distillation middleware");
assert(!transferTools.includes("distilledJsonResult(result.data ?? result") && preservesBridgeResult(transferTools), "browser_upload/download must preserve full BrowserBridgeExecutionResult metadata at the top level");
assert(transferTools.includes("confirm:true"), "browser_upload must require explicit confirmation");
assert((transferTools.match(/command\.timeoutMs = timeoutMs/g) || []).length >= 2, "browser_upload/download must pass timeoutMs inside bridge commands");
assert(read("src/tools/toolShared.ts").includes("DEFAULT_OBSERVATION_TIMEOUT_MS = 35_000"), "observation-heavy browser tools must have a named longer default timeout");
const screenshotToolSource = read("src/tools/registerScreenshotTool.ts");
assert(screenshotToolSource.includes("fallback: params.fallback, timeoutMs"), "browser_screenshot must pass timeoutMs inside bridge commands");
assert(screenshotToolSource.includes("actualFormat") && screenshotToolSource.includes('typeof data?.format === "string"'), "browser_screenshot default artifact extension must follow the actual returned screenshot format");
const evidenceTool = read("src/tools/registerEvidenceTool.ts");
assert(evidenceTool.includes("DEFAULT_OBSERVATION_TIMEOUT_MS"), "browser_evidence must use the longer observation timeout by default");
assert(usesJsonDistillation(evidenceTool), "browser_evidence must use result distillation middleware");
assert(evidenceTool.includes("withTrackedOperation") && evidenceTool.includes("operation,"), "browser_evidence must expose tracked operation metadata for cross-tool evidence correlation");
assert(passesBodyTimeout(evidenceTool), "browser_evidence must pass timeoutMs inside bridge commands");
const commandTool = read("src/tools/registerCommandTool.ts");
const executeTool = read("src/tools/registerExecuteTool.ts");
assert(String(packageJson.scripts?.["check:tools"] || "").includes("check-execute-tool.mjs"), "check:tools must run browser_execute monitor shape contract");
assert(usesJsonDistillation(commandTool), "browser_command must route bridge command data through result distillation middleware");
assert(commandTool.includes('name: "browser_command"') && commandTool.includes('details: { mode: "command" }') && commandTool.includes("withTrackedOperation"), "browser_command must register the explicit command-only tool and emit tracked operation metadata");
assert(usesJsonDistillation(executeTool), "browser_execute must route raw JS data through result distillation middleware");
assert(!executeTool.includes("command: Type.Optional") && !executeTool.includes("parseMaybeCommand") && !executeTool.includes("rejectUnsafeExecuteCommand"), "browser_execute must be JavaScript-only after TODO 245");
assert(executeTool.includes("detectCommandLikeScript") && executeTool.includes("use browser_command for bridge commands"), "browser_execute must reject command-like JSON strings with a browser_command recovery hint");
assert(executeTool.includes("monitor: Type.Optional") && executeTool.includes("executeJavaScriptWithMonitor") && executeTool.includes("buildScanScript"), "browser_execute must expose optional GA-style monitor without making it default");
assert(executeTool.includes("monitorTimeoutMs") && executeTool.includes("beforeOk") && executeTool.includes("afterOk") && executeTool.includes("beforeError") && executeTool.includes("afterError"), "browser_execute monitor must bound scan timeout and report before/after scan failures explicitly");
assert(executeTool.includes("...executed") && !executeTool.includes("execution: executed.data") && !executeTool.includes("newTabs: executed.newTabs"), "browser_execute monitor must preserve BrowserBridgeExecutionResult top-level metadata and append monitor only");
const nativeActionTools = read("src/tools/registerNativeActionTools.ts");
assert(nativeActionTools.includes("DEFAULT_OBSERVATION_TIMEOUT_MS") && nativeActionTools.includes('commandName.endsWith(".list")') && nativeActionTools.includes('commandName.endsWith(".exportHar")'), "browser_network list/body/exportHar must use the longer observation timeout by default");
assert(usesJsonDistillation(nativeActionTools), "native action tools must use result distillation middleware");
assert(nativeActionTools.includes("withTrackedOperation") && nativeActionTools.includes("queueDepth: server.queueDepth") && nativeActionTools.includes("leaseOwnerHash: server.leaseOwnerHash"), "native action tools must expose tracked operation metadata for cross-tool evidence correlation");
assert(nativeActionTools.includes("nativeActionErrorResult") && usesBridgeNestedError(nativeActionTools), "native action tools must preserve bridge ok:false error_code in tool errors");
assert(passesBodyTimeout(nativeActionTools), "native action tools must pass timeoutMs inside bridge commands");
assert(nativeActionTools.includes("executeBrowserWaitWithSupervisor") && nativeActionTools.includes("commandExecutor: executeBrowserWaitWithSupervisor"), "browser_wait must route long waits through the TS durable wait supervisor");
assert(nativeActionTools.includes("allowZeroTimeout?: boolean") && nativeActionTools.includes("function actionTimeoutMs"), "native action tools must support preserving timeoutMs=0 for immediate checks");
assert(/name:\s*"browser_wait"[\s\S]*?allowZeroTimeout:\s*true/.test(nativeActionTools), "browser_wait must preserve timeoutMs=0 at the tool layer for immediate checks");
assert(/name:\s*"browser_network"[\s\S]*?allowZeroTimeout:\s*true/.test(nativeActionTools), "browser_network wait must preserve timeoutMs=0 at the tool layer for immediate checks");
const waitSupervisor = read("src/driver/BrowserWaitSupervisor.ts");
assert(waitSupervisor.includes("waitTimeoutMs(options.timeoutMs, DEFAULT_WAIT_TIMEOUT_MS, true)") && waitSupervisor.includes("timeoutMs: 0") && waitSupervisor.includes("totalTimeoutMs === 0"), "wait supervisor must preserve timeoutMs=0 and send one immediate bridge probe");
assert(waitSupervisor.includes("WAIT_LEASE_MAX_MS = 25_000") && waitSupervisor.includes("WAIT_STATE_LOST") && waitSupervisor.includes("workerRestarts") && waitSupervisor.includes("historyLost"), "wait supervisor must use short leases and expose worker restart/state-loss evidence");
assert(waitSupervisor.includes("WAIT_LEASE_TIMEOUT_RETRY_BACKOFF_MS = 50") && waitSupervisor.includes("await sleep(retryDelayMs)") && waitSupervisor.includes("retryDelayMs"), "wait supervisor must throttle instant lease timeouts instead of tight-loop retrying");
assert(waitSupervisor.includes('cmd: "wait.navigate"') && waitSupervisor.includes("waitCommandForNavigateAndWait"), "wait.navigateAndWait must navigate once and supervise only the follow-up wait");
const stripBridgeSource = (text) => text
	.replace(/^\/\/ @ts-nocheck\r?\n/, "")
	.replace(/^import\s+[^;]+;\r?\n/gm, "")
	.replace(/^export\s+\{[^}]+\};\r?\n/gm, "")
	.replace(/^export const (?!__piBridgeModule_)([A-Za-z0-9_$]+)\s*=/gm, "const $1 =")
	.replace(/\s+as\s+any/g, "")
	.replace(/\r?\n\/\/ ESM module boundary marker for TODO 189\r?\nexport const __piBridgeModule_[\s\S]*?;\s*$/, "")
	.replace(/\r?\nexport \{\};\s*$/, "");
const readServiceWorkerSource = (name) => stripBridgeSource(read(`bridge_src/service_worker/${name}.ts`));
const bridgeInfo = readServiceWorkerSource("bridge_info");
assert(bridgeInfo.includes("PI_BROWSER_WORKER_BOOT_ID") && bridgeInfo.includes("workerBootId") && bridgeInfo.includes("workerStartedAt"), "bridge metadata must expose service-worker boot identity for wait recovery diagnostics");
const runtimeSource = readServiceWorkerSource("runtime");
assert(
	runtimeSource.includes("resp.details.bridge")
	&& (runtimeSource.includes("resp.data.bridge") || runtimeSource.includes("dataRecord.bridge"))
	&& runtimeSource.includes("piBridgeInfo()"),
	"native wait results/errors must carry bridge boot metadata",
);
for (const prefix of ["wait-result", "network-result", "hook-result", "frame-result"]) assert(nativeActionTools.includes(`artifactPrefix: "${prefix}"`), `native action tool missing artifact prefix: ${prefix}`);
assert(!nativeActionTools.includes("return jsonResult(result"), "native action tools must not return raw command result directly");
assert(!executeTool.includes("return jsonResult(await server"), "browser_execute must not return raw bridge result directly");
assert(indexSource.includes("resolveBrowserToolCapabilityProfile") && indexSource.includes("securityToolsEnabled: capabilityProfile.securityToolsEnabled") || indexSource.includes("capabilityProfile.securityToolsEnabled"), "index.ts must resolve a visible browser tool capability profile and pass it to tool registration");
assert(toolRegistrySource.includes("options.securityToolsEnabled === false") && toolRegistrySource.includes("CORE_BROWSER_TOOL_REGISTRARS") && toolRegistrySource.includes("WEB_SECURITY_TOOL_REGISTRARS"), "toolRegistry must support explicit core/security capability profile gating for Web Security tools");
const resultMiddlewareSource = read("src/tools/resultMiddleware.ts");
assert(resultMiddlewareSource.includes("./summaries/index") && resultMiddlewareSource.includes("browserSessionId: options.browserSessionId"), "result middleware must use split summary modules and preserve browserSessionId in distilled envelopes");
for (const token of ["diagnostics?:", "target?:", "limits?:", "privacy?:", "nextActions?:", "function sanitizeDistilledEnvelope", "redactSensitiveValue(envelope)", "correlation", "selectionVersionAtDispatch", "selectionVersionAtResolve"]) assert(resultMiddlewareSource.includes(token), `result middleware must expose bounded redacted optional envelope metadata: ${token}`);
const webSecurityTools = readWebSecurityRegisterSources();
assert(webSecurityTools.includes("browser_recon_probe") && webSecurityTools.includes("browser_crawl") && webSecurityTools.includes("browser_fuzz_paths") && webSecurityTools.includes("browser_fuzz_vhosts") && webSecurityTools.includes("browser_sqli_probe") && webSecurityTools.includes("browser_sqlmap_bridge") && webSecurityTools.includes("browser_nuclei_bridge") && webSecurityTools.includes("browser_template_check") && webSecurityTools.includes("browser_callback_oast") && webSecurityTools.includes("browser_cookie_analyze") && webSecurityTools.includes("browser_fuzz_params") && webSecurityTools.includes("browser_http_replay"), "web security tools must register recon/crawl/fuzz/replay tools");
function toolRegistrationBlock(source, name) {
	const marker = `name: "${name}"`;
	const start = source.indexOf(marker);
	assert(start >= 0, `missing tool registration block: ${name}`);
	const next = source.indexOf("\nexport function register", start + marker.length);
	return source.slice(start, next >= 0 ? next : source.length);
}
for (const name of ["browser_recon_probe", "browser_crawl", "browser_fuzz_paths", "browser_fuzz_vhosts", "browser_sqli_probe", "browser_sqlmap_bridge", "browser_nuclei_bridge", "browser_template_check", "browser_callback_oast", "browser_cookie_analyze", "browser_fuzz_params", "browser_http_replay"]) {
	const block = toolRegistrationBlock(webSecurityTools, name);
	assert(/bounded|max(?:Depth|Pages|Candidates|Cases|Templates|Events|BodyBytes)|rateLimit|timeout/i.test(block), `${name} must expose bounded execution wording or bounded controls`);
	assert(/scoped|scope|captured|raw|request template|callback URLs\/hosts|cookie\/JWT/i.test(block), `${name} must expose scoped/captured input wording`);
	assert(/artifact|evidence/i.test(block), `${name} must preserve artifact/evidence wording`);
}
assert(packageJson.dependencies?.["js-yaml"], "package must depend on js-yaml for template YAML parsing");
const webSecurityCore = read("src/tools/webSecurityCore.ts");
const webSecurityDir = path.join(root, "src", "tools", "webSecurity");
const webSecurityEntries = readdirSync(webSecurityDir, { withFileTypes: true });
const webSecurityTopLevelFiles = webSecurityEntries.filter((entry) => entry.isFile()).map((entry) => entry.name);
const webSecurityTopLevelDirs = webSecurityEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
const browserNativeFiles = readdirSync(path.join(webSecurityDir, "browserNative")).filter((file) => file.endsWith(".ts")).sort();
const bridgeFiles = readdirSync(path.join(webSecurityDir, "bridges")).filter((file) => file.endsWith(".ts")).sort();
const registerFiles = readdirSync(path.join(webSecurityDir, "register")).filter((file) => file.endsWith(".ts")).sort();
const webSecurityTypes = read("src/tools/webSecurity/shared/types.ts");
const webSecurityTemplate = read("src/tools/webSecurity/shared/template.ts");
const webSecurityReplay = read("src/tools/webSecurity/shared/replay.ts");
const webSecurityHar = read("src/tools/webSecurity/shared/har.ts");
const webSecurityRequestTemplate = read("src/tools/webSecurity/shared/requestTemplate.ts");
const webSecurityRecon = read("src/tools/webSecurity/browserNative/recon.ts");
const webSecurityFuzzPaths = read("src/tools/webSecurity/browserNative/fuzzPaths.ts");
const webSecurityFuzzVhosts = read("src/tools/webSecurity/browserNative/fuzzVhosts.ts");
const webSecurityCookieAnalyze = read("src/tools/webSecurity/browserNative/cookieAnalyze.ts");
const webSecurityCallbackOast = read("src/tools/webSecurity/browserNative/callbackOast.ts");
const webSecurityOastWorkerManager = read("src/tools/webSecurity/browserNative/oastWorkerManager.ts");
const webSecuritySqli = read("src/tools/webSecurity/browserNative/sqliProbe.ts");
const webSecuritySqlmap = read("src/tools/webSecurity/bridges/sqlmapBridge.ts");
const webSecurityNuclei = read("src/tools/webSecurity/bridges/nucleiBridge.ts");
const webSecurityTemplateCheck = read("src/tools/webSecurity/browserNative/templateCheck.ts");
const webSecurityRails = read("src/tools/webSecurity/shared/railsCookieTokens.ts");
assert(JSON.stringify(webSecurityTopLevelDirs) === JSON.stringify(["bridges", "browserNative", "register", "shared"]), "webSecurity/ must be layered as register, shared, browserNative, and bridges only");
assert(JSON.stringify(webSecurityTopLevelFiles) === JSON.stringify([]), "webSecurity/ must not keep mixed top-level runtime files");
assert(browserNativeFiles.includes("recon.ts") && browserNativeFiles.includes("crawl.ts") && browserNativeFiles.includes("fuzzPaths.ts") && browserNativeFiles.includes("fuzzParams.ts") && browserNativeFiles.includes("fuzzVhosts.ts") && browserNativeFiles.includes("httpReplay.ts") && browserNativeFiles.includes("callbackOast.ts"), "browserNative layer must own the Pi-native web execution modules");
assert(JSON.stringify(bridgeFiles) === JSON.stringify(["nucleiBridge.ts", "sqlmapBridge.ts"]), "bridges layer must only contain mature-engine bridge adapters");
assert(registerFiles.includes("shared.ts") && registerFiles.includes("index.ts") && registerFiles.filter((file) => /^register[A-Z].*\.ts$/.test(file)).length === 12, "webSecurity/register must keep one shared shell, one facade index, and one explicit register module per callable security tool");
assert(webSecurityTemplate.includes('from "js-yaml"'), "template YAML parsing must use js-yaml");
assert(!webSecurityTemplate.includes("function parseYamlLines("), "hand-written YAML parser must not return");
assert(webSecurityCore.split(/\r?\n/).length <= 40, "webSecurityCore.ts must stay a thin compatibility export layer");
assert(!/^(?:export\s+)?(?:async\s+)?function\s+/m.test(webSecurityCore), "webSecurityCore.ts must not keep runtime implementations");
for (const exportName of ["runReconProbe", "runBrowserCrawl", "runFuzzPaths", "runFuzzVhosts", "runCookieAnalyze", "runFuzzParams", "runSqliProbe", "runSqlmapBridge", "runNucleiBridge", "runTemplateCheck", "runCallbackOast", "runHttpReplay", "buildReplayRequest", "parseRawHttpRequest", "browserCookiesToHeader"]) assert(webSecurityCore.includes(exportName), `webSecurityCore.ts must re-export ${exportName}`);
assert(webSecurityCore.includes("./webSecurity/browserNative/") && webSecurityCore.includes("./webSecurity/bridges/"), "webSecurityCore.ts must route native and bridge exports through the layered folders");
for (const rawTypeName of ["RawProbeOptions", "RawReplayOptions", "RawCrawlOptions", "RawFuzzPathsOptions", "RawFuzzParamsOptions", "RawFuzzVhostsOptions", "RawCookieAnalyzeOptions", "RawCallbackOastOptions", "RawSqliProbeOptions", "RawTemplateCheckOptions", "RawSqlmapBridgeOptions", "RawNucleiBridgeOptions"]) assert(webSecurityTypes.includes(`export type ${rawTypeName}`), `shared types must name raw entry options explicitly: ${rawTypeName}`);
assert(webSecurityRecon.includes("NormalizedProbeOptions"), "recon implementation must normalize inputs before execution");
assert(webSecurityReplay.includes("NormalizedReplayOptions"), "replay implementation must normalize inputs before execution");
assert(webSecurityFuzzPaths.includes("NormalizedFuzzPathsOptions") && webSecurityFuzzPaths.includes("RawFuzzPathsOptions"), "fuzz-paths implementation must normalize raw inputs before execution");
assert(webSecurityFuzzVhosts.includes("NormalizedFuzzVhostsOptions") && webSecurityFuzzVhosts.includes("RawFuzzVhostsOptions"), "fuzz-vhosts implementation must normalize raw inputs before execution");
assert(webSecurityCookieAnalyze.includes("NormalizedCookieAnalyzeOptions") && webSecurityCookieAnalyze.includes("RawCookieAnalyzeOptions"), "cookie-analyze implementation must normalize raw inputs before execution");
assert(read("src/tools/webSecurity/shared/cookieTokens.ts").includes("createRailsCookieTokenFns") && read("src/tools/webSecurity/shared/cookieTokens.ts").includes("const { verifyRailsEncryptedToken, verifyRailsSignedToken"), "cookie analyzer must delegate Rails flows through a dedicated shared module factory");
for (const helperName of ["function decodedTextCandidates", "function strictBase64Decode", "function parseRailsEncryptedToken", "function parseRailsLegacyCbcPayload", "function deriveRailsPbkdf2Key"]) assert(!read("src/tools/webSecurity/shared/cookieTokens.ts").includes(helperName), `cookieTokens.ts must not retain Rails-only helper: ${helperName}`);
assert(webSecurityRails.includes("createRailsCookieTokenFns") && webSecurityRails.includes("verifyRailsSignedToken") && webSecurityRails.includes("signRailsSignedToken"), "rails cookie module must keep Rails signed-cookie responsibilities explicit");
assert(webSecurityRails.includes("verifyRailsEncryptedToken") && webSecurityRails.includes("encryptRailsToken"), "rails cookie module must implement native Rails AES-GCM encrypted-cookie decrypt and mutation flows");
assert(webSecurityRails.includes("verifyRailsLegacyCbcPayload") && webSecurityRails.includes("encryptRailsLegacyCbcToken"), "rails cookie module must implement native Rails legacy AES-CBC decrypt and mutation flows");
assert(webSecurityRails.includes("binaryPayloadEvidence") && webSecurityRails.includes("unsupportedSerializer"), "rails cookie module must retain binary or Marshal plaintext evidence after successful decrypt");
assert(webSecurityCallbackOast.includes("NormalizedCallbackOastOptions") && webSecurityCallbackOast.includes("RawCallbackOastOptions"), "callback-oast implementation must normalize raw inputs before execution");
assert(webSecurityCallbackOast.includes("oastWorkerManager") && webSecurityOastWorkerManager.includes("createCallbackSession") && webSecurityOastWorkerManager.includes("closeSync(stdoutFd)") && webSecurityOastWorkerManager.includes("closeSync(stderrFd)"), "callback-oast worker manager must close inherited worker log file descriptors");
assert(webSecuritySqli.includes("NormalizedSqliProbeOptions") && webSecuritySqli.includes("stopOnFirstMatch"), "sqli implementation must normalize inputs before execution and support stop-on-first-match short-circuiting");
assert(webSecuritySqlmap.includes("NormalizedSqlmapBridgeOptions"), "sqlmap bridge implementation must normalize inputs before execution");
assert(webSecurityNuclei.includes("NormalizedNucleiBridgeOptions"), "nuclei bridge implementation must normalize inputs before execution");
assert(webSecurityTemplateCheck.includes("NormalizedTemplateCheckOptions"), "template-check implementation must normalize inputs before execution");
assert(usesJsonDistillation(webSecurityTools) && webSecurityTools.includes("summarizeWebReconProbeData") && webSecurityTools.includes("summarizeBrowserCrawlData") && webSecurityTools.includes("summarizeFuzzPathsData") && webSecurityTools.includes("summarizeFuzzVhostsData") && webSecurityTools.includes("summarizeSqliProbeData") && webSecurityTools.includes("summarizeSqlmapBridgeData") && webSecurityTools.includes("summarizeNucleiBridgeData") && webSecurityTools.includes("summarizeTemplateCheckData") && webSecurityTools.includes("summarizeCallbackOastData") && webSecurityTools.includes("summarizeCookieAnalyzeData") && webSecurityTools.includes("summarizeFuzzParamsData") && webSecurityTools.includes("summarizeHttpReplayData"), "web security tools must use distillation summaries");
assert(webSecurityTools.includes("bindBrowserSession") && webSecurityTools.includes("browserCookiesToHeader"), "web security tools must expose browser-session cookie binding without echoing cookie values");
assert(webSecurityTools.includes("async function executeWebSecurityToolShell"), "web security tools must centralize the shared execute shell");
assert(read("src/tools/registerWebSecurityTools.ts").split(/\r?\n/).length <= 20, "registerWebSecurityTools.ts must stay a thin facade export layer");
const webSecurityRegisterShared = read("src/tools/webSecurity/register/shared.ts");
assert(usesJsonDistillation(webSecurityRegisterShared) && webSecurityRegisterShared.includes("cmd: \"cookies\"") && webSecurityRegisterShared.includes("withTrackedOperation") && webSecurityRegisterShared.includes("onUpdate?: ToolOnUpdate"), "webSecurity register shared shell must centralize distillation, cookie binding, and tool-level progress");
assert((webSecurityTools.match(/pi\.registerTool\(\{/g) || []).length === 12, "web security tools must keep explicit per-tool registrations");
assert((webSecurityTools.match(/executeWebSecurityToolShell\(ensureStarted, normalizeWebSecurityToolParams<[^>]+ToolParams>\(params\), ctx, \{/g) || []).length === 12, "web security tools must normalize each registration into typed params before the shared execute shell");
assert(!webSecurityRegisterShared.includes("[key: string]: unknown"), "web security tool params must not use index signatures in the register shell");
assert(!webSecurityRegisterShared.includes("run: (params: Record<string, unknown>)"), "web security shell run functions must be generic typed, not Record<string, unknown>");
assert(!webSecurityRegisterShared.includes("const runParams: Record<string, unknown>"), "web security shell must not spread loose Record run params");
assert(webSecurityRegisterShared.includes("WebSecurityShellConfig<TParams extends WebSecuritySharedToolParams, TRunParams extends object, TResult>"), "web security shell config must be generic over tool params and run params");
assert(webSecurityRegisterShared.includes("augmentParams?: (params: TParams) => Partial<TRunParams>") && webSecurityRegisterShared.includes("run: (params: TRunParams) => Promise<TResult>"), "web security shell augment/run signatures must preserve typed params");
assert(webSecurityRegisterShared.includes("normalizeWebSecurityToolParams<TParams extends WebSecuritySharedToolParams>") && (webSecurityTools.match(/normalizeWebSecurityToolParams<[^>]+ToolParams>\(params\)/g) || []).length === 12, "each web security register module must normalize external params into a named tool params type");
assert((webSecurityRegisterShared.match(/export type [A-Za-z]+ToolParams = WebSecuritySharedToolParams & Raw[A-Za-z]+Options/g) || []).length === 12, "web security register shared layer must name one strong params alias per security tool");
assert(webSecurityRegisterShared.includes("createBrowserCookieProvider") && webSecurityRegisterShared.includes(": CookieProvider"), "browser cookie provider must have an explicit CookieProvider type");
assert(((webSecurityTools.match(/distilledJsonResult\(/g) || []).length + (webSecurityTools.match(/jsonToolResult\(/g) || []).length) === 1, "web security tool distillation must flow through one shared shell");
assert(((webSecurityTools.match(/errorResult\(/g) || []).length + (webSecurityTools.match(/runTool\(/g) || []).length) === 1, "web security tool error mapping must flow through one shared shell");
assert((webSecurityTools.match(/cmd: "cookies"/g) || []).length === 1, "web security tool cookie binding must be centralized in one shared shell");
assert(webSecurityTools.includes("for SQLi oracle evidence") && webSecurityTools.includes("stopOnFirstMatch"), "browser_sqli_probe tool docs must describe SQLi oracle evidence scope and expose stop-on-first-match short-circuiting");
assert(webSecurityTools.includes("activeGraphqlIntrospection defaults true") && webSecurityTools.includes("passive-only crawl"), "browser_crawl docs must make active GraphQL introspection behavior explicit");
assert(webSecurityTools.includes("omitted template selectors run the small built-in exposure/API baseline"), "browser_template_check docs must make default built-in template semantics explicit");
assert(webSecurityTools.includes("bounded safe-regex") && webSecurityTools.includes("bounded bodyRegex") && webSecurityTools.includes("bounded headerRegex") && webSecurityTools.includes("bounded extractRegex"), "browser_template_check docs must make bounded regex matcher/extractor semantics explicit");
assert(webSecurityReplay.includes('from "./har"') && webSecurityHar.includes("MAX_HAR_FILTER_CANDIDATE_ENTRIES") && webSecurityHar.includes("MAX_HAR_URL_MATCH_CHARS") && webSecurityHar.includes("unsafeRegexReason(patternText"), "HAR URL pattern filtering must be bounded, safe-regex checked, and isolated in shared/har.ts");
assert(webSecurityReplay.includes('from "./requestTemplate"') && webSecurityRequestTemplate.includes("parseRawHttpRequest") && webSecurityRequestTemplate.includes("buildReplayRequest") && webSecurityRequestTemplate.includes("capturedRequestTemplate"), "raw/captured replay request template parsing must be isolated in shared/requestTemplate.ts");
assert(webSecurityRegisterShared.includes("rawRequestParams") && (webSecurityTools.match(/\.\.\.rawRequestParams\(/g) || []).length === 4 && webSecurityTools.includes("Raw HTTP request text used as the probe template.") && webSecurityTools.includes("Raw HTTP request text used as the sqlmap request template.") && webSecurityTools.includes("Raw HTTP request text used as the nuclei request template."), "raw/captured request schema fields must be consolidated without losing tool-specific descriptions");
assert(webSecurityRegisterShared.includes("requestSequenceParams") && (webSecurityTools.match(/\.\.\.requestSequenceParams\(/g) || []).length === 3 && webSecurityTools.includes("Step objects may include variables, variableScope, and extractors/captures for later-step injection.") && webSecurityTools.includes("Each selected entry is sent to sqlmap as a separate target.") && webSecurityTools.includes("Each selected entry is sent to nuclei as a separate target."), "request sequence schema fields must be consolidated without losing tool-specific descriptions");
assert(webSecurityRegisterShared.includes("requests: Type.Optional(Type.Array(Type.Any(), { description: options.requestsDescription }))") && webSecurityRegisterShared.includes("sequence: Type.Optional(Type.Array(Type.Any(), { description: options.sequenceDescription }))"), "requestSequenceParams must preserve requests/sequence TypeBox shapes");
assert(webSecurityRegisterShared.includes("boundedExecutionParams") && (webSecurityTools.match(/\.\.\.boundedExecutionParams\(/g) || []).length === 2 && webSecurityTools.includes("sqlmap per-request timeout seconds; default derived from timeoutMs.") && webSecurityTools.includes("nuclei per-request timeout seconds; default derived from timeoutMs."), "bounded execution schema fields must be consolidated without losing bridge-specific timeoutSeconds descriptions");
assert(webSecurityRegisterShared.includes("timeoutSeconds: Type.Optional(Type.Number({ description: options.timeoutSecondsDescription }))"), "boundedExecutionParams must preserve timeoutSeconds TypeBox shape");
assert(webSecurityRegisterShared.includes("redirectControlParams") && (webSecurityTools.match(/\.\.\.redirectControlParams\(/g) || []).length === 8 && webSecurityTools.includes("Follow redirects and record the chain; default true.") && webSecurityTools.includes("Follow redirects; default false for replay determinism.") && webSecurityTools.includes("Follow redirects; default false for stable matching.") && webSecurityTools.includes("Follow redirects; default false for stable status matching."), "redirect control schema fields must be consolidated without losing tool-specific descriptions");
assert(webSecurityRegisterShared.includes("followRedirects: Type.Optional(Type.Boolean({ description: options.followRedirectsDescription }))") && webSecurityRegisterShared.includes("maxRedirects: Type.Optional(Type.Number({ description: options.maxRedirectsDescription }))"), "redirectControlParams must preserve followRedirects/maxRedirects TypeBox shapes");
assert(webSecurityRegisterShared.includes("rateLimitPerSecondParam") && (webSecurityTools.match(/\.\.\.rateLimitPerSecondParam\(/g) || []).length === 6 && webSecurityTools.includes("Sequential request rate cap per second; default unlimited sequential.") && webSecurityTools.includes("nuclei request rate cap per second via -rl; default unlimited."), "rate limit schema fields must be consolidated without losing native/nuclei-specific descriptions");
assert(webSecurityRegisterShared.includes("rateLimitPerSecond: Type.Optional(Type.Number({ description }))"), "rateLimitPerSecondParam must preserve rateLimitPerSecond TypeBox shape");
assert(webSecurityRegisterShared.includes("maxCasesParam") && (webSecurityTools.match(/\.\.\.maxCasesParam\(/g) || []).length === 2 && webSecurityTools.includes("Maximum location*param*operation*value cases; default 500, hard-capped at 5000.") && webSecurityTools.includes("Maximum probe cases; default 100, hard-capped at 5000."), "maxCases schema field must be consolidated without losing fuzz/SQLi-specific descriptions");
assert(webSecurityRegisterShared.includes("maxCandidatesParam") && (webSecurityTools.match(/\.\.\.maxCandidatesParam\(/g) || []).length === 2 && webSecurityTools.includes("Maximum candidates per base after extension/slash expansion; default 500, hard-capped at 5000.") && webSecurityTools.includes("Maximum host candidates per base; default 500, hard-capped at 5000."), "maxCandidates schema field must be consolidated without losing fuzz path/vhost descriptions");
assert(webSecurityRegisterShared.includes("maxDepthParam") && (webSecurityTools.match(/\.\.\.maxDepthParam\(/g) || []).length === 2 && webSecurityTools.includes("Maximum crawl depth; default 2, hard-capped at 5.") && webSecurityTools.includes("Maximum recursive directory depth when recursive is enabled; default 2, hard-capped at 5."), "maxDepth schema field must be consolidated without losing crawl/fuzz descriptions");
assert(webSecurityRegisterShared.includes("maxPagesParam") && (webSecurityTools.match(/\.\.\.maxPagesParam\(/g) || []).length === 1 && webSecurityTools.includes("Maximum pages/resources fetched; default 50, hard-capped at 500."), "maxPages schema field must be consolidated without losing crawl description");
assert(webSecurityRegisterShared.includes("maxTemplatesParam") && (webSecurityTools.match(/\.\.\.maxTemplatesParam\(/g) || []).length === 1 && webSecurityTools.includes("Maximum templates to run; default 100, hard-capped at 1000."), "maxTemplates schema field must be consolidated without losing template description");
for (const token of ["maxCases", "maxCandidates", "maxDepth", "maxPages", "maxTemplates"]) assert(webSecurityRegisterShared.includes(`${token}: Type.Optional(Type.Number({ description }))`), `${token} helper must preserve TypeBox Number shape`);
const generatedToolDocs = read("docs/generated/browser-tool-contract.generated.md");
for (const name of ["browser_http_replay", "browser_sqlmap_bridge", "browser_nuclei_bridge"]) {
	const row = generatedToolDocs.split(/\r?\n/).find((line) => line.startsWith(`| \`${name}\``)) || "";
	assert(row.includes("`requests`") && row.includes("`sequence`"), `${name} generated docs must retain requests and sequence parameters`);
}
for (const name of ["browser_fuzz_params", "browser_sqli_probe", "browser_template_check"]) {
	const row = generatedToolDocs.split(/\r?\n/).find((line) => line.startsWith(`| \`${name}\``)) || "";
	assert(!row.includes("`requests`") && !row.includes("`sequence`"), `${name} generated docs must not expose request sequence parameters`);
}
for (const name of ["browser_sqlmap_bridge", "browser_nuclei_bridge"]) {
	const row = generatedToolDocs.split(/\r?\n/).find((line) => line.startsWith(`| \`${name}\``)) || "";
	assert(row.includes("`timeoutSeconds`"), `${name} generated docs must retain timeoutSeconds parameter`);
}
for (const name of ["browser_recon_probe", "browser_crawl", "browser_fuzz_paths", "browser_fuzz_vhosts", "browser_sqli_probe", "browser_template_check", "browser_callback_oast", "browser_cookie_analyze", "browser_fuzz_params", "browser_http_replay"]) {
	const row = generatedToolDocs.split(/\r?\n/).find((line) => line.startsWith(`| \`${name}\``)) || "";
	assert(!row.includes("`timeoutSeconds`"), `${name} generated docs must not expose timeoutSeconds`);
}
for (const name of ["browser_recon_probe", "browser_fuzz_params", "browser_fuzz_paths", "browser_fuzz_vhosts", "browser_sqli_probe", "browser_template_check", "browser_nuclei_bridge", "browser_http_replay"]) {
	const row = generatedToolDocs.split(/\r?\n/).find((line) => line.startsWith(`| \`${name}\``)) || "";
	assert(row.includes("`followRedirects`") && row.includes("`maxRedirects`"), `${name} generated docs must retain redirect control parameters`);
}
for (const name of ["browser_crawl", "browser_sqlmap_bridge", "browser_callback_oast", "browser_cookie_analyze"]) {
	const row = generatedToolDocs.split(/\r?\n/).find((line) => line.startsWith(`| \`${name}\``)) || "";
	assert(!row.includes("`followRedirects`") && !row.includes("`maxRedirects`"), `${name} generated docs must not expose redirect control parameters`);
}
for (const name of ["browser_fuzz_params", "browser_fuzz_paths", "browser_fuzz_vhosts", "browser_sqli_probe", "browser_template_check", "browser_nuclei_bridge"]) {
	const row = generatedToolDocs.split(/\r?\n/).find((line) => line.startsWith(`| \`${name}\``)) || "";
	assert(row.includes("`rateLimitPerSecond`"), `${name} generated docs must retain rateLimitPerSecond parameter`);
}
for (const name of ["browser_recon_probe", "browser_crawl", "browser_http_replay", "browser_sqlmap_bridge", "browser_callback_oast", "browser_cookie_analyze"]) {
	const row = generatedToolDocs.split(/\r?\n/).find((line) => line.startsWith(`| \`${name}\``)) || "";
	assert(!row.includes("`rateLimitPerSecond`"), `${name} generated docs must not expose rateLimitPerSecond`);
}
for (const [name, params] of Object.entries({
	browser_crawl: ["maxDepth", "maxPages"],
	browser_fuzz_paths: ["maxDepth", "maxCandidates"],
	browser_fuzz_vhosts: ["maxCandidates"],
	browser_fuzz_params: ["maxCases"],
	browser_sqli_probe: ["maxCases"],
	browser_template_check: ["maxTemplates"],
})) {
	const row = generatedToolDocs.split(/\r?\n/).find((line) => line.startsWith(`| \`${name}\``)) || "";
	for (const param of params) assert(row.includes(`\`${param}\``), `${name} generated docs must retain ${param}`);
}
for (const [name, params] of Object.entries({
	browser_recon_probe: ["maxCases", "maxCandidates", "maxDepth", "maxPages", "maxTemplates"],
	browser_http_replay: ["maxCases", "maxCandidates", "maxDepth", "maxPages", "maxTemplates"],
	browser_sqlmap_bridge: ["maxCases", "maxCandidates", "maxDepth", "maxPages", "maxTemplates"],
	browser_nuclei_bridge: ["maxCases", "maxCandidates", "maxDepth", "maxPages", "maxTemplates"],
	browser_callback_oast: ["maxCases", "maxCandidates", "maxDepth", "maxPages", "maxTemplates"],
	browser_cookie_analyze: ["maxCases", "maxCandidates", "maxDepth", "maxPages", "maxTemplates"],
})) {
	const row = generatedToolDocs.split(/\r?\n/).find((line) => line.startsWith(`| \`${name}\``)) || "";
	for (const param of params) assert(!row.includes(`\`${param}\``), `${name} generated docs must not expose ${param}`);
}
assert((`${webSecurityTools}\n${webSecurityRegisterShared}`.match(/Bounded safe-regex or substring filter for HAR request URLs/g) || []).length >= 1 && (webSecurityTools.match(/\.\.\.harReplayParams\(/g) || []).length === 3, "HAR-consuming tools must document bounded harUrlPattern semantics through shared harReplayParams");
for (const forbiddenPhrase of ["risk-tier", "风险分级闸门", "安全收缩文案", "能力弱化默认值"]) {
	assert(!webSecurityTools.includes(forbiddenPhrase), `web security tool docs must not introduce tool-layer boundary shrink wording: ${forbiddenPhrase}`);
}
assert(read("src/tools/budgets.ts").includes("TOOL_RESULT_BUDGETS"), "tool result budgets must be table-driven");
assert(read("src/tools/webSecurity/shared/http.ts").includes('if (!buffer.length) return "0000000000000000"'), "simHash64 must special-case empty buffers to avoid fixed all-ones collisions");
const readme = read("README.md");
assert(readme.includes("src/tools/webSecurity/register") && readme.includes("src/tools/webSecurity/browserNative") && readme.includes("src/tools/webSecurity/bridges") && readme.includes("src/tools/webSecurity/shared"), "README must document the fixed single-package webSecurity layering");
assert(readme.includes("不在工具层增加能力弱化默认值、风险分级闸门或安全收缩文案"), "README must document the tool-layer boundary wording for webSecurity");
assert(readme.includes("activeGraphqlIntrospection:true") && readme.includes("小型内置 exposure/API baseline"), "README must document active GraphQL crawl and default template-check semantics");
const skill = read("D:/Pi/agent/skills/pi-browser-tools/SKILL.md");
assert(skill.includes("tabId") && skill.includes("browser_tabs list"), "skill must document explicit tabId automation flow");
assert(skill.includes("browser_pick") && skill.includes("browser_observe"), "skill must document pick/observe flows");
for (const removed of ["browser_query", "browser_click", "browser_type", "browser_dom_snapshot", "browser_dom_click", "browser_dom_type"]) assert(!skill.includes(removed), `skill must not document removed split action tool: ${removed}`);
assert(skill.includes("browser_download") && skill.includes("browser_upload"), "skill must document upload/download flows");
assert(skill.includes("browser_execute") && skill.includes("browser_hook") && skill.includes("browser_frame"), "skill must document raw-data and advanced browser tools");
assert(skill.includes("summary") && skill.includes("browser_artifact"), "skill must document summary/artifact flow");
assert(skill.includes("Rails AES-GCM encrypted cookies") && skill.includes("legacy Rails AES-CBC signed wrappers") && skill.includes("Rails direct-key signed cookies"), "skill must document Rails encrypted, legacy, and direct-key cookie support");
assert(skill.includes("activeGraphqlIntrospection") && skill.includes("small built-in exposure/API baseline"), "skill must document active GraphQL crawl and default template-check semantics");
assert(!skill.includes("npm run check") && !skill.includes("smoke:browser"), "skill must not contain project development validation flow");
console.log("tools contract ok");
