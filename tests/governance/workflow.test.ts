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
const commandSharedPath = path.join(root, "src/commands/commandShared.ts");
const commandMetadataPath = path.join(root, "src/apps/cli/commandMetadata.ts");
const commandRuntimePath = path.join(root, "src/commands/commandRuntime.ts");
const changelogPath = path.join(root, "CHANGELOG.md");
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

const observeModeRecommendationPattern = /(?:browser_observe[^\n]*(?:mode=|mode:|mode\s)|browser-pilot\s+observe\s+--mode\b)/;

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

test("only session kernel may import node crypto", () => {
	const cryptoImport = /from\s+["']node:crypto["']/;
	for (const filePath of walkSourceFiles(kernelRoot)) {
		const relative = path.relative(root, filePath);
		if (filePath.startsWith(`${sessionKernelRoot}${path.sep}`)) continue;
		assert.doesNotMatch(text(filePath), cryptoImport, relative);
	}
});
