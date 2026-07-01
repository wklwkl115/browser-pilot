import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assertInsideRoot(target) {
	const resolved = path.resolve(target);
	const relative = path.relative(root, resolved);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`refusing to remove path outside workspace: ${resolved}`);
	}
	return resolved;
}

for (const relativePath of [
	"dist",
	"bridge/browser_pilot_bridge/dist",
	".cache/tsconfig.build.tsbuildinfo",
]) {
	rmSync(assertInsideRoot(path.join(root, relativePath)), { recursive: true, force: true });
}
