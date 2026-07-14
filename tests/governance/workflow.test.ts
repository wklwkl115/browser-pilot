import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const governancePath = path.join(root, "REPO_GOVERNANCE.md");
const readmePath = path.join(root, "README.md");
const packagePath = path.join(root, "package.json");
const abmlReadmePath = path.join(root, "src/kernels/abml/README.md");
const codeWikiPath = path.join(root, "CODE_WIKI.md");
const cliHelpPath = path.join(root, "src/apps/cli/help.ts");
const cliSkillPath = path.join(root, "skills/browser-pilot-cli/SKILL.md");
const cliSkillAgentPath = path.join(root, "skills/browser-pilot-cli/agents/openai.yaml");
const agentGuidePath = path.join(root, "AGENTS.md");
const commandSharedPath = path.join(root, "src/commands/commandShared.ts");
const commandMetadataPath = path.join(root, "src/apps/cli/commandMetadata.ts");
const commandRuntimePath = path.join(root, "src/commands/commandRuntime.ts");
const changelogPath = path.join(root, "CHANGELOG.md");
const packageLockPath = path.join(root, "package-lock.json");
const commandCatalogPath = path.join(root, "src/commands/commandCatalog.ts");
const nativeCommandSchemaPath = path.join(root, "src/bridge/protocol/native-command.schema.json");
const testScriptPath = path.join(root, "scripts/run-tests.mjs");
const coverageScriptPath = path.join(root, "scripts/run-coverage.mjs");
const complexityScriptPath = path.join(root, "scripts/audit-complexity.mjs");
const validationScriptPath = path.join(root, "scripts/run-validation.mjs");
const browserSmokeScriptPath = path.join(root, "scripts/run-browser-smoke.mjs");
const eslintConfigPath = path.join(root, "eslint.config.js");
const misePath = path.join(root, "mise.toml");
const verifyWorkflowPath = path.join(root, ".github/workflows/verify.yml");
const releaseWorkflowPath = path.join(root, ".github/workflows/release.yml");
const releaseArtifactScriptPath = path.join(root, "scripts/verify-release-artifact.mjs");
const kernelRoot = path.join(root, "src", "kernels");
const sessionKernelRoot = path.join(kernelRoot, "session");
const commandsRoot = path.join(root, "src", "commands");
const testsRoot = path.join(root, "tests");

function text(filePath: string) {
	return readFileSync(filePath, "utf8");
}

function walkSourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const filePath = path.join(dir, entry.name);
		if (entry.isDirectory()) return walkSourceFiles(filePath);
		return entry.isFile() && /\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [filePath] : [];
	});
}

function scanTextFiles(dir: string): string[] {
	const ignoredDirs = new Set([".git", "node_modules", "dist", "browser_pilot_bridge"]);
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (ignoredDirs.has(entry.name)) return [];
		const filePath = path.join(dir, entry.name);
		if (entry.isDirectory()) return scanTextFiles(filePath);
		return entry.isFile() && /\.(?:ts|tsx|js|mjs|cjs|md|json)$/.test(entry.name) ? [filePath] : [];
	});
}

function packageNames(section: Record<string, unknown> | undefined): string[] {
	return Object.keys(section ?? {});
}

const forbiddenReferenceRuntimeDependencies = ["playwright", "@playwright/test", "@testing-library/dom", "@testing-library/user-event", "@browser-use/browser-use", "browser-use", "@browserbasehq/stagehand", "stagehand"];
const frameworkRuntimeImport = /from\s+["'](?:playwright|@playwright\/test|@testing-library\/dom|@testing-library\/user-event|@browser-use\/browser-use|browser-use|@browserbasehq\/stagehand|stagehand|dom-accessibility-api|aria-query|axe-core|@mozilla\/readability)["']|import\s*\(\s*["'](?:playwright|@playwright\/test|@testing-library\/dom|@testing-library\/user-event|@browser-use\/browser-use|browser-use|@browserbasehq\/stagehand|stagehand|dom-accessibility-api|aria-query|axe-core|@mozilla\/readability)["']\s*\)|require\s*\(\s*["'](?:playwright|@playwright\/test|@testing-library\/dom|@testing-library\/user-event|@browser-use\/browser-use|browser-use|@browserbasehq\/stagehand|stagehand|dom-accessibility-api|aria-query|axe-core|@mozilla\/readability)["']\s*\)/;

