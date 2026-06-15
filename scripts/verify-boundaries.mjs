import { readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, statSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(root, "src");
const sourceRoots = [
	"src/apps/",
	"src/commands/",
	"src/adapters/",
	"src/kernels/",
	"src/ports/",
	"src/bridge/server/",
	"src/bridge/extension/",
	"cli/",
];

const forbiddenKernelImportFragments = [
	"/apps/",
	"/commands/",
	"/adapters/",
	"/bridge/server/",
	"/bridge/extension/",
	"/cli/",
	"/daemon/",
	"/driver/",
	"/frontend/",
	"/tools/",
	"/resources/",
];

const forbiddenKernelSpecifiers = [
	"node:fs",
	"node:fs/promises",
	"node:http",
	"node:https",
	"node:net",
	"node:child_process",
	"node:process",
	"ws",
];

const layerRules = [
	{
		name: "kernels",
		from: "src/kernels/",
		forbidden: ["src/apps/", "src/commands/", "src/adapters/", "src/bridge/server/", "src/bridge/extension/", "cli/"],
	},
	{
		name: "commands",
		from: "src/commands/",
		forbidden: ["src/apps/", "cli/"],
	},
	{
		name: "adapters",
		from: "src/adapters/",
		forbidden: ["src/apps/", "cli/"],
	},
	{
		name: "bridge server",
		from: "src/bridge/server/",
		forbidden: ["src/apps/", "cli/"],
	},
	{
		name: "apps",
		from: "src/apps/",
		forbidden: ["src/kernels/evidence/distill/", "src/bridge/extension/", "cli/localCommands.ts", "cli/daemon.ts", "cli/index.ts"],
	},
];

function walk(dir) {
	const out = [];
	if (!statExists(dir)) return out;
	for (const entry of readdirSync(dir)) {
		const absolute = join(dir, entry);
		const stat = statSync(absolute);
		if (stat.isDirectory()) out.push(...walk(absolute));
		else if (entry.endsWith(".ts")) out.push(absolute);
	}
	return out;
}

function statExists(path) {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
}

function normalize(path) {
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

function specifiers(source) {
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

function resolvedImportPath(file, specifier) {
	if (!specifier.startsWith(".")) return specifier;
	const base = resolve(dirname(file), specifier);
	const resolved = firstExistingSource(base);
	const relativePath = normalize(relative(root, resolved));
	if (!sourceRoots.some((sourceRoot) => relativePath.startsWith(sourceRoot))) return relativePath;
	return relativePath;
}

function checkLayerRule(rel, resolved, specifier) {
	for (const rule of layerRules) {
		if (!rel.startsWith(rule.from)) continue;
		for (const forbidden of rule.forbidden) {
			if (resolved.startsWith(forbidden)) {
				errors.push(`${rel}: ${rule.name} layer imports forbidden dependency ${specifier} -> ${resolved}`);
			}
		}
	}
}

function checkKernelRule(rel, resolved, specifier) {
	if (!rel.startsWith("src/kernels/")) return;
	if (forbiddenKernelSpecifiers.includes(specifier)) {
		errors.push(`${rel}: kernel imports forbidden side-effect module ${specifier}`);
	}
	if (forbiddenKernelImportFragments.some((fragment) => `/${resolved}`.includes(fragment))) {
		errors.push(`${rel}: kernel imports outer layer ${specifier}`);
	}
}

function checkAppsEntryRule(rel, resolved, specifier) {
	if (rel !== "cli/bin.ts") return;
	if (resolved === "cli/index.ts" || resolved === "cli/localCommands.ts" || resolved === "cli/daemon.ts") {
		errors.push(`${rel}: CLI bin entry must route through src/apps, not ${specifier}`);
	}
}

const errors = [];
for (const file of walk(srcRoot).concat(walk(join(root, "cli")))) {
	const source = readFileSync(file, "utf8");
	const rel = normalize(relative(root, file));
	for (const specifier of specifiers(source)) {
		const normalized = resolvedImportPath(file, specifier);
		checkKernelRule(rel, normalized, specifier);
		checkLayerRule(rel, normalized, specifier);
		checkAppsEntryRule(rel, normalized, specifier);
	}
	if (rel.startsWith("src/kernels/") && (/\bprocess\s*\./.test(source) || /\bprocess\s*\[\s*["']env["']\s*\]/.test(source))) {
		errors.push(`${rel}: kernel must not read process/env`);
	}
	if (rel.startsWith("src/kernels/") && /\bsetTimeout\s*\(|\bsetInterval\s*\(/.test(source)) {
		errors.push(`${rel}: kernel must not own timers or polling`);
	}
}

if (errors.length) {
	console.error(errors.join("\n"));
	process.exit(1);
}
console.log("kernel boundary rules ok");
