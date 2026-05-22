import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

function tail(value, maxChars = 4000) {
	return String(value || "").slice(-maxChars);
}

async function readJsonIfExists(file) {
	if (!existsSync(file)) return undefined;
	return JSON.parse(await readFile(file, "utf8"));
}

function requiredRuntimePaths(extensionSource, manifest) {
	const required = [];
	const serviceWorker = typeof manifest?.background?.service_worker === "string" ? manifest.background.service_worker : undefined;
	if (serviceWorker) required.push(path.join(extensionSource, serviceWorker));
	for (const script of Array.isArray(manifest?.content_scripts) ? manifest.content_scripts : []) {
		for (const item of Array.isArray(script?.js) ? script.js : []) required.push(path.join(extensionSource, item));
	}
	required.push(path.join(extensionSource, "dist", "hook_dispatcher.js"));
	required.push(path.join(extensionSource, "dist", "build-manifest.json"));
	return Array.from(new Set(required.map((item) => path.resolve(item))));
}

async function collectRuntimeState(extensionSource) {
	const manifestPath = path.join(extensionSource, "manifest.json");
	const state = {
		extensionSource,
		manifestPath,
		manifestExists: existsSync(manifestPath),
		manifestValid: false,
		manifestError: undefined,
		manifestServiceWorker: undefined,
		contentScriptFiles: [],
		buildManifestPath: path.join(extensionSource, "dist", "build-manifest.json"),
		requiredPaths: [],
		missingPaths: [],
		buildManifest: undefined,
	};
	if (!state.manifestExists) return state;
	let manifest;
	try {
		manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		state.manifestValid = true;
	} catch (error) {
		state.manifestError = error instanceof Error ? error.message : String(error);
		return state;
	}
	state.manifestServiceWorker = typeof manifest?.background?.service_worker === "string" ? manifest.background.service_worker : undefined;
	state.contentScriptFiles = (Array.isArray(manifest?.content_scripts) ? manifest.content_scripts : []).flatMap((script) => Array.isArray(script?.js) ? script.js : []);
	state.requiredPaths = requiredRuntimePaths(extensionSource, manifest);
	state.missingPaths = state.requiredPaths.filter((item) => !existsSync(item));
	const buildManifest = await readJsonIfExists(state.buildManifestPath);
	if (buildManifest) {
		state.buildManifest = {
			serviceWorkerBuildMode: buildManifest.serviceWorkerBuildMode,
			orderedConcatenation: buildManifest.orderedConcatenation,
			legacyServiceWorkerModules: buildManifest.legacyServiceWorkerModules,
			entries: Array.isArray(buildManifest.entries) ? buildManifest.entries.map((entry) => entry?.name).filter(Boolean) : [],
		};
	}
	return state;
}

export async function resolveIsolatedSmokePreflight({ workspaceRoot, extensionSource, autoBuild = process.env.PI_BROWSER_SMOKE_AUTO_BUILD !== "0" } = {}) {
	const normalizedWorkspaceRoot = path.resolve(workspaceRoot || process.cwd());
	const normalizedExtensionSource = path.resolve(extensionSource || path.join(normalizedWorkspaceRoot, "bridge", "pi_browser_bridge"));
	const workspaceExtensionSource = path.resolve(normalizedWorkspaceRoot, "bridge", "pi_browser_bridge");
	const buildScriptPath = path.join(normalizedWorkspaceRoot, "scripts", "build-bridge.mjs");
	const eligibleForAutoBuild = normalizedExtensionSource === workspaceExtensionSource && existsSync(buildScriptPath);
	const before = await collectRuntimeState(normalizedExtensionSource);
	const preflight = {
		ok: false,
		reason: "unknown",
		workspaceRoot: normalizedWorkspaceRoot,
		extensionSource: normalizedExtensionSource,
		manifestPath: before.manifestPath,
		buildManifestPath: before.buildManifestPath,
		manifestServiceWorker: before.manifestServiceWorker,
		contentScriptFiles: before.contentScriptFiles,
		requiredPaths: before.requiredPaths,
		missingPathsBefore: before.missingPaths,
		missingPaths: before.missingPaths,
		buildManifest: before.buildManifest,
		autoBuild: {
			enabled: autoBuild,
			eligible: eligibleForAutoBuild,
			attempted: false,
			command: `node ${path.relative(normalizedWorkspaceRoot, buildScriptPath).replace(/\\/g, "/")} --quiet`,
			cwd: normalizedWorkspaceRoot,
		},
	};
	if (!before.manifestExists) {
		preflight.reason = "manifest_missing";
		preflight.remediation = { note: `Extension source is missing manifest.json: ${normalizedExtensionSource}` };
		return preflight;
	}
	if (!before.manifestValid) {
		preflight.reason = "manifest_invalid";
		preflight.remediation = { note: `manifest.json is not valid JSON: ${before.manifestPath}`, error: before.manifestError };
		return preflight;
	}
	if (!before.manifestServiceWorker) {
		preflight.reason = "manifest_service_worker_missing";
		preflight.remediation = { note: `manifest.json must define background.service_worker: ${before.manifestPath}` };
		return preflight;
	}
	let after = before;
	if (before.missingPaths.length > 0 && autoBuild && eligibleForAutoBuild) {
		preflight.autoBuild.attempted = true;
		const build = spawnSync(process.execPath, [buildScriptPath, "--quiet"], {
			cwd: normalizedWorkspaceRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		preflight.autoBuild.status = build.status;
		preflight.autoBuild.signal = build.signal;
		preflight.autoBuild.error = build.error?.message;
		preflight.autoBuild.stdoutTail = tail(build.stdout);
		preflight.autoBuild.stderrTail = tail(build.stderr);
		preflight.autoBuild.ok = build.status === 0 && !build.error;
		after = await collectRuntimeState(normalizedExtensionSource);
	}
	preflight.manifestServiceWorker = after.manifestServiceWorker;
	preflight.contentScriptFiles = after.contentScriptFiles;
	preflight.requiredPaths = after.requiredPaths;
	preflight.missingPaths = after.missingPaths;
	preflight.buildManifest = after.buildManifest;
	preflight.ok = after.missingPaths.length === 0;
	if (preflight.ok) preflight.reason = preflight.autoBuild.attempted ? "auto_built" : "ready";
	else if (preflight.autoBuild.attempted && preflight.autoBuild.ok === false) preflight.reason = "autobuild_failed";
	else if (autoBuild === false && eligibleForAutoBuild) preflight.reason = "autobuild_disabled";
	else preflight.reason = "required_runtime_missing";
	if (!preflight.ok) {
		preflight.remediation = eligibleForAutoBuild
			? {
				command: "npm run build:bridge",
				cwd: normalizedWorkspaceRoot,
				note: autoBuild === false
					? "Set PI_BROWSER_SMOKE_AUTO_BUILD=1 or run the build manually before isolated smoke."
					: `Build the dist runtime before isolated smoke. Missing: ${after.missingPaths.join(", ")}`,
			}
			: {
				note: `Custom extension source is missing runtime files and cannot be auto-built from this workspace: ${normalizedExtensionSource}`,
				missingPaths: after.missingPaths,
			};
	}
	return preflight;
}

export async function ensureIsolatedSmokePreflight(options) {
	const preflight = await resolveIsolatedSmokePreflight(options);
	if (preflight.ok) return preflight;
	const error = new Error(`Isolated smoke preflight failed: ${preflight.reason}`);
	error.details = { preflight };
	throw error;
}
