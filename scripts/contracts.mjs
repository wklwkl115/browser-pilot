import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];

if (mode !== "record" && mode !== "verify") {
	console.error("usage: node scripts/contracts.mjs <record|verify>");
	process.exit(2);
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		...options,
	});
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed\n${String(result.stdout || "").slice(-2000)}\n${String(result.stderr || "").slice(-2000)}`);
	}
	return result.stdout;
}

function npm(args, options = {}) {
	if (process.env.npm_execpath) return run(process.execPath, [process.env.npm_execpath, ...args], options);
	const candidates = [
		path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
		path.join(path.dirname(path.dirname(process.execPath)), "node_modules", "npm", "bin", "npm-cli.js"),
	];
	const npmCli = candidates.find((candidate) => existsSync(candidate));
	if (npmCli) return run(process.execPath, [npmCli, ...args], options);
	const command = process.platform === "win32" ? "npm.cmd" : "npm";
	return run(command, args, { ...options, shell: process.platform === "win32" });
}

function parseJsonOutput(stdout, label) {
	const text = String(stdout || "").trim();
	const start = text.indexOf("{");
	assert(start >= 0, `${label} must emit JSON`);
	return JSON.parse(text.slice(start));
}

function cliJson(args) {
	return parseJsonOutput(run(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "cli/bin.ts", ...args, "--json"]), `browser-pilot ${args.join(" ")}`);
}

function readJson(relativePath) {
	return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function parsePack(stdout) {
	const start = stdout.indexOf("[");
	assert(start >= 0, "npm pack must emit JSON");
	return JSON.parse(stdout.slice(start))[0];
}

function packageFilesSnapshot() {
	const pack = parsePack(npm(["pack", "--dry-run", "--ignore-scripts", "--json"]));
	return {
		entryCount: pack.files.length,
		files: pack.files.map((file) => file.path).sort(),
	};
}

function commandSnapshot() {
	const snapshot = cliJson(["commands"]);
	return {
		ok: snapshot.ok,
		commandCount: Array.isArray(snapshot.commands) ? snapshot.commands.length : 0,
		commands: snapshot.commands,
	};
}

function outputSnapshots() {
	return parseJsonOutput(run(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "scripts/contract-output-fixtures.ts"]), "output contract fixtures");
}

function buildSnapshots() {
	const snapshots = {
		"contracts/cli/commands.snapshot.json": commandSnapshot(),
		"contracts/cli/schema.observe.snapshot.json": cliJson(["schema", "observe"]),
		"contracts/cli/schema.execute.snapshot.json": cliJson(["schema", "execute"]),
		"contracts/cli/schema.command.snapshot.json": cliJson(["schema", "command"]),
		"contracts/cli/schema.upload.snapshot.json": cliJson(["schema", "upload"]),
		"contracts/protocol/native-command.schema.snapshot.json": readJson("src/bridge/protocol/native-command.schema.json"),
		"contracts/package/package-files.snapshot.json": packageFilesSnapshot(),
		"contracts/breaking-names.snapshot.json": {
			envPrefix: "BROWSER_PILOT_",
			stateRoot: ".browser-pilot/",
			refScheme: "bp-ref://",
			controlHeaders: ["x-browser-pilot-daemon-token", "x-browser-pilot-pairing-token"],
			extensionPackage: "bridge/browser_pilot_bridge",
			extensionSource: "src/bridge/extension",
			pageSymbols: "__browser_pilot_*",
			internalSymbols: "browserPilot*/BrowserPilot*",
		},
		...outputSnapshots(),
	};
	const count = snapshots["contracts/cli/commands.snapshot.json"].commandCount;
	assert.equal(count, 21, `command count must stay 21 (browser_pick removed), got ${count}`);
	return snapshots;
}

function stableJson(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}

const snapshots = buildSnapshots();
let drift = false;
for (const [relativePath, value] of Object.entries(snapshots)) {
	const absolute = path.join(root, relativePath);
	const next = stableJson(value);
	if (mode === "record") {
		mkdirSync(path.dirname(absolute), { recursive: true });
		writeFileSync(absolute, next, "utf8");
		continue;
	}
	if (!existsSync(absolute)) {
		console.error(`missing contract snapshot: ${relativePath}`);
		drift = true;
		continue;
	}
	const current = readFileSync(absolute, "utf8");
	if (current !== next) {
		console.error(`contract drift: ${relativePath}`);
		drift = true;
	}
}

if (drift) process.exit(1);
console.log(mode === "record" ? `recorded ${Object.keys(snapshots).length} contract snapshots` : `verified ${Object.keys(snapshots).length} contract snapshots`);
