import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const stripBridgeSource = (text) => text
	.replace(/^\/\/ @ts-nocheck\r?\n/, "")
	.replace(/^import\s+[^;]+;\r?\n/gm, "")
	.replace(/^export\s+\{[^}]+\};\r?\n/gm, "")
	.replace(/^export const (?!__piBridgeModule_)([A-Za-z0-9_$]+)\s*=/gm, "const $1 =")
	.replace(/\s+as\s+any/g, "")
	.replace(/\r?\n\/\/ ESM module (?:boundary marker for TODO 189|metadata)\r?\nexport const __piBridgeModule_[\s\S]*?;\s*$/, "")
	.replace(/\r?\nexport \{\};\s*$/, "");
const transfer = stripBridgeSource(read("bridge_src/service_worker/transfer.ts"));
new Function(transformSync(transfer, { loader: "ts", target: "chrome120", sourcefile: "bridge_src/service_worker/transfer.ts" }).code);
assert(transfer.includes("chrome.downloads.download"), "transfer.download must use Chrome downloads API for direct URLs");
assert(transfer.includes("chrome.downloads.onCreated"), "transfer.download must listen for started downloads");
assert(transfer.includes("chrome.downloads.search"), "transfer.download must resolve completed filename/path");
assert(transfer.includes("piTransferMediaUrlScript"), "transfer.download media mode must extract media URL before download");
assert(transfer.includes("piTransferClickDownloadUrlScript"), "transfer.download click mode must extract direct URLs before click fallback");
assert(transfer.includes("Page.downloadWillBegin"), "transfer.download click mode must correlate downloads with tab-scoped CDP events");
assert(transfer.includes("matchStrategy"), "transfer.download click mode must report download matching strategy");
assert(transfer.includes("AMBIGUOUS_DOWNLOAD") && transfer.includes("piTransferAmbiguousDownload"), "transfer.download click fallback must report ambiguous when no precise tab event match exists");
assert(!transfer.includes("global-created-fallback") && !transfer.includes("Promise.race([pageDownload"), "transfer.download click fallback must not accept global download events before tab/CDP matching");
assert(transfer.includes("piTransferDownloadWithOptions(options, timeoutMs, 'media'"), "transfer.download media mode must use Chrome downloads API for stable path return");
assert(transfer.includes("piTransferNormalizeDownloadMode"), "transfer.download must validate mode in the bridge layer");
assert(!transfer.includes("msg.mode === 'media' ? 'media' : 'click'"), "transfer.download must not silently downgrade unknown page modes to click");
assert(transfer.includes("Page.setInterceptFileChooserDialog"), "transfer.upload must intercept file choosers");
assert(transfer.includes("Page.fileChooserOpened"), "transfer.upload must wait for file chooser event");
assert(transfer.includes("DOM.setFileInputFiles"), "transfer.upload must set local files through CDP");
assert(transfer.includes("Allow access to file URLs"), "transfer.upload must return file access guidance");

const tool = read("src/tools/registerTransferTools.ts");
const validation = read("src/tools/transferValidation.ts");
assert(tool.includes("browser_download"), "browser_download tool missing");
assert(tool.includes("browser_upload"), "browser_upload tool missing");
assert(tool.includes("requireUploadConfirmation"), "browser_upload must require explicit confirmation");
assert(validation.includes("confirm !== true"), "browser_upload confirmation gate must stay pure/testable");
assert(validation.includes("UPLOAD_REQUIRES_BROWSER_UPLOAD"), "browser_command must not bypass browser_upload validation");
assert(read("src/tools/registerCommandTool.ts").includes("rejectUnsafeExecuteCommand"), "browser_command must block unsafe transfer.upload bridge commands");
assert(validation.includes("path.isAbsolute"), "browser_upload must require absolute paths");
assert(validation.includes("await stat(file)"), "browser_upload must validate files exist before browser command");
assert(validation.includes("buildTransferDownloadCommand"), "download command builder must be testable");
assert(validation.includes("normalizeTransferDownloadMode"), "download mode normalization must be pure/testable in the tool layer");
assert(validation.includes("url target only accepts mode:url") && validation.includes("selector target only accepts mode:click"), "download mode validation must reject target/mode conflicts");
assert(tool.indexOf("const command = buildTransferDownloadCommand(params);") < tool.indexOf("const server = await ensureStarted();"), "browser_download must validate and normalize mode before starting the bridge");
assert(tool.includes("summarizeTransferData"), "transfer tools must use compact summaries");
assert(!tool.includes("distilledJsonResult(result.data ?? result") && !tool.includes("artifactValue: result.data ?? result"), "transfer tools must preserve the full BrowserBridgeExecutionResult envelope as the primary/artifact value");
assert((tool.includes("distilledJsonResult(result,") || tool.includes("jsonToolResult(result,")) && tool.includes("artifactValue: result"), "transfer tools must pass full bridge result metadata through distillation");

const manifest = JSON.parse(read("bridge/pi_browser_bridge/manifest.json"));
assert(manifest.permissions.includes("downloads"), "manifest must include downloads permission");
const schema = JSON.parse(read("bridge/native_command_schema.json"));
assert(schema.domains.transfer.includes("transfer.download"), "schema missing transfer.download");
assert(schema.domains.transfer.includes("transfer.upload"), "schema missing transfer.upload");
console.log("transfer tools contract ok");
