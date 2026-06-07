import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Compile } from "typebox/compile";
import { strictToolParameters } from "../../../src/tools/toolShared.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

const strictExample = strictToolParameters({ url: { type: "string" } });
assert.equal(strictExample.additionalProperties, false, "strictToolParameters must set additionalProperties:false");

const schema = strictToolParameters({
	flag: { type: "boolean" },
	count: { type: "number" },
	mode: { anyOf: [{ const: "scan", type: "string" }, { const: "html", type: "string" }] },
});
const validator = Compile(schema);
assert.equal(validator.Check({ flag: true, count: 30, mode: "scan" }), true, "strict tool schema must accept valid values");
assert.equal(validator.Check({ flag: true, count: 30, mode: "scan", bogusField: 1 }), false, "additionalProperties:false must reject unknown top-level fields");
assert.equal(validator.Check({ flag: true, count: 30, mode: "bogus" }), false, "Literal-style enum unions must reject invalid values");

const shared = read("src/tools/webSecurity/register/shared.ts");
assert(shared.includes("webSecurityCookieModeParam") && shared.includes("webSecurityDefaultSchemeParam") && shared.includes("fuzzLocationParam") && shared.includes("sqliProbeTypesParam"), "shared WebSecurity register helpers must centralize enum params");

const registerFuzz = read("src/tools/webSecurity/register/registerFuzz.ts");
assert(registerFuzz.includes("baselineStrategy: enumParam([\"exact\", \"cluster\", \"auto\"]"), "browser_fuzz baselineStrategy must be a strict enum");
assert(registerFuzz.includes("sniMode: enumParam([\"target\", \"host\", \"custom\", \"none\"]"), "browser_fuzz sniMode must be a strict enum");
assert(registerFuzz.includes("locations: fuzzLocationParam("), "browser_fuzz locations must be a strict enum-or-array param");

const registerSqli = read("src/tools/webSecurity/register/registerSqli.ts");
assert(registerSqli.includes("probeTypes: sqliProbeTypesParam("), "browser_sqli probeTypes must be a strict enum-or-array param");
assert(registerSqli.includes("payloadMode: enumParam([\"append\", \"replace\"]"), "browser_sqli payloadMode must be a strict enum");
assert(registerSqli.includes("locations: fuzzLocationParam("), "browser_sqli locations must be a strict enum-or-array param");
assert(registerSqli.includes("validateOptionalParams(HttpRequestSchema, current.request)") && registerSqli.includes("validateOptionalParams(FuzzMutationsSchema, current.mutations)"), "browser_sqli must validate request and mutations through existing Zod schemas");

const registerCrawl = read("src/tools/webSecurity/register/registerCrawl.ts");
assert(registerCrawl.includes("knownFiles: enumParam([\"none\", \"robotstxt\", \"sitemapxml\", \"all\"]"), "browser_crawl knownFiles must be a strict enum");
assert.equal(registerCrawl.includes("defaultScheme: webSecurityDefaultSchemeParam("), false, "browser_crawl defaultScheme is mechanical and must not be advertised");
assert.equal(registerCrawl.includes("validateOptionalParams("), false, "browser_crawl should not invent complex-object Zod validation when no real gap exists");

const registerTemplate = read("src/tools/webSecurity/register/registerTemplate.ts");
const registerHttpReplay = read("src/tools/webSecurity/register/registerHttpReplay.ts");
assert.equal(registerTemplate.includes("defaultScheme: webSecurityDefaultSchemeParam("), false, "browser_template defaultScheme is mechanical and must not be advertised");
assert.equal(registerHttpReplay.includes("defaultScheme: webSecurityDefaultSchemeParam("), false, "browser_http_replay defaultScheme is mechanical and must not be advertised");

const prepareArguments = read("src/tools/prepareArguments.ts");
for (const deprecated of ["defaultScheme", "maxBodyBytes", "rateLimitPerSecond", "timeoutSeconds", "cookieMode"]) {
	assert(prepareArguments.includes(`"${deprecated}"`), `prepareArguments must tolerate deprecated mechanical WebSecurity param ${deprecated}`);
}

for (const file of [
	"src/tools/registerCommandTool.ts",
	"src/tools/registerObserveTool.ts",
	"src/tools/registerTabsTool.ts",
	"src/tools/registerArtifactTool.ts",
	"src/tools/registerExecuteTool.ts",
	"src/tools/registerPickTool.ts",
	"src/tools/registerTransferTools.ts",
	"src/tools/registerEvidenceTool.ts",
	"src/tools/registerNativeActionTools.ts",
	"src/tools/registerScreenshotTool.ts",
	"src/tools/webSecurity/register/registerFuzz.ts",
	"src/tools/webSecurity/register/registerSqli.ts",
	"src/tools/webSecurity/register/registerHttpReplay.ts",
	"src/tools/webSecurity/register/registerTemplate.ts",
	"src/tools/webSecurity/register/registerCrawl.ts",
	"src/tools/webSecurity/register/registerCookieAnalyze.ts",
	"src/tools/webSecurity/register/registerCallbackOast.ts",
]) {
	assert(read(file).includes("strictToolParameters("), `${file} must use strictToolParameters for top-level parameter contracts`);
}

console.log("tool parameter contract ok");
