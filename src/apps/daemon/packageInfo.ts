import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "browser-pilot";
export const DAEMON_PROTOCOL_VERSION = "4";

function packageMetadata(): { root: string; pkg: { name?: unknown; version?: unknown } } | undefined {
	let dir = path.dirname(fileURLToPath(import.meta.url));
	while (true) {
		try {
			const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
			if (pkg.name === PACKAGE_NAME) return { root: dir, pkg };
		} catch {
			/* keep walking */
		}
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export function packageRoot(): string | undefined {
	return packageMetadata()?.root;
}

export function packageVersion(): string {
	const version = packageMetadata()?.pkg.version;
	return typeof version === "string" ? version : "unknown";
}

export function daemonVersion(): string {
	return `${packageVersion()}+daemon.${DAEMON_PROTOCOL_VERSION}`;
}
