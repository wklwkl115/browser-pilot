import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const distillRecovery = path.join(root, "src", "distill-core", "recovery.ts");
const utilsErrors = path.join(root, "src", "utils", "errors.ts");
const abmlErrors = path.join(root, "src", "abml-core", "errors.ts");

assert(existsSync(distillRecovery), "K4 requires src/distill-core/recovery.ts as the recovery mechanism home");

const recoveryText = readFileSync(distillRecovery, "utf8");
for (const symbol of ["recoveryForNormalized", "mergeRecoveries", "uniqueRecoveryActions"]) {
	assert(recoveryText.includes(`export function ${symbol}`), `distill-core/recovery.ts must export ${symbol}`);
}

const utilsText = readFileSync(utilsErrors, "utf8");
assert(utilsText.includes("../distill-core/recovery.js"), "utils/errors.ts must compose recovery through distill-core/recovery.ts");
assert(!/function\s+(abmlRecoveryActions|websocketRecoveryActions|memoryRecoveryActions|mergeRecoveries|recoveryForNormalized|uniqueActions)\b/.test(utilsText), "utils/errors.ts must not re-declare recovery generation/merge mechanisms");
assert(!/const\s+(ABML_ERROR_CODES|WEBSOCKET_ERROR_CODES)\b/.test(utilsText), "utils/errors.ts must not own recovery code registries");

const abmlText = readFileSync(abmlErrors, "utf8");
assert(abmlText.includes("DEFAULT_RECOVERIES"), "abml-core/errors.ts may keep domain recovery data");
assert(!abmlText.includes("../distill-core/recovery"), "abml-core must not import the distill-core recovery mechanism");

const GRANDFATHERED_TEMPLATE_FILES = new Set([
	"src/abml-core/errors.ts",
	"src/abml-core/verbs/click.ts",
	"src/abml-core/verbs/frame.ts",
	"src/abml-core/verbs/pierce.ts",
	"src/abml-core/verbs/read.ts",
	"src/abml-core/verbs/router.ts",
	"src/abml-core/verbs/scroll.ts",
	"src/abml-core/verbs/type.ts",
	"src/abml/verbs/runtime.ts",
	"src/distill-core/ladder.ts",
	"src/distill-core/recovery.ts",
	"src/driver/BrowserBridgeCommandService.ts",
	"src/driver/BrowserWaitSupervisor.ts",
	"src/driver/errors.ts",
	"src/protocol/nativeErrorCodes.ts",
	"src/protocol/nativeProtocol.ts",
	"src/tools/artifactReader.ts",
	"src/tools/artifacts/reader.ts",
	"src/tools/memory/autoSurface.ts",
	"src/tools/observeRunners.ts",
	"src/tools/registerArtifactTool.ts",
	"src/tools/registerExecuteTool.ts",
	"src/tools/registerObserveTool.ts",
	"src/tools/registerScreenshotTool.ts",
	"src/tools/registerTabsTool.ts",
	"src/tools/resultMiddleware.ts",
	"src/tools/summaries/scan.ts",
	"src/tools/summaries/webSecurity.ts",
	"src/tools/summaries/webSecurity/bridges.ts",
	"src/tools/summaries/webSecurity/cookie.ts",
	"src/tools/summaries/webSecurity/crawl.ts",
	"src/tools/summaries/webSecurity/fuzz.ts",
	"src/tools/summaries/webSecurity/jsAst.ts",
	"src/tools/summaries/webSecurity/oast.ts",
	"src/tools/summaries/webSecurity/recon.ts",
	"src/tools/summaries/webSecurity/replay.ts",
	"src/tools/summaries/webSecurity/sqli.ts",
	"src/tools/summaries/webSecurity/template.ts",
	"src/tools/summaries/webSecurity/wasm.ts",
	"src/tools/summaries/webSecurity/wasmBridge.ts",
	"src/tools/summaries/webSecurity/ws.ts",
	"src/tools/webSecurity/browserNative/cookieAnalyze.ts",
	"src/tools/webSecurity/register/shared.ts",
	"src/tools/webSecurity/shared/diagnostics.ts",
	"src/utils/errors.ts",
]);

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.name.endsWith(".ts") || entry.name.endsWith(".mjs")) out.push(full);
	}
	return out;
}

const RECOVERY_TEMPLATE_RE = /nextActions\s*[:=]|recovery\s*[:=]\s*\{|recoveryCommands\s*[:=]|browser_(tabs|observe|artifact|network|wait|memory|command|download|upload)\s+(action=|mode=)|retry with|re-capture|re-run|fresh ABML ref|fresh resource URI/;
const srcFiles = walk(path.join(root, "src"));
const scatter = [];
for (const file of srcFiles) {
	const rel = path.relative(root, file).replace(/\\/g, "/");
	if (GRANDFATHERED_TEMPLATE_FILES.has(rel)) continue;
	const text = readFileSync(file, "utf8");
	if (RECOVERY_TEMPLATE_RE.test(text) && !text.includes("distill-core/recovery")) scatter.push(rel);
}
assert.deepEqual(scatter.sort(), [], "new recovery/nextActions templates must route through distill-core/recovery.ts or be explicitly grandfathered");

console.log(`recovery boundary ok — mechanism centralized, staged template baseline ${GRANDFATHERED_TEMPLATE_FILES.size} file(s)`);