const observeModeRecommendationPattern = /(?:browser_observe[^\n]*(?:mode=|mode:|mode\s)|browser-pilot\s+observe\s+--mode\b)/;
const commandFileReferenceRecommendationPattern = /--command\s+@/;
const manualNetworkFlowPattern = /network\s+start[\s\S]{0,160}(?:reload|navigate|navigation)|(?:reload|navigate|navigation)[\s\S]{0,160}network\s+list/i;
const fixedArtifactPathPattern = /(?:browser_artifact|browser-pilot\s+artifact|npx\s+browser-pilot\s+artifact)[^\n]*(?:\.browser-pilot\/artifacts\/[^\s>]+|[A-Za-z]:[\\/][^\s>]+)/i;

function lineAllowsObserveModeRecommendation(line: string): boolean {
	return /legacy|debug|projection|compatibility|兼容|投影|schema|metadata|displayName|modeExplicit|no-mode|INVALID_RULE|invokeTool|normalization|characterization|doesNotMatch|assert\.|command:\s*"browser_observe"|observeModeRecommendationPattern/i.test(line);
}

test("repo governance uses mise-first gate commands", () => {
	const governance = text(governancePath);
	assert.match(governance, /mise run verify/);
	assert.doesNotMatch(governance, /npm run /);
});

