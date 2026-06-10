// ABML kernel boundary contract.
//
// ABML splits into two layers (see docs/abml-kernel-manifest.md):
//   - PURE CORE  — lives in src/abml-core/. Zero browser/Node dependencies. Pure functions +
//                  types that model a page (entities, refs, AX merge, actionability, verb
//                  decisions). Portable, testable without a browser, candidate for @pi/abml-core.
//   - RUNTIME    — lives in src/abml/. Everything that talks to the live browser
//                  (driver/tools/scan/resources/node).
//
// The dependency direction is one-way: RUNTIME -> PURE CORE, never the reverse. This test locks
// it in. A pure-core file may import ONLY (a) another pure-core file (via ./ within abml-core),
// or (b) a whitelisted cross-cutting module proven transitively pure. Importing driver/tools/
// scan/resources/node, an npm package, a runtime sibling, or reaching back into src/abml/ fails.
//
// src/abml/ keeps the runtime files plus pure-core re-export shims at the old pure-core paths, so every
// existing importer ("../abml/entity.js", "../abml/verbs/router.js", ...) keeps working unchanged.
// This file IS the machine-readable manifest; keep it in sync with docs/abml-kernel-manifest.md.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const abmlCoreDir = path.join(root, "src", "abml-core");
const abmlDir = path.join(root, "src", "abml");
const srcRoot = path.join(root, "src");
const read = (abs) => readFileSync(abs, "utf8");

// --- The manifest (abml-core-relative paths for pure core; abml-relative for runtime) ----------
const PURE_CORE = [
	"types.ts",
	"refId.ts",
	"refPolicy.ts",
	"actionabilityModel.ts",
	"entity.ts",
	"ax.ts",
	"relations.ts",
	"inference.ts",
	"diff.ts",
	"stream.ts",
	"causal.ts",
	"grouping.ts",
	"templating.ts",
	"treeDiff.ts",
	"semanticRefAnchor.ts",
	"snapshotProjection.ts",
	"identityGraph.ts",
	"errors.ts",
	"verbs/router.ts",
	"verbs/click.ts",
	"verbs/type.ts",
	"verbs/scroll.ts",
	"verbs/read.ts",
	"verbs/frame.ts",
	"verbs/pierce.ts",
];
const RUNTIME = [
	"perceptionLedger.ts",
	"verbs/axRuntime.ts",
	"verbs/frameRuntime.ts",
	"verbs/pierceRuntime.ts",
	"verbs/visionRuntime.ts",
	"verbs/runtime.ts",
	"verbs/integration.ts",
];
// Public barrel — the single kernel entry point ("@pi/abml-core in waiting"). Pure (re-exports
// only the core modules); has no re-export shim because no prior consumer imported this path.
const BARREL = "index.ts";

// Cross-cutting modules a pure-core file MAY import. Each verified transitively pure (no
// driver/tools/scan/resources/node in its own closure). Adding here requires re-verifying that.
const PURE_CROSSCUTTING = new Set([
	"utils/records",
	"utils/errors",
	"utils/redaction",
	"utils/json",
	"protocol/nativeErrorCodes",
]);

const FORBIDDEN_SRC_PREFIXES = ["driver/", "tools/", "scan/", "resources/"];
const NODE_BUILTINS = new Set(["fs", "path", "os", "crypto", "http", "https", "net", "child_process", "url", "stream", "events", "util", "buffer"]);

const pureCoreSet = new Set(PURE_CORE);

// --- Completeness: pure core lives in abml-core; abml/ holds runtime + shims --------------------
function walk(baseDir, rel = "") {
	const out = [];
	for (const entry of readdirSync(path.join(baseDir, rel), { withFileTypes: true })) {
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...walk(baseDir, childRel));
		else if (entry.name.endsWith(".ts")) out.push(childRel);
	}
	return out;
}
assert.deepEqual(
	walk(abmlCoreDir).sort(),
	[...PURE_CORE, BARREL].sort(),
	"src/abml-core/ must contain exactly the PURE_CORE files + index.ts barrel (and docs/abml-kernel-manifest.md must match). A new/removed pure-core file changed the set — classify it.",
);
assert.deepEqual(
	walk(abmlDir).sort(),
	[...RUNTIME, ...PURE_CORE].sort(),
	"src/abml/ must contain exactly the runtime files + pure-core re-export shims (one per pure-core path). A new file here is unclassified — add it to RUNTIME, or it belongs in abml-core.",
);

