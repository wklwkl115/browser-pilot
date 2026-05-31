import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { webSecurityToolError } from "../../../src/tools/webSecurity/shared/diagnostics.ts";
import { buildReplayRequest, parseRawHttpRequest, runBrowserCrawl, runCallbackOast, runCookieAnalyze, runFuzzParams, runFuzzPaths, runFuzzVhosts, runHttpReplay, runNucleiBridge, runReconProbe, runSqlmapBridge, runSqliProbe, runTemplateCheck } from "../../../src/tools/webSecurityCore.ts";

const expectedWebSecurityRegisterExports = [
	"registerCallbackOastTool",
	"registerCookieAnalyzeTool",
	"registerCrawlTool",
	"registerFuzzTool",
	"registerHttpReplayTool",
	"registerSqliTool",
	"registerTemplateTool",
];

async function checkWebSecurityRegisterFacadeFiles() {
	const registerDir = new URL("../../../src/tools/webSecurity/register/", import.meta.url);
	const files = (await readdir(registerDir)).filter((file) => file.endsWith(".ts")).sort();
	for (const required of ["index.ts", "shared.ts", "registerCallbackOast.ts", "registerCookieAnalyze.ts", "registerCrawl.ts", "registerFuzz.ts", "registerHttpReplay.ts", "registerSqli.ts", "registerTemplate.ts"]) {
		assert.ok(files.includes(required), `webSecurity register layer missing ${required}`);
	}
	const facade = await readFile(new URL("../../../src/tools/registerWebSecurityTools.ts", import.meta.url), "utf8");
	assert.ok(facade.includes('from "./webSecurity/register/index"') || facade.includes('from "./webSecurity/register/index.js"'), "registerWebSecurityTools.ts must be a facade over webSecurity/register/index");
	assert.ok(facade.split(/\r?\n/).length <= 20, "registerWebSecurityTools.ts facade must stay thin");
	const index = await readFile(new URL("../../../src/tools/webSecurity/register/index.ts", import.meta.url), "utf8");
	for (const exportName of expectedWebSecurityRegisterExports) assert.ok(index.includes(`export { ${exportName} }`), `register index must export ${exportName}`);
	const shared = await readFile(new URL("../../../src/tools/webSecurity/register/shared.ts", import.meta.url), "utf8");
	const diagnostics = await readFile(new URL("../../../src/tools/webSecurity/shared/diagnostics.ts", import.meta.url), "utf8");
	assert.ok(shared.includes("runWebSecurityToolAdapter") && shared.includes("createBrowserCookieProvider") && shared.includes("executeWebSecurityToolShell = runWebSecurityTool") && shared.includes('cmd: "cookies"'), "webSecurity shared shell must centralize adapter routing, cookie binding, and the compatibility alias");
	assert.ok(shared.includes("validateCrawlParams") && shared.includes("validateFuzzParams") && shared.includes("validateSqliParams") && shared.includes("validateTemplateParams") && shared.includes("validateOastParams") && shared.includes("validateHttpReplayParams"), "webSecurity shared shell must centralize runtime validation helpers");
	assert.ok(shared.includes("webSecurityToolError") && shared.includes("error: { map: (error) => webSecurityToolError"), "webSecurity shared shell must wrap tool failures before generic formatting");
	assert.ok(diagnostics.includes('domain: "webSecurity"') && diagnostics.includes("redactWebSecurityDiagnosticValue") && diagnostics.includes("suppressErrorStack"), "webSecurity diagnostics helper must create a domain envelope, redact sensitive details, and suppress stacks");
}

await checkWebSecurityRegisterFacadeFiles();

