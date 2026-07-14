import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? process.execPath : "npm";
const npmPrefix = process.platform === "win32" ? [path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")] : [];
const artifactArg = process.argv.indexOf("--artifact-dir");
const artifactDir = artifactArg >= 0 ? path.resolve(root, process.argv[artifactArg + 1] || "") : undefined;
const ceilings = { compressed: 2_250_000, unpacked: 10_500_000, files: 1_600 };

function execute(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? root,
		env: options.env ?? process.env,
		encoding: "utf8",
		shell: process.platform === "win32" && (command.endsWith(".cmd") || command.endsWith(".bat")),
		maxBuffer: 32 * 1024 * 1024,
	});
	const accepted = options.accepted ?? [0];
	if (!accepted.includes(result.status ?? -1)) throw new Error(`${path.basename(command)} ${args.join(" ")} exited ${result.status}: ${result.stderr || result.stdout}`);
	return result;
}

function parsePackJson(stdout) {
	const start = stdout.indexOf("[");
	const end = stdout.lastIndexOf("]");
	if (start < 0 || end < start) throw new Error(`npm pack --json did not return an array: ${stdout}`);
	const parsed = JSON.parse(stdout.slice(start, end + 1));
	if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error(`npm pack must produce exactly one tarball, got ${parsed.length}`);
	return parsed[0];
}

function normalizedPackagePath(value) {
	return String(value).replace(/\\/g, "/").replace(/^package\//, "");
}

const allowedRootFiles = new Set([
	"package.json", "CHANGELOG.md", "CODE_OF_CONDUCT.md", "README.md", "LICENSE", "SECURITY.md",
	"index.ts", "tsconfig.json", "tsconfig.base.json", "tsconfig.build.json", "tsconfig.bridge-src.json",
	"scripts/build-bridge.mjs", "scripts/clean-build.mjs", "scripts/sync-bridge-config.mjs", "scripts/sync-native-protocol.mjs",
]);
const allowedPrefixes = ["bridge/", "capture-src/", "src/", "dist/", "native/browser-pilot-kernels/src/"];
const allowedNativeFiles = new Set(["native/browser-pilot-kernels/Cargo.toml", "native/browser-pilot-kernels/Cargo.lock"]);

function assertAllowedFile(rawPath) {
	const file = normalizedPackagePath(rawPath);
	if (!file || path.isAbsolute(file) || /^[A-Za-z]:\//.test(file) || file.split("/").includes("..")) throw new Error(`unsafe package path: ${rawPath}`);
	if (/^(?:tests?|coverage|\.browser-pilot)(?:\/|$)/i.test(file) || /(?:^|\/)\.env(?:\.|$)/i.test(file)) throw new Error(`forbidden package file: ${file}`);
	if (/(?:^|\/)(?:\.npmrc|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|[^/]+\.(?:pem|key|p12|pfx))$/i.test(file)) throw new Error(`credential-like package file: ${file}`);
	if (allowedRootFiles.has(file) || allowedNativeFiles.has(file) || allowedPrefixes.some((prefix) => file.startsWith(prefix))) return;
	throw new Error(`package contains a file outside the declared allowlist: ${file}`);
}

async function walkFiles(directory, relative = "") {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const rel = relative ? `${relative}/${entry.name}` : entry.name;
		if (entry.isDirectory()) files.push(...await walkFiles(path.join(directory, entry.name), rel));
		else if (entry.isFile()) files.push(rel);
	}
	return files;
}

function parseJsonOutput(result, label) {
	try {
		return JSON.parse(result.stdout.trim());
	} catch (error) {
		throw new Error(`${label} did not emit JSON: ${result.stdout}`, { cause: error });
	}
}

async function assertNoCheckoutPathLeak(packageRoot) {
	const checkoutForms = [root, root.replace(/\\/g, "/")].map((value) => value.toLowerCase());
	const textExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".json", ".map", ".md", ".toml", ".lock", ".html"]);
	for (const relative of await walkFiles(packageRoot)) {
		if (!textExtensions.has(path.extname(relative).toLowerCase())) continue;
		const file = path.join(packageRoot, relative);
		if ((await stat(file)).size > 4_000_000) continue;
		const text = (await readFile(file, "utf8")).toLowerCase();
		if (checkoutForms.some((form) => text.includes(form))) throw new Error(`package file leaks an absolute checkout path: ${relative}`);
	}
}