// --- Import extraction -------------------------------------------------------------------------
function importSources(text) {
	const sources = [];
	const patterns = [
		/\bfrom\s*["']([^"']+)["']/g, // import/export ... from "x"
		/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import("x")
		/\bimport\s+["']([^"']+)["']/g, // side-effect import "x"
		/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, // require("x")
	];
	for (const re of patterns) {
		let m;
		while ((m = re.exec(text)) !== null) sources.push(m[1]);
	}
	return sources;
}
const stripExt = (p) => p.replace(/\.(ts|js|mjs)$/i, "");

// Classify an import specifier as seen from a pure-core file at `fromCoreRel`.
function classifySpecifier(spec, fromCoreRel) {
	if (spec.startsWith("node:")) return { kind: "node" };
	if (!spec.startsWith(".")) {
		if (NODE_BUILTINS.has(spec.split("/")[0])) return { kind: "node" };
		return { kind: "bare", spec };
	}
	const fromDirAbs = path.dirname(path.join(abmlCoreDir, fromCoreRel));
	const srcRel = stripExt(path.relative(srcRoot, path.normalize(path.join(fromDirAbs, spec))).split(path.sep).join("/"));
	if (srcRel.startsWith("abml-core/")) return { kind: "core", coreRel: `${srcRel.slice("abml-core/".length)}.ts` };
	if (srcRel === "abml" || srcRel.startsWith("abml/")) return { kind: "runtimeDir", srcRel };
	return { kind: "src", srcRel };
}

// --- The invariant: pure core imports only pure core + whitelisted pure cross-cutting ----------
const violations = [];
for (const fileRel of [...PURE_CORE, BARREL]) {
	const text = read(path.join(abmlCoreDir, fileRel));
	for (const spec of importSources(text)) {
		const c = classifySpecifier(spec, fileRel);
		if (c.kind === "node") violations.push(`abml-core/${fileRel} imports node builtin "${spec}" — pure core must be Node-free.`);
		else if (c.kind === "bare") violations.push(`abml-core/${fileRel} imports npm package "${spec}" — pure core must have zero runtime deps.`);
		else if (c.kind === "core") { if (!pureCoreSet.has(c.coreRel)) violations.push(`abml-core/${fileRel} imports unclassified abml-core file "${spec}" (${c.coreRel}).`); }
		else if (c.kind === "runtimeDir") violations.push(`abml-core/${fileRel} reaches into src/${c.srcRel} (the runtime layer) — import the sibling from abml-core via ./ instead.`);
		else {
			const forbidden = FORBIDDEN_SRC_PREFIXES.find((p) => c.srcRel.startsWith(p));
			if (forbidden) violations.push(`abml-core/${fileRel} imports forbidden layer "${spec}" (src/${c.srcRel}) — pure core must never reach ${forbidden}*.`);
			else if (!PURE_CROSSCUTTING.has(c.srcRel)) violations.push(`abml-core/${fileRel} imports non-whitelisted cross-cutting module "${spec}" (src/${c.srcRel}) — verify it is transitively pure and add to PURE_CROSSCUTTING, or move the consumer to RUNTIME.`);
		}
	}
}
assert.deepEqual(violations, [], `ABML kernel boundary violated:\n  - ${violations.join("\n  - ")}`);

// --- Public path: every pure-core path keeps a thin re-export shim in src/abml/ -----------------
const shimIssues = [];
for (const fileRel of PURE_CORE) {
	const shimPath = path.join(abmlDir, fileRel);
	if (!existsSync(shimPath)) { shimIssues.push(`src/abml/${fileRel} shim missing — importers depend on this path.`); continue; }
	const depth = fileRel.split("/").length - 1; // dirs between the shim and src/abml root
	const target = `${"../".repeat(depth + 1)}abml-core/${stripExt(fileRel)}.js`;
	const text = read(shimPath);
	if (!text.includes(`from "${target}"`)) shimIssues.push(`src/abml/${fileRel} must be a re-export shim of "${target}" (found no such re-export).`);
	for (const spec of importSources(text)) {
		if (!spec.includes("abml-core/")) shimIssues.push(`src/abml/${fileRel} shim must only re-export from abml-core, not import "${spec}".`);
	}
}
assert.deepEqual(shimIssues, [], `ABML shim contract violated:\n  - ${shimIssues.join("\n  - ")}`);

console.log(`abml kernel boundary ok — ${PURE_CORE.length} pure-core files + 1 barrel (src/abml-core), ${RUNTIME.length} runtime files (src/abml), ${PURE_CORE.length} re-export shims, ${PURE_CROSSCUTTING.size} whitelisted cross-cutting modules`);
