import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function normalizeRel(file) {
	return String(file).replace(/\\/g, "/").replace(/^\.\//, "");
}

export function toRepoRel(absPath, root = ROOT) {
	const rel = path.relative(root, absPath);
	if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
	return normalizeRel(rel);
}

export function readText(rel, root = ROOT) {
	return readFileSync(path.join(root, rel), "utf8");
}

export function pathKind(rel, root = ROOT) {
	const abs = path.join(root, rel);
	if (!existsSync(abs)) return undefined;
	const stat = statSync(abs);
	return stat.isDirectory() ? "directory" : stat.isFile() ? "file" : undefined;
}

export function normalizeInputPath(rel, root = ROOT) {
	const normalized = normalizeRel(rel);
	const kind = pathKind(normalized, root);
	if (kind === "directory") return normalized.endsWith("/") ? normalized : `${normalized}/`;
	return normalized;
}

export function walkFiles(rel, predicate = () => true, root = ROOT) {
	const dir = path.join(root, rel);
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const child = normalizeRel(path.join(rel, entry.name));
		if (entry.isDirectory()) out.push(...walkFiles(child, predicate, root));
		else if (predicate(child)) out.push(child);
	}
	return out;
}

export function extractRelativeImports(text) {
	const imports = [];
	const patterns = [
		/\bimport\s+(?:[^"'()]+?\s+from\s+)?["']([^"']+)["']/g,
		/\bexport\s+[^"']*?\s+from\s+["']([^"']+)["']/g,
		/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
	];
	for (const pattern of patterns) {
		let match;
		while ((match = pattern.exec(text))) {
			if (match[1]?.startsWith(".")) imports.push(match[1]);
		}
	}
	return imports;
}

export function resolveRelativeImport(importerRel, specifier, root = ROOT) {
	const importerDir = path.dirname(importerRel);
	const raw = normalizeRel(path.join(importerDir, specifier));
	const candidates = [];
	const add = (item) => {
		const rel = normalizeRel(item);
		if (!candidates.includes(rel)) candidates.push(rel);
	};
	add(raw);
	if (raw.endsWith(".js")) add(raw.slice(0, -3) + ".ts");
	if (raw.endsWith(".mjs")) add(raw.slice(0, -4) + ".mts");
	if (!/\.[A-Za-z0-9]+$/.test(raw)) {
		for (const ext of [".ts", ".tsx", ".mjs", ".js", ".json"]) add(`${raw}${ext}`);
		for (const ext of ["index.ts", "index.tsx", "index.mjs", "index.js"]) add(path.join(raw, ext));
	}
	for (const rel of candidates) {
		if (pathKind(rel, root) === "file") return rel;
	}
	return undefined;
}

export function walkEsmImportGraph(entryRel, options = {}) {
	const root = options.root || ROOT;
	const seen = new Set();
	const unresolvedImports = [];
	const stack = [normalizeRel(entryRel)];
	while (stack.length) {
		const rel = stack.pop();
		if (seen.has(rel)) continue;
		seen.add(rel);
		if (pathKind(rel, root) !== "file") continue;
		const text = readText(rel, root);
		for (const specifier of extractRelativeImports(text)) {
			const resolved = resolveRelativeImport(rel, specifier, root);
			if (resolved) stack.push(resolved);
			else unresolvedImports.push({ file: rel, specifier });
		}
	}
	return { files: [...seen].sort(), unresolvedImports };
}

function resolveRepoLiteral(fileRel, literal, root = ROOT) {
	if (!literal || /^[A-Za-z]+:/.test(literal)) return undefined;
	const abs = literal.startsWith(".")
		? path.resolve(path.join(root, path.dirname(fileRel)), literal)
		: path.resolve(root, literal);
	return toRepoRel(abs, root);
}

function joinLiteralSegments(segments) {
	const parts = [];
	const pattern = /["']([^"']+)["']/g;
	let match;
	while ((match = pattern.exec(segments))) parts.push(match[1]);
	return parts.length ? normalizeRel(path.join(...parts)) : undefined;
}

export function extractLiteralRepoPaths(text, fileRel, root = ROOT) {
	const paths = new Set();
	const add = (rel) => {
		const resolved = rel ? normalizeInputPath(rel, root) : undefined;
		if (resolved && !resolved.startsWith("../")) paths.add(resolved);
	};
	const callPatterns = [
		/\b(?:read|readRepo|readJson|readSource|readServiceWorkerSource|readPageSource)\s*\(\s*["']([^"']+)["']/g,
		/\breadFileSync\s*\(\s*["']([^"']+)["']/g,
	];
	for (const pattern of callPatterns) {
		let match;
		while ((match = pattern.exec(text))) add(resolveRepoLiteral(fileRel, match[1], root));
	}
	let match;
	const urlPattern = /new\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g;
	while ((match = urlPattern.exec(text))) add(resolveRepoLiteral(fileRel, match[1], root));
	const joinPattern = /path\.join\s*\(\s*(?:root|repoRoot|ROOT|archiveDir|resultsRoot|dir)\s*,\s*((?:(?:"[^"]+"|'[^']+')\s*,?\s*)+)/g;
	while ((match = joinPattern.exec(text))) add(joinLiteralSegments(match[1]));
	return [...paths].sort();
}

export function unresolvedInputSites(text, fileRel) {
	const unresolved = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("//")) continue;
		if (/\b(?:spawnSync|execSync)\s*\(/.test(line)) unresolved.push({ file: fileRel, line: i + 1, reason: "subprocess execution" });
		if (/\b(?:readdirSync|opendirSync)\s*\(/.test(line) && !/path\.join\s*\(\s*(?:root|repoRoot|ROOT|archiveDir|resultsRoot|dir)\s*,\s*["']/.test(line)) {
			unresolved.push({ file: fileRel, line: i + 1, reason: "dynamic directory walk" });
		}
		if (/\breadFileSync\s*\(/.test(line)) {
			const classified = /readFileSync\s*\(\s*(?:["']|new\s+URL\s*\(\s*["']|path\.join\s*\(\s*(?:root|repoRoot|ROOT|archiveDir|resultsRoot|dir)\s*,\s*["'])/.test(line);
			const helperDefinition = /\b(?:const|function)\s+read[A-Za-z0-9_]*\b/.test(line);
			if (!classified && !helperDefinition) unresolved.push({ file: fileRel, line: i + 1, reason: "dynamic file read" });
		}
	}
	return unresolved;
}

export function inputMatchesChangedFile(input, changedFile) {
	const rel = normalizeRel(changedFile);
	const normalized = normalizeRel(input);
	return normalized.endsWith("/") ? rel.startsWith(normalized) : rel === normalized;
}
