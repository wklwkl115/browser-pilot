import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function statExists(path) {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

export function walkTypescriptFiles(dir) {
	const out = [];
	if (!statExists(dir)) return out;
	for (const entry of readdirSync(dir)) {
		const absolute = join(dir, entry);
		const stat = statSync(absolute);
		if (stat.isDirectory()) out.push(...walkTypescriptFiles(absolute));
		else if (entry.endsWith(".ts")) out.push(absolute);
	}
	return out;
}

export function normalizePath(path) {
	return path.split(sep).join("/");
}

function withoutJsExtension(path) {
	return path.replace(/\.(js|mjs|cjs)$/u, "");
}

function candidateSourcePaths(base) {
	const normalizedBase = withoutJsExtension(base);
	if (extname(normalizedBase)) return [normalizedBase];
	return [
		`${normalizedBase}.ts`,
		`${normalizedBase}.tsx`,
		`${normalizedBase}.mts`,
		`${normalizedBase}.cts`,
		join(normalizedBase, "index.ts"),
		join(normalizedBase, "index.tsx"),
		join(normalizedBase, "index.mts"),
		join(normalizedBase, "index.cts"),
	];
}

function firstExistingSource(base) {
	for (const candidate of candidateSourcePaths(base)) {
		if (statExists(candidate)) return candidate;
	}
	return candidateSourcePaths(base)[0];
}

export function importSpecifiers(source) {
	const imports = [];
	const patterns = [
		/\bimport\s+(?:type\s+)?(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/g,
		/\bexport\s+(?:type\s+)?[^'"]+?\s+from\s+["']([^"']+)["']/g,
		/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
	];
	for (const pattern of patterns) {
		for (let match; (match = pattern.exec(source));) imports.push(match[1]);
	}
	return imports;
}

export function resolvedImportPath(file, specifier, root = projectRoot) {
	if (!specifier.startsWith(".")) return specifier;
	const base = resolve(dirname(file), specifier);
	return normalizePath(relative(root, firstExistingSource(base)));
}

export function layer(relativePath) {
	if (relativePath.startsWith("src/apps/")) return "apps";
	if (relativePath.startsWith("src/commands/")) return "commands";
	if (relativePath.startsWith("src/kernels/")) return "kernels";
	if (relativePath.startsWith("src/adapters/")) return "adapters";
	if (relativePath.startsWith("src/artifacts/")) return "artifacts";
	if (relativePath.startsWith("src/browser-command-runtime/")) return "browser-command-runtime";
	if (relativePath.startsWith("src/browser-runtime/")) return "browser-runtime";
	if (relativePath.startsWith("src/capture/")) return "capture";
	if (relativePath.startsWith("src/content/")) return "content";
	if (relativePath.startsWith("src/memory/")) return "memory";
	if (relativePath.startsWith("src/pick/")) return "pick";
	if (relativePath.startsWith("src/ports/")) return "ports";
	if (relativePath.startsWith("src/resources/")) return "resources";
	if (relativePath.startsWith("src/scan/")) return "scan";
	if (relativePath.startsWith("src/types/")) return "types";
	if (relativePath.startsWith("src/utils/")) return "utils";
	if (relativePath.startsWith("src/validation/")) return "validation";
	if (relativePath.startsWith("src/bridge/server/")) return "bridge/server";
	if (relativePath.startsWith("src/bridge/protocol/")) return "bridge/protocol";
	if (relativePath.startsWith("src/bridge/extension/")) return "bridge/extension";
	if (relativePath.startsWith("src/bridge/")) return "bridge/other";
	if (relativePath.startsWith("cli/")) return "cli";
	if (relativePath.startsWith("src/")) return "src/other";
	return "external";
}

export function collectImportEdges(options = {}) {
	const root = options.root ?? projectRoot;
	const sourceDirs = options.sourceDirs ?? [join(root, "src"), join(root, "cli")];
	const classifyLayer = options.layer ?? layer;
	const edges = [];
	for (const file of sourceDirs.flatMap((dir) => walkTypescriptFiles(dir))) {
		const source = readFileSync(file, "utf8");
		const from = normalizePath(relative(root, file));
		for (const specifier of importSpecifiers(source)) {
			const to = resolvedImportPath(file, specifier, root);
			edges.push({
				from,
				to,
				specifier,
				fromLayer: classifyLayer(from),
				toLayer: classifyLayer(to),
			});
		}
	}
	return edges;
}
