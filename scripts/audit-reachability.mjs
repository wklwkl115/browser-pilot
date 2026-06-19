import fs from "node:fs";
import path from "node:path";

const ROOTS = [
	"index.ts",
	"src/apps/cli/bin.ts",
	"src/apps/cli/main.ts",
	"src/apps/daemon/server.ts",
	"src/bridge/extension/service-worker.ts",
	"src/bridge/extension/page_scripts/content.ts",
	"src/bridge/extension/page_scripts/hook_dispatcher.ts",
	"src/bridge/extension/page_scripts/disable_dialogs.ts",
	"src/bridge/extension/offscreen/transport.ts",
	"src/commands/webSecurity/browserNative/callbackOastWorker.mjs",
];
const SOURCE_DIRS = ["src", "capture-src"];
const SOURCE_FILE_RE = /\.(?:ts|mts|js|mjs)$/;
const IMPORT_PATTERNS = [
	/(?:import|export)\s+(?:type\s+)?(?:[^'";]+?from\s+)?["'](\.{1,2}\/[^"']+)["']/g,
	/import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
];

function walk(dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const filePath = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(filePath, out);
		else if (SOURCE_FILE_RE.test(entry.name)) out.push(toPosix(filePath));
	}
	return out;
}

function toPosix(filePath) {
	return filePath.split(path.sep).join("/");
}

function resolveCandidates(basePath) {
	const ext = path.extname(basePath);
	if (!ext) {
		return [".ts", ".mts", ".js", ".mjs", ".d.ts"].flatMap((suffix) => [basePath + suffix, path.join(basePath, `index${suffix}`)]);
	}
	const stem = basePath.slice(0, -ext.length);
	if (ext === ".js") return [basePath, `${stem}.ts`, `${stem}.mts`, `${stem}.d.ts`];
	if (ext === ".mjs") return [basePath, `${stem}.mts`, `${stem}.ts`, `${stem}.d.ts`];
	return [basePath];
}

const files = [...SOURCE_DIRS.flatMap((dir) => walk(dir)), "index.ts"].filter((filePath) => fs.existsSync(filePath));
const fileSet = new Set(files.map((filePath) => path.normalize(filePath)));

function resolveImport(fromFile, specifier) {
	const basePath = path.resolve(path.dirname(fromFile), specifier);
	for (const candidate of resolveCandidates(basePath)) {
		const relative = toPosix(path.relative(process.cwd(), candidate));
		if (fileSet.has(path.normalize(relative))) return relative;
	}
	return undefined;
}

const graph = new Map();
for (const filePath of files) {
	const text = fs.readFileSync(filePath, "utf8");
	const deps = new Set();
	for (const pattern of IMPORT_PATTERNS) {
		let match;
		while ((match = pattern.exec(text))) {
			const resolved = resolveImport(filePath, match[1]);
			if (resolved) deps.add(resolved);
		}
	}
	graph.set(toPosix(filePath), [...deps]);
}

const seen = new Set();
const stack = ROOTS.filter((filePath) => graph.has(filePath));
while (stack.length) {
	const filePath = stack.pop();
	if (!filePath || seen.has(filePath)) continue;
	seen.add(filePath);
	for (const dep of graph.get(filePath) || []) stack.push(dep);
}

const orphans = [...graph.keys()].filter((filePath) => !seen.has(filePath)).sort();
if (orphans.length === 0) {
	console.log(`ok: reachability roots=${ROOTS.length} files=${graph.size} orphans=0`);
	process.exit(0);
}

console.error(`orphan modules detected (${orphans.length})`);
for (const orphan of orphans) console.error(` - ${orphan}`);
process.exit(1);
