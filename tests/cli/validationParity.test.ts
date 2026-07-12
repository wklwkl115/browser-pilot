import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { collectCommandDefs } from "../../src/apps/cli/registry.ts";
import { validateDaemonCommandArguments } from "../../src/apps/daemon/server.ts";
import { validateBrowserCommandArguments } from "../../src/commands/commandValidation.ts";
import type { BrowserCommandDefinition } from "../../src/commands/commandDefinition.ts";

type CorpusCase = {
	name: string;
	command: string;
	args: Record<string, unknown>;
	valid: boolean;
	code?: string;
};

const corpus: CorpusCase[] = [
	{ name: "execute script", command: "browser_execute", args: { script: "document.title" }, valid: true },
	{ name: "execute program", command: "browser_execute", args: { program: [{ wait: 1 }] }, valid: true },
	{ name: "execute missing input", command: "browser_execute", args: {}, valid: false, code: "EXECUTE_EXACTLY_ONE_INPUT" },
	{ name: "execute both inputs", command: "browser_execute", args: { script: "1", program: [{ wait: 1 }] }, valid: false, code: "EXECUTE_EXACTLY_ONE_INPUT" },
	{ name: "execute empty script", command: "browser_execute", args: { script: "" }, valid: false, code: "EXECUTE_EXACTLY_ONE_INPUT" },
	{ name: "execute empty program", command: "browser_execute", args: { program: [] }, valid: false, code: "EXECUTE_EXACTLY_ONE_INPUT" },
	{ name: "execute oversized program", command: "browser_execute", args: { program: Array.from({ length: 61 }, () => ({ wait: 1 })) }, valid: false, code: "EXECUTE_PROGRAM_TOO_LARGE" },
	{ name: "execute ambiguous frame", command: "browser_execute", args: { program: [{ wait: 1, eval: "1" }] }, valid: false, code: "EXECUTE_PROGRAM_INVALID" },
	{ name: "execute command-shaped script", command: "browser_execute", args: { script: "{\"cmd\":\"tabs\"}" }, valid: false, code: "EXECUTE_COMMAND_SHAPED_SCRIPT" },
	{ name: "execute daemon JSON does not coerce tab id", command: "browser_execute", args: { script: "1", tabId: true }, valid: false, code: "SCHEMA_VALIDATION_FAILED" },
	{ name: "execute unknown", command: "browser_execute", args: { script: "1", typo: true }, valid: false, code: "UNKNOWN_ARGUMENT" },
	{ name: "execute removed", command: "browser_execute", args: { script: "1", monitor: true }, valid: false, code: "REMOVED_ARGUMENT" },
	{ name: "execute internal", command: "browser_execute", args: { script: "1", operationId: "op" }, valid: false, code: "INTERNAL_ARGUMENT" },

	{ name: "observe canonical", command: "browser_observe", args: {}, valid: true },
	{ name: "observe canonical url", command: "browser_observe", args: { url: "https://example.test" }, valid: true },
	{ name: "observe canonical diff", command: "browser_observe", args: { diff: true }, valid: true },
	{ name: "observe canonical baseline", command: "browser_observe", args: { baselineSnapshotId: "snap-1" }, valid: true },
	{ name: "observe content selector", command: "browser_observe", args: { mode: "content", selector: "main" }, valid: true },
	{ name: "observe html mode", command: "browser_observe", args: { mode: "html", selector: "main", htmlMode: "outer" }, valid: true },
	{ name: "observe text fresh", command: "browser_observe", args: { mode: "text", fresh: true }, valid: true },
	{ name: "observe tabs", command: "browser_observe", args: { mode: "tabs" }, valid: true },
	{ name: "observe explicit scan diff", command: "browser_observe", args: { mode: "scan", diff: true }, valid: false, code: "OBSERVE_ARGUMENT_CONFLICT" },
	{ name: "observe explicit scan baseline", command: "browser_observe", args: { mode: "scan", baselineSnapshotId: "snap" }, valid: false, code: "OBSERVE_ARGUMENT_CONFLICT" },
	{ name: "observe canonical selector", command: "browser_observe", args: { selector: "main" }, valid: false, code: "OBSERVE_ARGUMENT_CONFLICT" },
	{ name: "observe tabs url", command: "browser_observe", args: { mode: "tabs", url: "https://example.test" }, valid: false, code: "OBSERVE_ARGUMENT_CONFLICT" },
	{ name: "observe fresh baseline", command: "browser_observe", args: { fresh: true, baselinePath: "prior.json" }, valid: false, code: "OBSERVE_ARGUMENT_CONFLICT" },
	{ name: "observe fresh diff", command: "browser_observe", args: { fresh: true, diff: true }, valid: false, code: "OBSERVE_ARGUMENT_CONFLICT" },
	{ name: "observe multiple baselines", command: "browser_observe", args: { baselineSnapshotId: "snap", baselinePath: "prior.json" }, valid: false, code: "OBSERVE_BASELINE_CONFLICT" },
	{ name: "observe diff explicit baseline", command: "browser_observe", args: { diff: true, baselineSnapshotId: "snap" }, valid: false, code: "OBSERVE_DIFF_BASELINE_CONFLICT" },
	{ name: "observe content diff", command: "browser_observe", args: { mode: "content", diff: true }, valid: false, code: "OBSERVE_ARGUMENT_CONFLICT" },
	{ name: "observe content readability", command: "browser_observe", args: { mode: "content", readability: true }, valid: false, code: "OBSERVE_ARGUMENT_CONFLICT" },
	{ name: "observe readability aliases", command: "browser_observe", args: { content: "readability", readability: true }, valid: false, code: "OBSERVE_ADDON_CONFLICT" },
	{ name: "observe diagnostics aliases", command: "browser_observe", args: { diagnostics: "axe", axe: true }, valid: false, code: "OBSERVE_ADDON_CONFLICT" },
	{ name: "observe unknown", command: "browser_observe", args: { typo: true }, valid: false, code: "UNKNOWN_ARGUMENT" },
	{ name: "observe internal", command: "browser_observe", args: { modeExplicit: true }, valid: false, code: "INTERNAL_ARGUMENT" },
	{ name: "observe removed", command: "browser_observe", args: { maxChars: 1000 }, valid: false, code: "REMOVED_ARGUMENT" },

	{ name: "artifact text", command: "browser_artifact", args: { path: "artifact.json" }, valid: true },
	{ name: "artifact json path", command: "browser_artifact", args: { path: "artifact.json", jsonPath: "data.items" }, valid: true },
	{ name: "artifact pick", command: "browser_artifact", args: { path: "artifact.json", pick: ["data", "summary"] }, valid: true },
	{ name: "artifact search", command: "browser_artifact", args: { path: "artifact.json", mode: "search", query: "needle" }, valid: true },
	{ name: "artifact multi paths", command: "browser_artifact", args: { paths: ["a.json"], mode: "search", query: "needle" }, valid: true },
	{ name: "artifact root inferred search", command: "browser_artifact", args: { root: "runs", query: "needle" }, valid: true },
	{ name: "artifact inspect", command: "browser_artifact", args: { path: "artifact.json", mode: "inspect" }, valid: true },
	{ name: "artifact empty", command: "browser_artifact", args: {}, valid: false, code: "ARTIFACT_TARGET_REQUIRED" },
	{ name: "artifact query no target", command: "browser_artifact", args: { query: "needle" }, valid: false, code: "ARTIFACT_TARGET_REQUIRED" },
	{ name: "artifact search no query", command: "browser_artifact", args: { path: "artifact.json", mode: "search" }, valid: false, code: "ARTIFACT_SEARCH_QUERY_REQUIRED" },
	{ name: "artifact target conflict", command: "browser_artifact", args: { path: "a.json", root: "runs", query: "x" }, valid: false, code: "ARTIFACT_TARGET_CONFLICT" },
	{ name: "artifact multi wrong mode", command: "browser_artifact", args: { paths: ["a.json"], mode: "text", query: "x" }, valid: false, code: "ARTIFACT_MULTI_SEARCH_MODE_INVALID" },
	{ name: "artifact query wrong mode", command: "browser_artifact", args: { path: "a.json", mode: "json", query: "x" }, valid: false, code: "ARTIFACT_QUERY_REQUIRES_SEARCH_MODE" },
	{ name: "artifact json wrong mode", command: "browser_artifact", args: { path: "a.json", mode: "text", jsonPath: "data" }, valid: false, code: "ARTIFACT_JSON_MODE_REQUIRED" },
	{ name: "artifact json target conflict", command: "browser_artifact", args: { path: "a.json", jsonPath: "data", pick: ["summary"] }, valid: false, code: "ARTIFACT_JSON_TARGET_CONFLICT" },
	{ name: "artifact unknown", command: "browser_artifact", args: { path: "a.json", target: "data" }, valid: false, code: "UNKNOWN_ARGUMENT" },

	{ name: "network capture reload", command: "browser_network", args: { action: "captureReload" }, valid: true },
	{ name: "network start", command: "browser_network", args: { action: "start" }, valid: true },
	{ name: "network export har", command: "browser_network", args: { action: "exportHar" }, valid: true },
	{ name: "network export alias", command: "browser_network", args: { action: "export" }, valid: false, code: "ACTION_UNKNOWN" },
	{ name: "network capture alias", command: "browser_network", args: { action: "capture" }, valid: false, code: "ACTION_UNKNOWN" },
	{ name: "hook install targets", command: "browser_hook", args: { action: "installTargets", targets: ["fetch"] }, valid: true },
	{ name: "hook install targets missing", command: "browser_hook", args: { action: "installTargets" }, valid: false, code: "ACTION_ARGUMENT_REQUIRED" },
	{ name: "hook evaluate", command: "browser_hook", args: { action: "evaluate", expression: "1" }, valid: true },
	{ name: "hook evaluate missing", command: "browser_hook", args: { action: "evaluate" }, valid: false, code: "ACTION_ARGUMENT_REQUIRED" },
	{ name: "hook unrelated top argument", command: "browser_hook", args: { action: "listTargets", expression: "1" }, valid: false, code: "ACTION_ARGUMENT_NOT_ALLOWED" },
	{ name: "frame evaluate", command: "browser_frame", args: { action: "evaluate", frameId: "f", expression: "1" }, valid: true },
	{ name: "frame evaluate missing", command: "browser_frame", args: { action: "evaluate", frameId: "f" }, valid: false, code: "ACTION_ARGUMENT_REQUIRED" },

	{ name: "tabs list", command: "browser_tabs", args: { action: "list" }, valid: true },
	{ name: "tabs create", command: "browser_tabs", args: { action: "create", url: "about:blank" }, valid: true },
	{ name: "tabs switch", command: "browser_tabs", args: { action: "switch", targetRef: "tabh_browser_id_g1" }, valid: true },
	{ name: "tabs unknown", command: "browser_tabs", args: { action: "activate" }, valid: false, code: "TABS_ACTION_UNKNOWN" },
	{ name: "tabs legacy select alias", command: "browser_tabs", args: { action: "select", browserId: "b" }, valid: false, code: "TABS_ACTION_UNKNOWN" },
	{ name: "tabs removed browser session override", command: "browser_tabs", args: { action: "list", browserSessionId: "session-old" }, valid: false, code: "REMOVED_ARGUMENT" },
	{ name: "tabs target conflict", command: "browser_tabs", args: { action: "switch", targetRef: "tab", tabId: 1 }, valid: false, code: "TARGET_ARGUMENT_CONFLICT" },
	{ name: "tabs unsafe url", command: "browser_tabs", args: { action: "create", url: "javascript:alert(1)" }, valid: false, code: "INVALID_TAB_URL" },
	{ name: "tabs snapshot option", command: "browser_tabs", args: { action: "snapshot", allowExpired: true }, valid: false, code: "TABS_SNAPSHOT_OPTION_CONFLICT" },
	{ name: "tabs irrelevant url", command: "browser_tabs", args: { action: "list", url: "https://example.test" }, valid: false, code: "TABS_ARGUMENT_NOT_ALLOWED" },
	{ name: "tabs select browser missing", command: "browser_tabs", args: { action: "selectBrowser" }, valid: false, code: "TABS_BROWSER_ID_REQUIRED" },

	{ name: "download url", command: "browser_download", args: { url: "https://example.test/a" }, valid: true },
	{ name: "download selector", command: "browser_download", args: { selector: "a.download" }, valid: true },
	{ name: "download missing", command: "browser_download", args: {}, valid: false, code: "DOWNLOAD_TARGET_REQUIRED" },
	{ name: "download target conflict", command: "browser_download", args: { url: "https://example.test/a", selector: "a" }, valid: false, code: "DOWNLOAD_TARGET_CONFLICT" },
	{ name: "download mode conflict", command: "browser_download", args: { url: "https://example.test/a", mode: "click" }, valid: false, code: "DOWNLOAD_MODE_TARGET_CONFLICT" },
	{ name: "upload valid shape", command: "browser_upload", args: { selector: "input[type=file]", files: ["C:\\tmp\\a.txt"], confirm: true }, valid: true },
	{ name: "upload confirmation", command: "browser_upload", args: { selector: "input", files: ["C:\\tmp\\a.txt"], confirm: false }, valid: false, code: "UPLOAD_CONFIRMATION_REQUIRED" },
	{ name: "upload relative path", command: "browser_upload", args: { selector: "input", files: ["relative.txt"], confirm: true }, valid: false, code: "UPLOAD_PATH_NOT_ABSOLUTE" },
];