test("state-changing command call sites use the canonical budgeted operation result owner", () => {
	const callSites = walkSourceFiles(commandsRoot).filter((filePath) => {
		if (path.basename(filePath) === "browserOperation.ts") return false;
		return text(filePath).includes("withBrowserOperation(");
	});
	assert.ok(callSites.length > 0);
	for (const filePath of callSites) {
		const source = text(filePath);
		const operationCalls = source.match(/\bwithBrowserOperation\s*\(/g)?.length ?? 0;
		const resultCalls = source.match(/\bbrowserOperationCommandResult\s*\(/g)?.length ?? 0;
		assert.equal(resultCalls, operationCalls, path.relative(root, filePath));
	}
});

test("repo governance documents one explicit child-agent workflow", () => {
	const governance = text(governancePath);
	assert.match(governance, /^## Child-Agent Workflow$/m);
	for (const agent of ["scout", "planner", "worker", "reviewer"]) {
		assert.match(governance, new RegExp(`\\b${agent}\\b`));
	}
});

test("repo governance exposes the canonical local gate sequence", () => {
	const governance = text(governancePath);
	assert.match(governance, /mise run dev/);
	assert.match(governance, /mise run affected/);
	assert.match(governance, /mise run verify/);
	assert.match(governance, /mise run smoke-browser/);
});

test("real browser smoke gate owns live MV3 acceptance and runs in Windows CI", () => {
	const mise = text(misePath);
	const workflow = text(verifyWorkflowPath);
	const smoke = text(browserSmokeScriptPath);
	assert.match(mise, /^\[tasks\.smoke-browser\]$/m);
	assert.match(mise, /scripts\/run-browser-smoke\.mjs/);
	assert.match(workflow, /mise run smoke-browser/);
	assert.match(workflow, /runs-on: windows-latest/);
	assert.match(smoke, /--load-extension=/);
	assert.match(smoke, /browser_execute/);
	assert.match(smoke, /browser_observe/);
	assert.match(smoke, /browser-operation\/v2/);
	assert.match(smoke, /no_effect/);
	assert.match(smoke, /completionVerified/);
	assert.match(smoke, /captureReload/);
	assert.match(smoke, /browser_hook/);
	assert.match(smoke, /pageEpoch/);
	assert.match(smoke, /reanchorReason/);
	assert.match(smoke, /extension reload reconnect/);
	assert.match(smoke, /provider-budget-telemetry/);
	assert.match(smoke, /operation-completion-event-wakeup/);
	assert.match(smoke, /pageshow\.persisted/);
	assert.match(smoke, /bfcache-back-forward-lineage/);
	assert.match(smoke, /frontier-artifact-targeted-read/);
	assert.match(smoke, /prerender-tabs-onReplaced/);
	assert.match(smoke, /target-close-new-target/);
	assert.doesNotMatch(smoke, /\.skip\(|test\.skip|acceptance.*skip/i);
});

test("tag releases publish only the retained cross-platform-verified tarball through npm OIDC", () => {
	const workflow = text(releaseWorkflowPath);
	const verifier = text(releaseArtifactScriptPath);
	assert.match(workflow, /tags:\s*\n\s*- ["']v\*["']/);
	assert.match(workflow, /node scripts\/verify-release-artifact\.mjs/);
	assert.match(workflow, /ubuntu-latest/);
	assert.match(workflow, /windows-latest/);
	assert.match(workflow, /mise run verify/);
	assert.match(workflow, /mise run package-smoke/);
	assert.match(workflow, /mise run smoke-browser/);
	assert.match(workflow, /node scripts\/package-smoke\.mjs --artifact-dir release-artifact/);
	assert.match(workflow, /actions\/upload-artifact@v4/);
	assert.match(workflow, /actions\/download-artifact@v4/);
	assert.match(workflow, /npm install --global npm@11\.6\.2/);
	assert.match(workflow, /id-token: write/);
	assert.match(workflow, /npm publish [^\n]+ --access public --provenance/);
	assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|npm pack/);
	assert.match(verifier, /release tag mismatch/);
	assert.match(verifier, /release SHA-256 mismatch/);
	assert.match(verifier, /exactly one tarball/);
});

test("coverage module loading counts only eligible source files", () => {
	const source = text(coverageScriptPath);
	assert.match(source, /fileURLToPath/);
	assert.match(source, /eligibleSourceModules\.has\(sourcePath\)/);
	assert.doesNotMatch(source, /url\.includes\(["']\/src\/["']\)/);
});

test("verify owns an exact complexity ratchet", () => {
	const complexity = text(complexityScriptPath);
	const validation = text(validationScriptPath);
	const pkg = JSON.parse(text(packagePath)) as { scripts?: Record<string, string> };
	assert.match(complexity, /expectedComplexFunctions\s*=\s*80/);
	assert.match(complexity, /expectedLongFunctions\s*=\s*0/);
	assert.match(complexity, /assertExactBudget/);
	assert.match(validation, /scripts\/audit-complexity\.mjs/);
	assert.match(pkg.scripts?.["audit:complexity"] || "", /scripts\/audit-complexity\.mjs/);
	assert.match(text(governancePath), /complexity ratchet/);
	assert.match(text(codeWikiPath), /complexity ratchet/);
});

test("eslint ignores the generated protocol outputs at their canonical paths", () => {
	const source = text(eslintConfigPath);
	for (const generatedPath of [
		"src/bridge/extension/service_worker/protocol.ts",
		"src/types/nativeProtocol.ts",
		"src/commands/nativeActionMetadata.ts",
		"src/types/nativeErrorCodes.ts",
	]) {
		assert.match(source, new RegExp(`["']${generatedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`));
	}
	assert.doesNotMatch(source, /src\/bridge\/protocol\/(?:nativeProtocol|nativeActionMetadata|nativeErrorCodes)\.ts/);
});

test("abml readme uses canonical mise validation guidance", () => {
	const readme = text(abmlReadmePath);
	assert.doesNotMatch(readme, /npm run /);
	assert.match(readme, /mise run verify/);
	assert.match(readme, /REPO_GOVERNANCE\.md/);
});

test("commandShared explains parameter classes without numbered doctrine labels", () => {
	const source = text(commandSharedPath);
	assert.doesNotMatch(source, /Charter law|铁律/);
	assert.match(source, /intent/i);
	assert.match(source, /mechanical/i);
});

test("derived command helpers avoid numbered doctrine labels", () => {
	for (const filePath of [commandMetadataPath, commandRuntimePath]) {
		assert.doesNotMatch(text(filePath), /Charter law|铁律/);
	}
});

test("readme describes the tool surface without hard-coding the tool count", () => {
	const readme = text(readmePath);
	assert.match(readme, /browser_\*/);
	assert.doesNotMatch(readme, /all \d+ tools|\d+ composable tools|\d+ tools as shell subcommands|\d+ browser_\* tools|\d+ core tools|\d+ security tools|\d+ web security tools/i);
});

test("package metadata avoids hard-coded tool counts", () => {
	const pkg = text(packagePath);
	assert.doesNotMatch(pkg, /\d+ browser_\* tools|\d+ composable tools|all \d+ tools/i);
});

test("package files avoids redundant child entries covered by parent directories", () => {
	const pkg = JSON.parse(text(packagePath)) as { files?: string[] };
	const files = pkg.files || [];
	const normalized = files.map((entry) => entry.replace(/\\/g, "/").replace(/^\.\//, ""));
	for (const entry of normalized) {
		const cleanEntry = entry.endsWith("/") ? entry : `${entry}/`;
		for (const parent of normalized) {
			if (entry === parent || !parent.endsWith("/")) continue;
			assert.ok(!cleanEntry.startsWith(parent), `${entry} is already covered by ${parent}`);
		}
	}
});

test("package metadata keeps the Windows shim bin target inside packaged dist", () => {
	const pkg = JSON.parse(text(packagePath)) as { bin?: Record<string, string>; files?: string[] };
	const binTarget = pkg.bin?.["browser-pilot"];
	assert.equal(binTarget, "./dist/src/apps/cli/bin.js");
	const normalizedFiles = (pkg.files || []).map((entry) => entry.replace(/\\/g, "/").replace(/^\.\//, ""));
	assert.ok(normalizedFiles.includes("dist/"));
	assert.ok(normalizedFiles.some((entry) => entry === "src/"));
	assert.equal(binTarget?.startsWith("./src/"), false);
});

test("public contract has no built-in browser memory surface", () => {
	const readme = text(readmePath);
	const wiki = text(codeWikiPath);
	const catalog = text(commandCatalogPath);
	const nativeSchema = text(nativeCommandSchemaPath);
	for (const content of [readme, wiki, catalog, nativeSchema]) {
		assert.doesNotMatch(content, /browser_memory|browser-memory|\.browser-pilot\/memory|browser memory|session memory|BROWSER_PILOT_MEMORY|MEMORY_[A-Z_]+/i);
	}
	for (const sourceRoot of [path.join(root, "src"), kernelRoot, commandsRoot]) {
		assert.equal(readdirSync(sourceRoot).some((entry) => entry.toLowerCase().startsWith("memory")), false);
	}
	assert.equal(readdirSync(testsRoot).some((entry) => entry.toLowerCase() === "memory"), false);
	for (const workflowPath of [misePath, testScriptPath, coverageScriptPath, validationScriptPath]) {
		assert.doesNotMatch(text(workflowPath), /test-memory|tests[\\/]memory|run-(?:tests|coverage)\.mjs\s+memory|["']memory["']\s*:/i);
	}
});

test("public docs describe browser_observe as canonical ABML observation with legacy projections isolated", () => {
	const readme = text(readmePath);
	const wiki = text(codeWikiPath);
	assert.match(readme, /browser_observe[`\s\S]{0,120}canonical ABML page model/i);
	assert.match(readme, /Omit `mode`[\s\S]{0,120}any explicit `mode` value[\s\S]{0,120}legacy\/debug\/projection/i);
	assert.match(readme, /mode=content\/html\/text\/tabs`[\s\S]{0,120}compatibility projections/i);
	assert.match(wiki, /browser_observe[`\s\S]{0,180}browser-page-observation\/v3/i);
	assert.match(wiki, /正常 agent 工作流应省略 `mode`/);
	assert.match(wiki, /任何显式 `mode` 都是 legacy\/debug\/projection/);
	assert.match(wiki, /显式 `mode=scan`/);
	assert.match(wiki, /mode=content\/html\/text\/tabs`[\s\S]{0,120}投影来源/);
});

test("agent-facing guidance does not recommend browser_observe mode outside explicit legacy projection contexts", () => {
	const files = [
		...scanTextFiles(path.join(root, "src")),
		...scanTextFiles(path.join(root, "tests")),
		readmePath,
		codeWikiPath,
		changelogPath,
	].filter((filePath, index, all) => all.indexOf(filePath) === index);
	const offenders: string[] = [];
	for (const filePath of files) {
		const relative = path.relative(root, filePath);
		text(filePath).split(/\r?\n/).forEach((line, index) => {
			if (observeModeRecommendationPattern.test(line) && !lineAllowsObserveModeRecommendation(line)) offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
		});
	}
	assert.deepEqual(offenders, []);
});

test("agent-facing guidance does not recommend unsupported command @file input", () => {
	const files = [
		...scanTextFiles(path.join(root, "src")),
		...scanTextFiles(path.join(root, "tests")),
		readmePath,
		codeWikiPath,
		changelogPath,
	].filter((filePath, index, all) => all.indexOf(filePath) === index);
	const offenders: string[] = [];
	for (const filePath of files) {
		const relative = path.relative(root, filePath);
		text(filePath).split(/\r?\n/).forEach((line, index) => {
			if (commandFileReferenceRecommendationPattern.test(line) && !/do not use|不支持也不推荐|rejects --command @file|fails as inline-only|does not recommend|unsupported command @file|commandFileReferenceRecommendationPattern/.test(line)) offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
		});
	}
	assert.deepEqual(offenders, []);
});

test("public docs and CLI guide route page-load capture through canonical capture-reload", () => {
	const readme = text(readmePath);
	const wiki = text(codeWikiPath);
	const cliHelp = text(cliHelpPath);
	const cliSkill = text(cliSkillPath);
	for (const source of [readme, wiki, cliHelp, cliSkill]) {
		assert.match(source, /capture-reload/);
		assert.match(source, /captureReload/);
	}
	assert.match(readme, /canonical CLI `network capture-reload`[\s\S]{0,220}starts capture before reload\/navigation/i);
	assert.match(wiki, /canonical CLI `browser-pilot network capture-reload`[\s\S]{0,220}network\.start[\s\S]{0,120}reload\/navigation/i);
	assert.match(cliHelp, /canonical capture-reload \(raw action captureReload\)[\s\S]{0,120}starts capture before reload\/navigation/i);
	assert.match(cliSkill, /canonical CLI action `capture-reload`[\s\S]{0,160}`\{"action":"captureReload"\}`/i);
});

test("CLI guidance requires transient JavaScript to stay in memory", () => {
	const cliSkill = text(cliSkillPath);
	assert.match(cliSkill, /mandatory operating rule, not a preference/i);
	assert.match(cliSkill, /JavaScript MUST be piped directly to `browser-pilot execute --script -` over stdin/);
	assert.match(cliSkill, /MUST NOT create a temporary `\.js`, `\.mjs`, text, or other local file/);
	assert.match(cliSkill, /`--script @file` MAY be used only for durable source/);
	assert.match(text(commandMetadataPath), /Temporary JavaScript must stay in memory/);
	assert.match(text(codeWikiPath), /临时 JavaScript 必须只在内存中传递/);
});

test("CLI skill keeps concise expert routing and command-owned canonical examples", () => {
	const skill = text(cliSkillPath);
	const lines = skill.split(/\r?\n/);
	assert.ok(lines.length >= 110 && lines.length <= 150, `expected 110-150 Skill lines, got ${lines.length}`);
	const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	assert.ok(frontmatter);
	assert.deepEqual(frontmatter[1]!.split(/\r?\n/).map((line) => line.match(/^([a-z][a-z-]*):/)?.[1]).filter(Boolean), ["name", "description"]);
	assert.match(skill, /commands --json[\s\S]{0,240}(?:help|schema|validate)[\s\S]{0,240}(?:authoritative|authority)/i);
	assert.match(skill, /browser-pilot tabs list --json/);
	assert.match(skill, /browser-pilot tabs create --url/);
	for (const mode of ["inspect", "paths", "json"]) assert.match(skill, new RegExp(`browser-pilot artifact ${mode}\\b`));
	assert.doesNotMatch(skill, /browser-pilot tabs --action list/);
	assert.doesNotMatch(skill, /browser-pilot artifact[^\n]*--mode (?:inspect|paths|json)/);

	const agentMetadata = text(cliSkillAgentPath);
	assert.match(agentMetadata, /display_name: "Browser Pilot CLI"/);
	assert.match(agentMetadata, /short_description: "Operate real browser tabs through Browser Pilot CLI"/);
	assert.match(agentMetadata, /default_prompt: "Use \$browser-pilot-cli to inspect and automate the current browser tab safely through the CLI\."/);
});

test("owner docs and CLI guidance exclude retired interaction surfaces", () => {
	const docs = [agentGuidePath, readmePath, changelogPath, codeWikiPath, governancePath, abmlReadmePath, cliHelpPath, cliSkillPath];
	const retiredCommands = ["view", "act", "read"].flatMap((name) => [`browser_${name}`, `browser-pilot ${name}`]);
	const retiredSchemas = ["view", "turn", "read"].map((name) => ["browser", "agent", name].join("-") + "/v1");
	const staleTokens = [
		...retiredCommands,
		...retiredSchemas,
		["agent", "preview"].join("-"),
		["confirmation", "Ref"].join(""),
		["Agent", "Interaction", "Plane"].join(" "),
		["agent", "façade"].join(" "),
		["agent", "facade"].join(" "),
		["--script", "file"].join("-"),
	];
	const staleToolCount = String(19 + 3);
	const staleCountPatterns = [
		new RegExp(`\\b${staleToolCount}(?:[- ]tools?)\\b`, "i"),
		new RegExp(`toolCount[^\\n]{0,24}${staleToolCount}\\b`, "i"),
	];
	const publicWaitOrSleep = /^\s*(?:[$>]\s*)?(?:npx\s+)?browser-pilot\s+(?:wait|sleep)\b/im;
	for (const filePath of docs) {
		const source = text(filePath);
		for (const token of staleTokens) assert.equal(source.toLowerCase().includes(token.toLowerCase()), false, `${path.relative(root, filePath)}: ${token}`);
		for (const pattern of staleCountPatterns) assert.doesNotMatch(source, pattern, path.relative(root, filePath));
		assert.doesNotMatch(source, publicWaitOrSleep, path.relative(root, filePath));
	}
});

test("public contract docs use operation v2 and do not advertise the camelCase CLI alias", () => {
	const docs = [readmePath, codeWikiPath, governancePath, cliSkillPath, changelogPath];
	for (const filePath of docs) {
		const source = text(filePath);
		assert.match(source, /browser-operation\/v2/, path.relative(root, filePath));
		assert.doesNotMatch(source, /browser-operation\/v1/, path.relative(root, filePath));
		assert.doesNotMatch(source, /(?:^|\n)\s*(?:npx\s+)?browser-pilot\s+network\s+captureReload\b/m, path.relative(root, filePath));
	}
	assert.match(text(readmePath), /`network captureReload` is not a CLI alias/);
	assert.match(text(codeWikiPath), /`network captureReload` 不是 alias/);
});

test("public contract docs define no-effect as non-success and anchor deltas by page epoch", () => {
	for (const filePath of [readmePath, codeWikiPath, governancePath, cliSkillPath, changelogPath]) {
		const source = text(filePath);
		assert.match(source, /no_effect/, path.relative(root, filePath));
		assert.match(source, /pageEpoch/, path.relative(root, filePath));
		assert.match(source, /reanchorReason/, path.relative(root, filePath));
	}
});

test("agent-facing guidance does not recommend manual-only page-load network flow", () => {
	const files = [readmePath, codeWikiPath, cliHelpPath];
	const offenders: string[] = [];
	for (const filePath of files) {
		const relative = path.relative(root, filePath);
		text(filePath).split(/\r?\n\r?\n/).forEach((block, index) => {
			if (manualNetworkFlowPattern.test(block) && !/capture-reload|captureReload|low-level|manual recorder control|do not|不要/.test(block)) offenders.push(`${relative}:block ${index + 1}: ${block.replace(/\s+/g, " ").trim()}`);
		});
	}
	assert.deepEqual(offenders, []);
});

test("artifact path guidance uses inspect or paths before targeted reads", () => {
	const readme = text(readmePath);
	const wiki = text(codeWikiPath);
	const cliHelp = text(cliHelpPath);
	for (const source of [readme, wiki, cliHelp]) assert.match(source, /inspect|paths/);
	assert.match(readme, /saved\.path[\s\S]{0,180}artifact inspect|artifact inspect[\s\S]{0,180}saved\.path/i);
	assert.match(wiki, /artifact inspect[\s\S]{0,140}artifact paths|artifact paths[\s\S]{0,180}实际可用 JSON path/i);
	assert.match(wiki, /不应推荐猜测的 JSON path|验证路径存在/);
});

test("agent-facing artifact examples do not recommend fixed local paths", () => {
	const files = [readmePath, codeWikiPath, cliHelpPath];
	const offenders: string[] = [];
	for (const filePath of files) {
		const relative = path.relative(root, filePath);
		text(filePath).split(/\r?\n/).forEach((line, index) => {
			if (fixedArtifactPathPattern.test(line)) offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
		});
	}
	assert.deepEqual(offenders, []);
});

test("public docs cover latency telemetry and offline observe benchmark constraints", () => {
	const readme = text(readmePath);
	const wiki = text(codeWikiPath);
	assert.match(readme, /diagnostics\.latency[\s\S]{0,180}payloads|latency[\s\S]{0,180}do not include command payloads/i);
	assert.match(wiki, /diagnostics\.latency[\s\S]{0,240}不包含 command payload|latency[\s\S]{0,240}headers[\s\S]{0,120}URL query/i);
	assert.match(readme, /observe regression benchmark[\s\S]{0,160}offline fixtures/i);
	assert.match(wiki, /Observe regression benchmark[\s\S]{0,320}1573380[\s\S]{0,320}25%/i);
	assert.match(wiki, /required facts[\s\S]{0,220}verified read|verified read[\s\S]{0,220}unavailable reason/i);
});

test("code wiki documents the session kernel node crypto exception", () => {
	const wiki = text(codeWikiPath);
	assert.match(wiki, /src\/kernels\/session\/\*[\s\S]{0,120}node:crypto/);
	assert.match(wiki, /randomUUID[\s\S]{0,80}randomBytes[\s\S]{0,80}createHash/);
});

test("kernel source stays isolated from runtime, command, and bridge layers", () => {
	const forbidden = /from\s+["'](?:\.\.\/)+(?:commands|bridge|browser-runtime|browser-command-runtime)\//;
	for (const filePath of walkSourceFiles(kernelRoot)) {
		assert.doesNotMatch(text(filePath), forbidden, path.relative(root, filePath));
	}
});

test("reference design tools are not runtime dependencies", () => {
	const pkg = JSON.parse(text(packagePath)) as { dependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown>; peerDependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
	const lock = JSON.parse(text(packageLockPath)) as { packages?: Record<string, { dependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown>; peerDependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }> };
	const runtimeDependencyNames = new Set([
		...packageNames(pkg.dependencies),
		...packageNames(pkg.optionalDependencies),
		...packageNames(lock.packages?.[""]?.dependencies),
		...packageNames(lock.packages?.[""]?.optionalDependencies),
	]);
	const peerDependencyNames = new Set([
		...packageNames(pkg.peerDependencies),
		...packageNames(lock.packages?.[""]?.peerDependencies),
	]);
	for (const dependency of forbiddenReferenceRuntimeDependencies) {
		assert.equal(runtimeDependencyNames.has(dependency), false, dependency);
		assert.equal(peerDependencyNames.has(dependency), false, dependency);
	}
});

test("kernel source does not import browser or third-party framework runtime packages", () => {
	const offenders = walkSourceFiles(kernelRoot)
		.map((filePath) => [filePath, text(filePath)] as const)
		.filter(([, source]) => frameworkRuntimeImport.test(source))
		.map(([filePath]) => path.relative(root, filePath));
	assert.deepEqual(offenders, []);
});

test("design reference dependencies do not expand command or protocol surfaces", () => {
	const catalog = text(commandCatalogPath);
	const nativeCommandSchema = text(nativeCommandSchemaPath);
	for (const source of [catalog, nativeCommandSchema]) {
		for (const dependency of forbiddenReferenceRuntimeDependencies) {
			assert.doesNotMatch(source, new RegExp(dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
		}
	}
	for (const source of [catalog, nativeCommandSchema]) {
		assert.doesNotMatch(source, /getByRole|locator|aria snapshot|testing-library|browser-use|stagehand/i);
	}
});

test("only session kernel may import node crypto", () => {
	const cryptoImport = /from\s+["']node:crypto["']/;
	for (const filePath of walkSourceFiles(kernelRoot)) {
		const relative = path.relative(root, filePath);
		if (filePath.startsWith(`${sessionKernelRoot}${path.sep}`)) continue;
		assert.doesNotMatch(text(filePath), cryptoImport, relative);
	}
});
