import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const EXTENSION_PORT_PATCH_BUNDLES = ["service-worker.js", "offscreen.js"];

function normalizeBridgePort(bridgePort) {
	const port = Number(bridgePort);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid bridge port: ${bridgePort}`);
	return port;
}

export async function patchExtensionDistPort(extensionDir, bridgePort) {
	const port = normalizeBridgePort(bridgePort);
	const patched = [];
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
	return { patched };
}