async function checkWebSecurityDomainBoundaryContract() {
	const sourceFiles = {
		registerShared: await readFile(new URL("../../../src/tools/webSecurity/register/shared.ts", import.meta.url), "utf8"),
		diagnostics: await readFile(new URL("../../../src/tools/webSecurity/shared/diagnostics.ts", import.meta.url), "utf8"),
		core: await readFile(new URL("../../../src/tools/webSecurityCore.ts", import.meta.url), "utf8"),
		toolRegistry: await readFile(new URL("../../../src/tools/toolRegistry.ts", import.meta.url), "utf8"),
	};
	const activeRegisterFiles = ["registerCallbackOast.ts", "registerCookieAnalyze.ts", "registerCrawl.ts", "registerFuzz.ts", "registerHttpReplay.ts", "registerSqli.ts", "registerTemplate.ts"];
	for (const file of activeRegisterFiles) {
		const text = await readFile(new URL(`../../../src/tools/webSecurity/register/${file}`, import.meta.url), "utf8");
		assert.ok(text.includes("executeWebSecurityToolShell(ensureStarted"), `${file} must execute through the shared WebSecurity shell`);
		assert.ok(/normalizeWebSecurityToolParams<|normalizeWebSecurityToolParams\(/.test(text), `${file} must normalize loose tool params before execution`);
		if (/registerCrawl|registerFuzz|registerHttpReplay|registerSqli|registerTemplate|registerCallbackOast/.test(file)) assert.ok(/validate[A-Za-z]+Params\(/.test(text), `${file} must apply shared runtime validation before execution`);
		assert.equal(/server\.sendCommand|server\.executeJavaScript|BrowserBridgeServer|bridge_src|chrome\./.test(text), false, `${file} must not call base browser driver/runtime directly`);
		assert.equal(text.includes("browserCookiesToHeader"), false, `${file} must not own cookie binding; shared shell owns cookie provider`);
	}
	assert.equal((sourceFiles.registerShared.match(/cmd: "cookies"/g) || []).length, 1, "only WebSecurity shared shell may call native cookies command");
	assert.ok(sourceFiles.registerShared.includes("createBrowserCookieProvider") && sourceFiles.registerShared.includes("browserCookiesToHeader"), "shared shell must expose cookie binding through a CookieProvider adapter");
	assert.equal(/pi\.registerTool\(/.test(sourceFiles.core), false, "webSecurityCore must not register tools");
	assert.equal(/BrowserBridgeServer|ensureStarted|server\.sendCommand|bridge_src|chrome\./.test(sourceFiles.core), false, "webSecurityCore must not depend on base browser driver/runtime");
	assert.ok(sourceFiles.core.includes("./webSecurity/browserNative/") && sourceFiles.core.includes("./webSecurity/bridges/") && sourceFiles.core.includes("./webSecurity/shared/"), "webSecurityCore must stay a compatibility export layer over WebSecurity subdomains");
	const webSecurityRegistryBlock = /export const WEB_SECURITY_TOOL_REGISTRARS:[\s\S]*?= \[([\s\S]*?)\];/.exec(sourceFiles.toolRegistry)?.[1] || "";
	assert.equal((webSecurityRegistryBlock.match(/register[A-Za-z]+Tool/g) || []).filter((line) => /Crawl|Fuzz|Sqli|Template|Callback|Cookie|Http/.test(line)).length, 7, "toolRegistry must compose exactly the 7 explicit WebSecurity tool registrations");
	assert.ok(sourceFiles.toolRegistry.includes("WEB_SECURITY_TOOL_REGISTRARS") && sourceFiles.toolRegistry.includes("resolveBrowserToolRegistrars"), "toolRegistry must expose the WebSecurity registrar group and resolver");
	assert.ok(sourceFiles.registerShared.includes("webSecurityToolError(error") && sourceFiles.diagnostics.includes("WebSecurityToolError"), "shared shell must delegate failure envelope creation to WebSecurity diagnostics");
	assert.ok(sourceFiles.diagnostics.includes("...(normalized.recovery ? { recovery: normalized.recovery } : {})"), "webSecurity diagnostics must preserve structured recovery in the domain envelope");
	const sensitive = new Error("Authorization: Bearer secret\nCookie: sid=abc");
	sensitive.name = "FixtureSensitiveError";
	sensitive.details = { Cookie: "sid=abc", nested: { authorization: "Bearer secret", safe: "kept" }, stack: "hidden" };
	const wrapped = webSecurityToolError(sensitive, {
		toolName: "browser_http_replay",
		command: "web.http_replay",
	});
	const wrappedText = JSON.stringify({ name: wrapped.name, message: wrapped.message, code: wrapped.code, details: wrapped.details });
	assert.equal(wrappedText.includes("sid=abc"), false, "WebSecurity failure envelope must redact cookie values");
	assert.equal(wrappedText.includes("Bearer secret"), false, "WebSecurity failure envelope must redact authorization values");
	assert.equal(wrappedText.includes("stack"), false, "WebSecurity failure envelope must strip stack traces from details");
	assert.equal(Object.hasOwn(wrapped, "stack") && wrapped.stack !== undefined, false, "WebSecurity failure envelope must suppress Error.stack");
	assert.ok(wrappedText.includes("webSecurity") && wrappedText.includes("browser_http_replay") && wrappedText.includes("web.http_replay"), "WebSecurity failure envelope must include domain/tool/command diagnostics");
}

await checkWebSecurityDomainBoundaryContract();

assert.equal(typeof buildReplayRequest, "function");
assert.equal(typeof parseRawHttpRequest, "function");
assert.equal(typeof runReconProbe, "function");
assert.equal(typeof runBrowserCrawl, "function");
assert.equal(typeof runFuzzPaths, "function");
assert.equal(typeof runFuzzVhosts, "function");
assert.equal(typeof runFuzzParams, "function");
assert.equal(typeof runSqliProbe, "function");
assert.equal(typeof runSqlmapBridge, "function");
assert.equal(typeof runNucleiBridge, "function");
assert.equal(typeof runTemplateCheck, "function");
assert.equal(typeof runCallbackOast, "function");
assert.equal(typeof runCookieAnalyze, "function");
assert.equal(typeof runHttpReplay, "function");

console.log("web security contract ok");
