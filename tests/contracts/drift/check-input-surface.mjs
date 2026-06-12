import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectTools } from "../../../scripts/generate-tool-docs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const baselinePath = path.join(root, "tests/contracts/drift/input-surface-budget.json");
const proposeMode = process.argv.includes("--propose");

function read(rel) {
	return readFileSync(path.join(root, rel), "utf8");
}

function deprecatedKeys() {
	const source = read("src/tools/prepareArguments.ts");
	const match = source.match(/DEPRECATED_AGENT_PARAM_KEYS\s*=\s*\[([\s\S]*?)\]\s*as const/);
	assert.ok(match, "DEPRECATED_AGENT_PARAM_KEYS must remain statically readable");
	return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

function advertisedStrings(tool) {
	return [
		tool.name,
		tool.description,
		tool.promptSnippet,
		...(Array.isArray(tool.promptGuidelines) ? tool.promptGuidelines : []),
		...(Array.isArray(tool.descriptionStrings) ? tool.descriptionStrings : []),
		JSON.stringify(tool.parameters || []),
	].filter((value) => typeof value === "string" && value.length > 0);
}

function advertisedProseStrings(tool) {
	return [
		tool.description,
		tool.promptSnippet,
		...(Array.isArray(tool.promptGuidelines) ? tool.promptGuidelines : []),
		...(Array.isArray(tool.descriptionStrings) ? tool.descriptionStrings : []),
	].filter((value) => typeof value === "string" && value.length > 0);
}

function advertisedChars(tool) {
	return advertisedStrings(tool).join("\n").length;
}

const tools = await collectTools();

const measured = {
	version: 1,
	toolCount: tools.length,
	totalChars: 0,
	tools: {},
};
for (const tool of tools) {
	const chars = advertisedChars(tool);
	measured.tools[tool.name] = { advertisedChars: chars, file: tool.file };
	measured.totalChars += chars;
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

function budgetIssues() {
	const issues = [];
	if (baseline.version !== measured.version) issues.push(`version ${baseline.version} -> ${measured.version}`);
	if (baseline.toolCount !== tools.length) issues.push(`toolCount ${baseline.toolCount} -> ${tools.length}`);
	if (Object.keys(baseline.tools).length !== tools.length) issues.push(`tool rows ${Object.keys(baseline.tools).length} -> ${tools.length}`);
	if (measured.totalChars > baseline.totalChars) issues.push(`totalChars ${baseline.totalChars} -> ${measured.totalChars}`);
	for (const [name, current] of Object.entries(measured.tools)) {
		const prior = baseline.tools[name];
		if (!prior) issues.push(`missing tool ${name}`);
		else if (current.advertisedChars > prior.advertisedChars) issues.push(`${name}.advertisedChars ${prior.advertisedChars} -> ${current.advertisedChars}`);
	}
	return issues;
}

const issues = budgetIssues();
if (proposeMode) {
	if (!issues.length) console.log("input-surface propose: no changes needed");
	else {
		console.log(`input-surface propose: update ${path.relative(root, baselinePath)} with this measured baseline; include a one-line justification for any growth:`);
		console.log(JSON.stringify({ ...measured, justification: "TODO: justify public input-surface growth or reduce prompt/schema text" }, null, 2));
	}
	process.exit(0);
}

assert.equal(baseline.version, measured.version, "input-surface budget baseline version mismatch (run npm run check:input-surface -- --propose for a draft)");
assert.equal(baseline.toolCount, tools.length, "input-surface budget baseline must track the current public tool count (run npm run check:input-surface -- --propose for a draft)");
assert.equal(Object.keys(baseline.tools).length, tools.length, "input-surface budget baseline must cover every tool (run npm run check:input-surface -- --propose for a draft)");
assert.ok(measured.totalChars <= baseline.totalChars, `input surface grew: ${measured.totalChars} > ${baseline.totalChars}; update ${path.relative(root, baselinePath)} in the same diff with the declared growth (run npm run check:input-surface -- --propose for a draft)`);
for (const [name, current] of Object.entries(measured.tools)) {
	const prior = baseline.tools[name];
	assert.ok(prior, `input-surface baseline missing tool ${name} (run npm run check:input-surface -- --propose for a draft)`);
	assert.ok(current.advertisedChars <= prior.advertisedChars, `${name} advertised input surface grew: ${current.advertisedChars} > ${prior.advertisedChars}; update baseline with declared growth (run npm run check:input-surface -- --propose for a draft)`);
}

const stripped = new Set(deprecatedKeys());
for (const tool of tools) {
	const text = advertisedStrings(tool).join("\n");
	assert.equal(/--output-path/i.test(text), false, `${tool.name} must not advertise removed --output-path syntax`);
	const prose = advertisedProseStrings(tool);
	const proseText = prose.join("\n");
	for (const key of tool.parameters || []) {
		if (!stripped.has(key)) continue;
		const keyMention = new RegExp(`\\b${key}\\b`, "i").test(proseText);
		if (!keyMention) continue;
		const localMentions = prose.filter((line) => new RegExp(`\\b${key}\\b`, "i").test(line));
		assert.ok(localMentions.every((line) => /deprecated/i.test(line)), `${tool.name}.${key} is stripped by prepareArguments and must be advertised only as deprecated compatibility`);
	}
}

console.log(`input surface ok - ${tools.length} tools, ${measured.totalChars}/${baseline.totalChars} chars`);
