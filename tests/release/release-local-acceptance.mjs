import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runNpmSync, throwIfNpmFailed } from "../support/npm-runner.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const artifactsDir = path.join(root, ".pi", "browser-artifacts", "release-acceptance");
const currentDir = path.join(artifactsDir, "current");
const previousDir = path.join(artifactsDir, "previous");
const lastDir = path.join(artifactsDir, "last-successful");
const workDir = path.join(artifactsDir, "work");
const packRunDir = path.join(workDir, "pack-run");
const summaryPath = path.join(artifactsDir, "release-acceptance-summary.json");
const args = new Set(process.argv.slice(2));
const runCurrentSmoke = args.has("--smoke") || args.has("--current-smoke") || process.env.PI_BROWSER_RELEASE_ACCEPTANCE_SMOKE === "1";
const runRollbackSmoke = args.has("--rollback-smoke") || process.env.PI_BROWSER_RELEASE_ROLLBACK_SMOKE === "1";
const keepTempOnFailure = args.has("--keep-temp-on-failure") || process.env.PI_BROWSER_SMOKE_KEEP_TEMP_ON_FAILURE === "1";

function run(command, argv, options = {}) {
	const result = spawnSync(command, argv, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
	if (result.status !== 0) {
		const error = new Error(`${command} ${argv.join(" ")} failed with exit ${result.status ?? result.error?.code ?? "unknown"}`);
		error.details = { command, argv, status: result.status, errorCode: result.error?.code, errorMessage: result.error?.message, stdoutTail: String(result.stdout || "").slice(-4000), stderrTail: String(result.stderr || "").slice(-4000) };
		throw error;
	}
	return result;
}

function runNpm(args, options = {}) {
	return throwIfNpmFailed(runNpmSync(args, { cwd: root, ...options }), `npm ${args.join(" ")}`);
}

function parseNpmJson(stdout) {
	const text = String(stdout || "");
	const start = text.indexOf("[");
	if (start < 0) throw new Error("npm pack did not emit JSON array");
	return JSON.parse(text.slice(start))[0];
}

function packedPaths(pack) {
	return Array.isArray(pack?.files) ? pack.files.map((file) => file.path).sort() : [];
}

function slashPath(value) {
	return value.replace(/\\/g, "/");
}

function tarList(tarball) {
	return run("tar", ["-tzf", path.basename(tarball)], { cwd: path.dirname(tarball) }).stdout.trim().split(/\r?\n/).filter(Boolean).sort();
}

async function extractTarball(tarball, targetDir) {
	await rm(targetDir, { recursive: true, force: true });
	await mkdir(targetDir, { recursive: true });
	run("tar", ["-xzf", slashPath(path.relative(targetDir, tarball))], { cwd: targetDir });
	return path.join(targetDir, "package");
}

async function readJson(file) {
	return JSON.parse(await readFile(file, "utf8"));
}

async function rotatePreviousCandidate() {
	const metadataPath = path.join(lastDir, "release-metadata.json");
	if (!existsSync(metadataPath)) return { status: "missing_first_run" };
	const metadata = await readJson(metadataPath);
	const tarball = metadata?.tarball;
	if (!tarball || !existsSync(tarball)) return { status: "missing_tarball", metadata };
	await rm(previousDir, { recursive: true, force: true });
	await mkdir(previousDir, { recursive: true });
	const previousTarball = path.join(previousDir, path.basename(tarball));
	await copyFile(tarball, previousTarball);
	await writeFile(path.join(previousDir, "release-metadata.json"), JSON.stringify({ ...metadata, tarball: previousTarball, rotatedAt: new Date().toISOString() }, null, 2), "utf8");
	return { status: "available", tarball: previousTarball, metadataPath: path.join(previousDir, "release-metadata.json") };
}

async function verifyUnpackedPackage(packageDir) {
	const manifestPath = path.join(packageDir, "bridge", "pi_browser_bridge", "manifest.json");
	const buildManifestPath = path.join(packageDir, "bridge", "pi_browser_bridge", "dist", "build-manifest.json");
	const manifest = await readJson(manifestPath);
	const buildManifest = await readJson(buildManifestPath);
	const required = [
		path.join(packageDir, "bridge", "pi_browser_bridge", manifest.background.service_worker),
		buildManifestPath,
		path.join(packageDir, "bridge", "pi_browser_bridge", "native_command_schema.json"),
		path.join(packageDir, "bridge_src", "service-worker.ts"),
		path.join(packageDir, "scripts", "build-bridge.mjs"),
	];
	for (const script of manifest.content_scripts || []) {
		for (const item of script.js || []) required.push(path.join(packageDir, "bridge", "pi_browser_bridge", item));
	}
	required.push(path.join(packageDir, "bridge", "pi_browser_bridge", "dist", "hook_dispatcher.js"));
	const missing = required.filter((file) => !existsSync(file));
	if (missing.length) {
		const error = new Error("Packed package is missing required runtime files");
		error.details = { missing };
		throw error;
	}
	if (manifest.background.service_worker !== "dist/service-worker.js") throw new Error(`manifest service_worker must point at dist/service-worker.js, got ${manifest.background.service_worker}`);
	if (buildManifest.serviceWorkerBuildMode !== "esm-import-graph" || buildManifest.orderedConcatenation !== false) {
		const error = new Error("build manifest does not prove ESM import graph runtime");
		error.details = { buildManifest };
		throw error;
	}
	return {
		packageDir,
		extensionDir: path.join(packageDir, "bridge", "pi_browser_bridge"),
		manifest: { serviceWorker: manifest.background.service_worker, contentScripts: (manifest.content_scripts || []).flatMap((script) => script.js || []) },
		buildManifest: {
			serviceWorkerBuildMode: buildManifest.serviceWorkerBuildMode,
			orderedConcatenation: buildManifest.orderedConcatenation,
			legacyServiceWorkerModules: buildManifest.legacyServiceWorkerModules,
			entries: buildManifest.entries,
		},
	};
}

function smokeResultPath(label) {
	return path.join(artifactsDir, `${label}-smoke-browser-isolated-results.json`);
}

function compactSmokeDiagnostics(smokeSummary) {
	const artifact = smokeSummary?.artifact;
	const orchestration = artifact?.orchestration;
	return {
		chromeProfile: artifact?.profileDir,
		bridgePort: artifact?.bridgePort,
		preflight: artifact?.preflight,
		smokeArtifact: smokeSummary?.resultPath,
		innerSmokeArtifact: artifact?.smokeResultPath,
		orchestrationId: orchestration?.orchestrationId,
		operationResults: orchestration?.operationResults,
		bindings: orchestration?.bindings,
		windowTabGroups: orchestration?.windowTabGroups,
		preNavigationHooks: orchestration?.preNavigationHooks,
		profileIsolation: orchestration?.profileIsolation,
		assertions: orchestration?.assertions,
		artifactPaths: [smokeSummary?.resultPath, artifact?.smokeResultPath, ...(Array.isArray(orchestration?.artifactPaths) ? orchestration.artifactPaths : [])].filter(Boolean),
	};
}

async function runIsolatedSmoke(label, extensionDir, minimal) {
	const resultPath = smokeResultPath(label);
	const env = {
		...process.env,
		PI_BROWSER_SMOKE_EXTENSION_DIR: extensionDir,
		PI_BROWSER_SMOKE_RESULT_PATH: resultPath,
		PI_BROWSER_SMOKE_KEEP_TEMP_ON_FAILURE: keepTempOnFailure ? "1" : "",
		...(minimal ? { PI_BROWSER_SMOKE_MINIMAL: "1" } : {}),
	};
	const result = runNpmSync(["run", "smoke:browser:isolated"], { cwd: root, env });
	let artifact;
	if (existsSync(resultPath)) artifact = await readJson(resultPath);
	const summary = { ok: result.status === 0 && artifact?.ok !== false, label, minimal, resultPath, status: result.status, stdoutTail: String(result.stdout || "").slice(-4000), stderrTail: String(result.stderr || "").slice(-4000), artifact };
	summary.diagnostics = compactSmokeDiagnostics(summary);
	if (!summary.ok) {
		const error = new Error(`${label} isolated smoke failed`);
		error.details = { smoke: summary };
		throw error;
	}
	return summary;
}

async function inspectTarball(tarball, label) {
	const packageDir = await extractTarball(tarball, path.join(workDir, label));
	const verified = await verifyUnpackedPackage(packageDir);
	return { tarball, entries: tarList(tarball), ...verified };
}

async function main() {
	await mkdir(artifactsDir, { recursive: true });
	await rm(currentDir, { recursive: true, force: true });
	await mkdir(currentDir, { recursive: true });
	await mkdir(workDir, { recursive: true });
	await rm(packRunDir, { recursive: true, force: true });
	await mkdir(packRunDir, { recursive: true });
	const summary = {
		ok: false,
		createdAt: new Date().toISOString(),
		options: { runCurrentSmoke, runRollbackSmoke, keepTempOnFailure },
		artifactsDir,
		packRunDir,
		summaryPath,
	};
	try {
		summary.previous = await rotatePreviousCandidate();
		const dryRun = parseNpmJson(runNpm(["pack", root, "--dry-run", "--json"], { cwd: packRunDir }).stdout);
		summary.packDryRun = { filename: dryRun.filename, entryCount: dryRun.entryCount, files: packedPaths(dryRun) };
		const actualPack = parseNpmJson(runNpm(["pack", root, "--pack-destination", currentDir, "--json"], { cwd: packRunDir }).stdout);
		const tarball = path.resolve(currentDir, path.basename(actualPack.filename));
		if (!existsSync(tarball)) throw new Error(`npm pack tarball was not created: ${tarball}`);
		summary.current = await inspectTarball(tarball, "current");
		summary.current.pack = { filename: actualPack.filename, shasum: actualPack.shasum, integrity: actualPack.integrity, entryCount: actualPack.entryCount, files: packedPaths(actualPack) };
		if (runCurrentSmoke) summary.current.smoke = await runIsolatedSmoke("current", summary.current.extensionDir, false);
		if (summary.previous.status === "available") {
			summary.rollback = await inspectTarball(summary.previous.tarball, "previous");
			if (runRollbackSmoke) summary.rollback.smoke = await runIsolatedSmoke("rollback", summary.rollback.extensionDir, true);
		} else {
			summary.rollback = { status: summary.previous.status, note: "No previous accepted tarball existed before this run; current tarball is saved as next rollback candidate." };
		}
		await rm(lastDir, { recursive: true, force: true });
		await mkdir(lastDir, { recursive: true });
		const lastTarball = path.join(lastDir, path.basename(tarball));
		await copyFile(tarball, lastTarball);
		await writeFile(path.join(lastDir, "release-metadata.json"), JSON.stringify({
			tarball: lastTarball,
			acceptedAt: new Date().toISOString(),
			manifest: summary.current.manifest,
			buildManifest: summary.current.buildManifest,
			pack: summary.current.pack,
		}, null, 2), "utf8");
		summary.lastSuccessful = { tarball: lastTarball, metadataPath: path.join(lastDir, "release-metadata.json") };
		summary.ok = true;
	} catch (error) {
		summary.ok = false;
		summary.error = error instanceof Error ? error.message : String(error);
		if (error && typeof error === "object" && "details" in error) summary.errorDetails = error.details;
		const failedSmoke = error && typeof error === "object" && "details" in error && error.details && typeof error.details === "object" && "smoke" in error.details ? error.details.smoke : undefined;
		const smokeDiagnostics = compactSmokeDiagnostics(failedSmoke || summary.current?.smoke || summary.rollback?.smoke);
		summary.failureDiagnostics = {
			packFiles: summary.packDryRun?.files || summary.current?.pack?.files || [],
			buildManifest: summary.current?.buildManifest || summary.rollback?.buildManifest,
			...smokeDiagnostics,
		};
		process.exitCode = 1;
	} finally {
		await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
		console.log(JSON.stringify(summary, null, 2));
	}
}

await main();
