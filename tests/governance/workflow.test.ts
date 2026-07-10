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
const commandSharedPath = path.join(root, "src/commands/commandShared.ts");
const commandMetadataPath = path.join(root, "src/apps/cli/commandMetadata.ts");
const commandRuntimePath = path.join(root, "src/commands/commandRuntime.ts");
const changelogPath = path.join(root, "CHANGELOG.md");
const packageLockPath = path.join(root, "package-lock.json");
const commandCatalogPath = path.join(root, "src/commands/commandCatalog.ts");
const nativeCommandSchemaPath = path.join(root, "src/bridge/protocol/native-command.schema.json");
const coverageScriptPath = path.join(root, "scripts/run-coverage.mjs");
const complexityScriptPath = path.join(root, "scripts/audit-complexity.mjs");
const validationScriptPath = path.join(root, "scripts/run-validation.mjs");
const browserSmokeScriptPath = path.join(root, "scripts/run-browser-smoke.mjs");
const eslintConfigPath = path.join(root, "eslint.config.js");
const misePath = path.join(root, "mise.toml");
const verifyWorkflowPath = path.join(root, ".github/workflows/verify.yml");
const kernelRoot = path.join(root, "src", "kernels");
const sessionKernelRoot = path.join(kernelRoot, "session");

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
	assert.match(smoke, /captureReload/);
	assert.match(smoke, /browser_hook/);
	assert.match(smoke, /extension reload reconnect/);
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
	assert.match(complexity, /expectedComplexFunctions\s*=\s*91/);
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

test("public docs describe memory as fact-only and observe as fact surfacing", () => {
	const readme = text(readmePath);
	assert.match(readme, /facts? only/i);
	assert.match(readme, /SOPs?, workflows?, playbooks?, checklists?[\s\S]{0,80}agent instructions/i);
	assert.match(readme, /browser_observe[\s\S]{0,120}surfaces?[\s\S]{0,120}facts?/i);
});

test("code wiki documents memory fact-only behavior and observe fact exposure", () => {
	const wiki = text(codeWikiPath);
	assert.match(wiki, /kind=fact/);
	assert.match(wiki, /SOP、workflow、playbook、checklist/);
	assert.match(wiki, /browser_observe[\s\S]{0,160}fact memory/i);
});

test("public docs describe browser_observe as canonical ABML observation with legacy projections isolated", () => {
	const readme = text(readmePath);
	const wiki = text(codeWikiPath);
	assert.match(readme, /browser_observe[`\s\S]{0,120}canonical ABML page model/i);
	assert.match(readme, /Omit `mode`[\s\S]{0,120}any explicit `mode` value[\s\S]{0,120}legacy\/debug\/projection/i);
	assert.match(readme, /mode=content\/html\/text\/tabs`[\s\S]{0,120}compatibility projections/i);
	assert.match(wiki, /browser_observe[`\s\S]{0,120}canonical ABML `PageObservation`/i);
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

test("public docs and CLI guide page-load network capture through captureReload", () => {
	const readme = text(readmePath);
	const wiki = text(codeWikiPath);
	const cliHelp = text(cliHelpPath);
	for (const source of [readme, wiki, cliHelp]) assert.match(source, /captureReload/);
	assert.match(readme, /captureReload[\s\S]{0,160}starts before reload\/navigation|starts capture before reload\/navigation[\s\S]{0,160}captureReload/i);
	assert.match(wiki, /captureReload[\s\S]{0,220}network\.start[\s\S]{0,120}reload\/navigation/i);
	assert.match(cliHelp, /captureReload[\s\S]{0,120}starts capture before reload\/navigation/i);
});

test("agent-facing guidance does not recommend manual-only page-load network flow", () => {
	const files = [readmePath, codeWikiPath, cliHelpPath];
	const offenders: string[] = [];
	for (const filePath of files) {
		const relative = path.relative(root, filePath);
		text(filePath).split(/\r?\n\r?\n/).forEach((block, index) => {
			if (manualNetworkFlowPattern.test(block) && !/captureReload|low-level|manual recorder control|do not|不要/.test(block)) offenders.push(`${relative}:block ${index + 1}: ${block.replace(/\s+/g, " ").trim()}`);
		});
	}
	assert.deepEqual(offenders, []);
});

test("artifact path guidance uses inspect or paths before targeted reads", () => {
	const readme = text(readmePath);
	const wiki = text(codeWikiPath);
	const cliHelp = text(cliHelpPath);
	for (const source of [readme, wiki, cliHelp]) assert.match(source, /inspect|paths/);
	assert.match(readme, /saved\.path[\s\S]{0,160}mode=inspect|mode=inspect[\s\S]{0,160}saved\.path/i);
	assert.match(wiki, /mode=inspect[\s\S]{0,120}mode=paths|mode=paths[\s\S]{0,160}实际可用 JSON path/i);
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
	assert.match(wiki, /Observe regression benchmark[\s\S]{0,420}离线 fixture[\s\S]{0,260}provider telemetry/i);
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