async function assertExtension(packageRoot, packageVersion) {
	const bridge = path.join(packageRoot, "bridge", "browser_pilot_bridge");
	const manifest = JSON.parse(await readFile(path.join(bridge, "manifest.json"), "utf8"));
	const build = JSON.parse(await readFile(path.join(bridge, "dist", "build-manifest.json"), "utf8"));
	if (manifest.manifest_version !== 3 || manifest.version !== packageVersion) throw new Error(`extension manifest version mismatch: ${manifest.version}/${packageVersion}`);
	if (build.generated !== true || build.runtimeSwitched !== true || build.manifestTarget !== manifest.background?.service_worker) throw new Error("extension build manifest does not match manifest service worker");
	const runtimeFiles = new Set([manifest.background?.service_worker, ...(manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? [])].filter(Boolean));
	for (const relative of runtimeFiles) await stat(path.join(bridge, relative));
	for (const entry of build.entries ?? []) await stat(path.join(bridge, "dist", path.basename(String(entry.outfile))));
	const serviceWorker = await readFile(path.join(bridge, manifest.background.service_worker), "utf8");
	if (!/^[0-9a-f]{64}$/i.test(String(build.buildId)) || !serviceWorker.includes(build.buildId) || serviceWorker.includes(String(build.buildIdPlaceholder))) throw new Error("extension service worker/buildId consistency failed");
}

