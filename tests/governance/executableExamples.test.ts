import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { validateToolInvocationOffline } from "../../src/apps/cli/main.ts";

const root = process.cwd();
const docs = [
	"README.md",
	"CODE_WIKI.md",
	"skills/browser-pilot-cli/SKILL.md",
];

function markedCommands(relative: string): string[] {
	const lines = readFileSync(path.join(root, relative), "utf8").split(/\r?\n/);
	const commands: string[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		if (lines[index]?.trim() !== "# browser-pilot-executable") continue;
		const command = lines.slice(index + 1).find((line) => line.trim().length > 0 && !line.trim().startsWith("#"));
		assert.ok(command, `${relative}:${index + 1} marker has no command`);
		commands.push(command.trim());
	}
	return commands;
}

function shellWords(line: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index]!;
		if (!quote && char === "|") break;
		if (char === "'" || char === '"') {
			if (!quote) { quote = char; continue; }
			if (quote === char) { quote = undefined; continue; }
		}
		if (!quote && /\s/.test(char)) {
			if (current) { words.push(current); current = ""; }
			continue;
		}
		current += char;
	}
	if (current) words.push(current);
	assert.equal(quote, undefined, `unclosed quote in executable example: ${line}`);
	return words;
}

function cliArgv(line: string): string[] {
	const words = shellWords(line);
	if (words[0] === "$") words.shift();
	if (words[0] === "npx") words.shift();
	assert.equal(words.shift(), "browser-pilot", line);
	return words;
}

test("marked public documentation examples pass the real offline CLI parser and validator", async () => {
	let total = 0;
	const skillRoutes = new Set<string>();
	for (const relative of docs) {
		const commands = markedCommands(relative);
		assert.ok(commands.length > 0, `${relative} must own at least one executable example`);
		let hasCanonicalCaptureReload = false;
		for (const command of commands) {
			total += 1;
			const [subcommand, ...argv] = cliArgv(command);
			assert.ok(subcommand, command);
			const result = await validateToolInvocationOffline(subcommand, argv);
			assert.equal(result.ok, true, `${relative}: ${command}: ${result.ok ? "" : result.error}`);
			if (relative === "skills/browser-pilot-cli/SKILL.md") {
				if (subcommand === "tabs" && argv[0] === "list") skillRoutes.add("tabs list");
				if (subcommand === "observe" && argv.includes("--target-ref")) skillRoutes.add("observe --target-ref");
				if (subcommand === "execute" && argv.includes("--script")) skillRoutes.add("execute --script");
				if (subcommand === "network" && argv[0] === "capture-reload") skillRoutes.add("network capture-reload");
				if (subcommand === "artifact" && ["inspect", "paths", "json"].includes(argv[0] ?? "")) skillRoutes.add(`artifact ${argv[0]}`);
			}
			if (subcommand === "network" && argv[0] === "capture-reload") {
				hasCanonicalCaptureReload = true;
				assert.equal(result.action, "captureReload", `${relative}: canonical CLI action did not resolve to the raw schema action`);
				assert.equal(result.args.action, "captureReload", `${relative}: normalized args did not retain the raw schema action`);
			}
		}
		assert.equal(hasCanonicalCaptureReload, true, `${relative} must exercise canonical network capture-reload`);
	}
	assert.deepEqual([...skillRoutes].sort(), [
		"artifact inspect",
		"artifact json",
		"artifact paths",
		"execute --script",
		"network capture-reload",
		"observe --target-ref",
		"tabs list",
	]);
	assert.ok(total >= 10, `expected a representative executable example set, got ${total}`);
});

test("camelCase network action is not accepted as a CLI alias", async () => {
	const result = await validateToolInvocationOffline("network", ["captureReload", "--json"]);
	assert.equal(result.ok, false);
	assert.match(result.error, /unexpected argument "captureReload"/);
});