test("shared validation corpus has at least fifty side-effect-free cases with stable issues", () => {
	assert.ok(corpus.length >= 50, `expected >= 50 validation cases, got ${corpus.length}`);
	const definitions = new Map(collectCommandDefs().map((definition) => [definition.name, definition]));
	for (const item of corpus) {
		const definition = definitions.get(item.command);
		assert.ok(definition, item.command);
		const cliResult = validateBrowserCommandArguments(definition, item.args);
		const daemonResult = validateDaemonCommandArguments(definition, item.args);
		assert.deepEqual(daemonResult, cliResult, `${item.name}: CLI/daemon validation parity`);
		assert.equal(cliResult.ok, item.valid, item.name);
		if (!cliResult.ok) {
			assert.ok(cliResult.issues.length > 0, item.name);
			assert.ok(cliResult.issues.every((issue) => issue.code && issue.path && issue.message), item.name);
			if (item.code) assert.ok(cliResult.issues.some((issue) => issue.code === item.code), `${item.name}: ${JSON.stringify(cliResult.issues)}`);
		} else {
			assert.deepEqual(cliResult.args, item.args, `${item.name} normalized args`);
		}
	}
});

test("unknown keys are rejected before explicit command-owned coercion", () => {
	let coercions = 0;
	const definition: BrowserCommandDefinition = {
		name: "browser_validation_fixture",
		parameters: Type.Object({ canonical: Type.Number() }, { additionalProperties: false }),
		coerceArguments(args) {
			coercions += 1;
			return { ...args, canonical: Number(args.canonical) };
		},
		execute: async () => ({ content: [{ type: "text", text: "unused" }] }),
	};
	assert.deepEqual(validateBrowserCommandArguments(definition, { canonical: "7" }), { ok: true, args: { canonical: 7 } });
	assert.equal(coercions, 1);
	const rejected = validateBrowserCommandArguments(definition, { canonical: "7", legacy: true });
	assert.equal(rejected.ok, false);
	if (!rejected.ok) assert.equal(rejected.issues[0]?.code, "UNKNOWN_ARGUMENT");
	assert.equal(coercions, 1);
});

test("daemon pre-execution rejects a non-object params payload without normalizing it away", () => {
	const definition = collectCommandDefs().find((item) => item.name === "browser_execute");
	assert.ok(definition);
	assert.deepEqual(validateDaemonCommandArguments(definition, []), {
		ok: false,
		error: "Invalid parameters — /: Command arguments must be an object",
		issues: [{ code: "ARGUMENTS_OBJECT_REQUIRED", path: "/", message: "Command arguments must be an object" }],
	});
});

export { corpus as validationParityCorpus };