const temp = await mkdtemp(path.join(tmpdir(), "browser-pilot-package-smoke-"));
let retainedTarball;
try {
	const packDir = path.join(temp, "pack");
	await mkdir(packDir, { recursive: true });
	const pack = parsePackJson(execute(npm, [...npmPrefix, "pack", "--json", "--pack-destination", packDir]).stdout);
	const tarball = path.resolve(packDir, pack.filename);
	const tarballBytes = (await stat(tarball)).size;
	const files = Array.isArray(pack.files) ? pack.files : [];
	if (tarballBytes !== pack.size) throw new Error(`npm pack compressed size mismatch: ${tarballBytes}/${pack.size}`);
	if (tarballBytes > ceilings.compressed || pack.unpackedSize > ceilings.unpacked || files.length > ceilings.files) throw new Error(`tarball ceiling exceeded: ${JSON.stringify({ tarballBytes, unpackedSize: pack.unpackedSize, fileCount: files.length, ceilings })}`);
	for (const file of files) assertAllowedFile(file.path);
	const packagePaths = new Set(files.map((file) => normalizedPackagePath(file.path)));
	if ([...packagePaths].some((file) => /^bridge\/browser_pilot_bridge\/dist\/.*\.js\.map$/i.test(file))) throw new Error("development-only extension sourcemap leaked into package");
	for (const required of [
		"dist/src/apps/cli/bin.js", "dist/index.js", "dist/index.d.ts",
		"bridge/browser_pilot_bridge/manifest.json", "bridge/browser_pilot_bridge/dist/build-manifest.json", "bridge/browser_pilot_bridge/dist/service-worker.js",
		"native/browser-pilot-kernels/Cargo.toml",
	]) if (!packagePaths.has(required)) throw new Error(`required package file is missing: ${required}`);
	if (![...packagePaths].some((file) => file.startsWith("native/browser-pilot-kernels/src/") && file.endsWith(".rs"))) throw new Error("native Rust source is missing from the package");

	const project = path.join(temp, "install");
	await mkdir(project, { recursive: true });
	await writeFile(path.join(project, "package.json"), JSON.stringify({ private: true, type: "module" }), "utf8");
	const isolatedEnv = {
		...process.env,
		BROWSER_PILOT_DAEMON_STATE_DIR: path.join(temp, "daemon-state"),
		BROWSER_PILOT_AUTH_STATE_DIR: path.join(temp, "auth-state"),
		BROWSER_PILOT_NATIVE_KERNELS: "0",
	};
	execute(npm, [...npmPrefix, "install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: project, env: isolatedEnv });
	const installed = path.join(project, "node_modules", "browser-pilot");
	const installedPackage = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
	if (installedPackage.version !== pack.version) throw new Error(`installed package version mismatch: ${installedPackage.version}/${pack.version}`);
	await assertNoCheckoutPathLeak(installed);
	await assertExtension(installed, installedPackage.version);

	const importCheck = execute(process.execPath, ["--input-type=module", "-e", "const m=await import('browser-pilot'); if(typeof m.BrowserBridgeServer!=='function'||typeof m.defineBrowserCommands!=='function') throw new Error('root exports missing')"], { cwd: project, env: isolatedEnv });
	if (importCheck.stderr) throw new Error(`root ESM import emitted stderr: ${importCheck.stderr}`);
	const fallbackCode = `
const native = await import(${JSON.stringify(pathToFileURL(path.join(installed, "dist", "src", "native", "browserPilotNativeKernels.js")).href)});
const diff = await import(${JSON.stringify(pathToFileURL(path.join(installed, "dist", "src", "kernels", "abml", "diff.js")).href)});
if (native.buildNativeEntityDiff([], []) !== undefined) throw new Error("native binary unexpectedly required");
const value = diff.diffEntities([], []);
if (!value || !Array.isArray(value.appeared)) throw new Error("TypeScript kernel fallback failed");
`;
	execute(process.execPath, ["--input-type=module", "-e", fallbackCode], { cwd: project, env: isolatedEnv });

	await stat(path.join(project, "node_modules", ".bin", process.platform === "win32" ? "browser-pilot.cmd" : "browser-pilot"));
	const installedBin = path.join(installed, "dist", "src", "apps", "cli", "bin.js");
	const runCli = (args, accepted = [0]) => execute(process.execPath, [installedBin, ...args], { cwd: project, env: isolatedEnv, accepted });
	runCli(["--help"]);
	const catalogResult = runCli(["commands", "--json"]);
	const catalog = parseJsonOutput(catalogResult, "commands --json");
	if (catalog.schema !== "browser-pilot-command-catalog/v3" || catalog.contract?.toolCount !== 19 || Buffer.byteLength(catalogResult.stdout, "utf8") > 25 * 1024) throw new Error("installed compact command catalog contract failed");
	const retiredCommands = ["view", "act", "read"];
	if (catalog.commands?.length !== 19 || retiredCommands.some((name) => catalog.commands.some((command) => command.cli === name || command.tool === `browser_${name}`))) throw new Error("installed public command set failed");
	const tabsCatalog = catalog.commands.find((command) => command.cli === "tabs");
	const artifactCatalog = catalog.commands.find((command) => command.cli === "artifact");
	if (!tabsCatalog?.subcommands?.some((route) => route.cli === "list" && route.parameter === "action" && route.value === "list")) throw new Error("installed tabs list route failed");
	if (!["inspect", "paths", "json"].every((mode) => artifactCatalog?.subcommands?.some((route) => route.cli === mode && route.parameter === "mode" && route.value === mode))) throw new Error("installed artifact routes failed");
	const schema = parseJsonOutput(runCli(["schema", "network", "capture-reload", "--json"]), "action schema");
	if (schema.schema !== "browser-pilot-command-schema/v3" || schema.action?.raw !== "captureReload" || schema.parameters?.additionalProperties !== false) throw new Error("installed action-specific schema contract failed");
	const artifactSchema = parseJsonOutput(runCli(["schema", "artifact", "inspect", "--json"]), "artifact inspect schema");
	if (artifactSchema.schema !== "browser-pilot-command-schema/v3" || artifactSchema.parameters?.properties?.mode?.const !== "inspect") throw new Error("installed artifact inspect schema failed");
	const validation = parseJsonOutput(runCli(["validate", "execute", "--params", JSON.stringify({ script: "document.title" }), "--json"]), "offline validate");
	if (validation.valid !== true || validation.args?.script !== "document.title") throw new Error("installed offline validation failed");
	const status = runCli(["status", "--check", "--json"], [1]);
	const statusBody = parseJsonOutput(status, "status --check");
	if (statusBody.ok !== false || statusBody.checked !== true || statusBody.exitCode !== 1) throw new Error("installed no-daemon status check did not fail as expected");

	const sha256 = createHash("sha256").update(await readFile(tarball)).digest("hex");
	const summary = { schema: "browser-pilot-package-smoke/v1", name: pack.name, version: pack.version, filename: pack.filename, sha256, compressedSize: tarballBytes, unpackedSize: pack.unpackedSize, fileCount: files.length };
	if (artifactDir) {
		await mkdir(artifactDir, { recursive: true });
		retainedTarball = path.join(artifactDir, pack.filename);
		await writeFile(retainedTarball, await readFile(tarball));
		await writeFile(path.join(artifactDir, `${pack.filename}.sha256.json`), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
	}
	process.stdout.write(`${JSON.stringify({ ...summary, ...(retainedTarball ? { retainedTarball } : {}) })}\n`);
} finally {
	await rm(temp, { recursive: true, force: true });
}
