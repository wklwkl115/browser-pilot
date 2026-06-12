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

// Each group below is annotated with WHY it is grandfathered instead of routing through
// distill-core/recovery.ts. The list may only shrink, never grow (enforced by the contract).
// Full burn-down is opportunistic (tied to tool edits); see docs/debt-clearance-plan.md D4.
const GRANDFATHERED_TEMPLATE_FILES = new Set([
	// ABML domain: DEFAULT_RECOVERIES + verb-specific error guidance that depends on ABML
	// action semantics (scroll, click, type, read, pierce) — not expressible via the generic
	// recovery vocabulary; abml-core must not import distill-core (kernel purity rule).
	"src/abml-core/errors.ts",
	"src/abml-core/verbs/click.ts",
	"src/abml-core/verbs/frame.ts",
	"src/abml-core/verbs/pierce.ts",
	"src/abml-core/verbs/read.ts",
	"src/abml-core/verbs/router.ts",
	"src/abml-core/verbs/scroll.ts",
	"src/abml-core/verbs/type.ts",
	"src/abml/verbs/runtime.ts",
	// distill-core itself: recovery.ts is the mechanism; ladder.ts is a regex false-positive
	// (nextActions appears as a passthrough field — `out.nextActions?.slice(0, 2)` — not as
	// a template builder; the type definition `nextActions?: string[]` also matches).
	"src/distill-core/ladder.ts",
	"src/distill-core/recovery.ts",
	// driver layer: extension-connection recovery (BrowserBridgeCommandService is a regex
	// false-positive — "re-running browser_tabs list" is a code comment, not a template);
	// BrowserWaitSupervisor builds recoveryCommands with dynamic waitId context; errors.ts
	// builds nextActions for BROWSER_NOT_FOUND/extension-not-installed — extension-specific.
	"src/driver/BrowserBridgeCommandService.ts",
	"src/driver/BrowserWaitSupervisor.ts",
	"src/driver/errors.ts",
	// protocol layer: "re-capture" appears in embedded recovery text inside RESOURCE_STALE
	// error-code definitions — protocol SSOT data, not a code template.
	"src/protocol/nativeErrorCodes.ts",
	"src/protocol/nativeProtocol.ts",
	// tool layer (real recovery templates with call-site context):
	// artifactReader.ts — recovery with dynamic artifact path context.
	// memory/autoSurface.ts — browser_memory action=recall with dynamic scopeKind context.
	// observe/baseline.ts — baseline recovery with dynamic snapshotId/artifact path context.
	// observe/scanRunner.ts — nextActions containing the live snapshotId for re-observe flows.
	// registerTabsTool.ts — nextActions for snapshot expiry with dynamic snapshotId + CLI paths.
	// registerObserveTool.ts — "browser_observe mode=..." in error messages / tool guidelines.
	"src/tools/artifactReader.ts",
	"src/tools/memory/autoSurface.ts",
	"src/tools/observe/baseline.ts",
	"src/tools/observe/scanRunner.ts",
	"src/tools/registerObserveTool.ts",
	"src/tools/registerTabsTool.ts",
	// tool layer (regex false-positives — no recovery template built, just description text
	// in promptGuidelines / error messages / nextActions passthrough):
	// registerArtifactTool.ts — "Use browser_artifact..." is promptGuidelines (tool description).
	// registerExecuteTool.ts — "browser_execute only accepts..." is a validation error message.
	// registerScreenshotTool.ts — "Use browser_screenshot..." is promptGuidelines.
	// resultMiddleware.ts — nextActions: normalizedNextActions(...) is a passthrough call, not
	//   a template builder; it assembles the output of upstream generators.
	"src/tools/registerArtifactTool.ts",
	"src/tools/registerExecuteTool.ts",
	"src/tools/registerScreenshotTool.ts",
	"src/tools/resultMiddleware.ts",
	// webSecurity domain summaries: all have real nextActions for web-security workflows
	// (sqlmap options, nuclei templates, OAST callbacks, WAF hints, etc.) — domain-specific
	// vocabulary that belongs with the tool knowledge, not the generic error recovery.
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
	// utils/errors.ts — the public error-normalization layer; it composes through recovery.ts
	// but also builds recovery from taxonomy metadata and is grandfathered as the composing
	// boundary (already routes through distill-core/recovery, but the regex still matches
	// the nextActions assembly code).
	"src/utils/errors.ts",
	// Removed from this list (D4 ratchet, 2026-06-10):
	//   src/tools/summaries/scan.ts — regex does not match current source
	//   src/tools/summaries/webSecurity.ts — regex does not match current source
	//   src/tools/webSecurity/shared/diagnostics.ts — regex does not match current source
	//   src/tools/artifacts/reader.ts — file no longer exists
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
