import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const EXTENSION_PORT_PATCH_BUNDLES = ["service-worker.js", "offscreen.js"];
const DEFAULT_BUILD_ID_PLACEHOLDER = "__PI_BROWSER_BRIDGE_BUILD_ID_PLACEHOLDER__";
const DEFAULT_FINGERPRINT_INPUTS = [
	"bridge/pi_browser_bridge/dist/content.js",
	"bridge/pi_browser_bridge/dist/disable_dialogs.js",
	"bridge/pi_browser_bridge/dist/hook_dispatcher.js",
	"bridge/pi_browser_bridge/dist/offscreen.js",
	"bridge/pi_browser_bridge/dist/service-worker.js",
	"bridge/pi_browser_bridge/manifest.json",
].sort();

function normalizeBridgePort(bridgePort) {
	const port = Number(bridgePort);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid bridge port: ${bridgePort}`);
	return port;
}

function extensionPathForInput(extensionDir, rel) {
	const normalized = rel.replace(/\\/g, "/");
	const prefix = "bridge/pi_browser_bridge/";
	return path.join(extensionDir, normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized);
}

async function readJson(file) {
	return JSON.parse(await readFile(file, "utf8"));
}

async function recomputeStagedBuildId(extensionDir, manifestPath) {
	const buildManifest = await readJson(manifestPath);
	const placeholder = typeof buildManifest.buildIdPlaceholder === "string" ? buildManifest.buildIdPlaceholder : DEFAULT_BUILD_ID_PLACEHOLDER;
	const previousBuildId = typeof buildManifest.buildId === "string" ? buildManifest.buildId : "";
	const inputs = Array.isArray(buildManifest.inputs) && buildManifest.inputs.length ? [...buildManifest.inputs].sort() : DEFAULT_FINGERPRINT_INPUTS;
	const hash = createHash("sha256");
	for (const rel of inputs) {
		const absolute = extensionPathForInput(extensionDir, rel);
		let bytes = await readFile(absolute);
		if (absolute.endsWith(".js") && previousBuildId) {
			bytes = Buffer.from(bytes.toString("utf8").replaceAll(previousBuildId, placeholder), "utf8");
		}
		hash.update(rel.replace(/\\/g, "/"));
		hash.update("\0");
		hash.update(bytes);
		hash.update("\0");
	}
	const buildId = hash.digest("hex");
	for (const rel of inputs.filter((item) => item.replace(/\\/g, "/").includes("/dist/") && item.endsWith(".js"))) {
		const absolute = extensionPathForInput(extensionDir, rel);
		const source = await readFile(absolute, "utf8");
		await writeFile(absolute, source.replaceAll(previousBuildId || placeholder, placeholder).replaceAll(placeholder, buildId), "utf8");
	}
	await writeFile(manifestPath, `${JSON.stringify({ ...buildManifest, buildId, inputs, buildIdPlaceholder: placeholder }, null, 2)}\n`, "utf8");
	return buildId;
}

export async function patchExtensionDistPort(extensionDir, bridgePort) {
	const port = normalizeBridgePort(bridgePort);
	const patched = [];
	const manifestPath = path.join(extensionDir, "dist", "build-manifest.json");
	if (!existsSync(manifestPath)) throw new Error(`Extension build manifest missing: ${manifestPath}`);
	for (const bundle of EXTENSION_PORT_PATCH_BUNDLES) {
		const target = path.join(extensionDir, "dist", bundle);
		if (!existsSync(target)) throw new Error(`Extension dist bundle missing: ${target}`);
		const source = await readFile(target, "utf8");
		const replacementCount =
			(source.match(/127\.0\.0\.1:18765/g) || []).length
			+ (source.match(/PI_BROWSER_BRIDGE_PORT\s*=\s*18765/g) || []).length
			+ (source.match(/PI_BROWSER_BRIDGE_PORT_RANGE_END\s*=\s*18784/g) || []).length;
		if (!replacementCount) throw new Error(`Extension dist bundle has no bridge port markers to patch: ${target}`);
		const updated = source
			.replaceAll("127.0.0.1:18765", `127.0.0.1:${port}`)
			.replace(/PI_BROWSER_BRIDGE_PORT\s*=\s*18765/g, `PI_BROWSER_BRIDGE_PORT = ${port}`)
			.replace(/PI_BROWSER_BRIDGE_PORT_RANGE_END\s*=\s*18784/g, `PI_BROWSER_BRIDGE_PORT_RANGE_END = ${port}`);
		if (
			(port !== 18765 && /127\.0\.0\.1:18765|PI_BROWSER_BRIDGE_PORT\s*=\s*18765/.test(updated))
			|| (port !== 18784 && /PI_BROWSER_BRIDGE_PORT_RANGE_END\s*=\s*18784/.test(updated))
		) {
			throw new Error(`Extension dist bundle still contains default bridge port markers after patch: ${target}`);
		}
		await writeFile(target, updated, "utf8");
		patched.push({ bundle, replacements: replacementCount });
	}
	const buildId = await recomputeStagedBuildId(extensionDir, manifestPath);
	const env = { PI_BROWSER_EXPECTED_EXTENSION_BUILD_MANIFEST: manifestPath };
	Object.assign(process.env, env);
	return { patched, buildId, manifestPath, env };
}
