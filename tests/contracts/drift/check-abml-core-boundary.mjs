// ABML kernel boundary contract.
//
// ABML splits into two layers (see docs/abml-kernel-manifest.md):
//   - PURE CORE  — zero browser/Node dependencies. Pure functions + types that model a page
//                  (entities, refs, AX merge, actionability, verb decisions). Portable, testable
//                  without a browser, and the long-term candidate for @pi/abml-core.
//   - RUNTIME    — everything that talks to the live browser (driver/tools/scan/resources/node).
//
// The dependency direction is one-way: RUNTIME -> PURE CORE, never the reverse. This test locks
// that in. A pure-core file may import ONLY (a) another pure-core file, or (b) a whitelisted
// cross-cutting module proven transitively pure. If anyone slips a driver/tools/scan/resources
// or node import into the kernel — or adds a new abml file without classifying it — CI goes red.
//
// This list IS the machine-readable manifest; keep it in sync with docs/abml-kernel-manifest.md.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const abmlDir = path.join(root, "src", "abml");
const read = (abs) => readFileSync(abs, "utf8");

// --- The manifest (abml-relative paths) -------------------------------------------------------
// Pure core: zero browser/Node deps. Verified by this test, not by convention.
const PURE_CORE = [
	"types.ts",
	"refPolicy.ts",
	"actionabilityModel.ts",
	"resolveModel.ts",
	"entity.ts",
	"ax.ts",
	"stream.ts",
	"errors.ts",
	"verbs/router.ts",
	"verbs/click.ts",
	"verbs/type.ts",
	"verbs/scroll.ts",
	"verbs/read.ts",
	"verbs/frame.ts",
	"verbs/pierce.ts",
];
// Runtime: talks to the live browser (driver/tools/scan/resources/node). Not constrained here
// beyond being explicitly classified — listed so a new file can't silently dodge classification.
const RUNTIME = [
	"verbs/axRuntime.ts",
	"verbs/frameRuntime.ts",
	"verbs/pierceRuntime.ts",
	"verbs/streamRuntime.ts",
	"verbs/visionRuntime.ts",
	"verbs/runtime.ts",
	"verbs/integration.ts",
];

// Cross-cutting modules a pure-core file MAY import. Each has been verified transitively pure
// (no driver/tools/scan/resources/node import in its own dependency closure). Adding to this set
// requires re-verifying that closure stays pure — otherwise move the consumer to RUNTIME instead.
const PURE_CROSSCUTTING = new Set([
	"utils/records",
	"utils/errors",
	"utils/redaction",
	"utils/json",
	"protocol/nativeErrorCodes",
]);

// Path segments that mark a module as runtime — a pure-core file must never reach these.
const FORBIDDEN_SRC_PREFIXES = ["driver/", "tools/", "scan/", "resources/"];
const NODE_BUILTINS = new Set(["fs", "path", "os", "crypto", "http", "https", "net", "child_process", "url", "stream", "events", "util", "buffer"]);

const pureCoreSet = new Set(PURE_CORE);
const runtimeSet = new Set(RUNTIME);

// --- Completeness: every abml .ts file must be classified exactly once -------------------------
function walkAbml(rel = "") {
	const out = [];
	for (const entry of readdirSync(path.join(abmlDir, rel), { withFileTypes: true })) {
		const childRel = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...walkAbml(childRel));
		else if (entry.name.endsWith(".ts")) out.push(childRel);
	}
	return out;
}
const actual = walkAbml().sort();
const classified = [...PURE_CORE, ...RUNTIME].sort();
assert.deepEqual(
	actual,
	classified,
	"every src/abml/*.ts must be classified as PURE_CORE or RUNTIME in this manifest (and in docs/abml-kernel-manifest.md). A new/removed abml file changed the set — classify it.",
);
for (const file of PURE_CORE) assert(!runtimeSet.has(file), `${file} is in both PURE_CORE and RUNTIME`);

// --- Import extraction ------------------------------------------------------------------------
function importSources(text) {
	const sources = [];
	const patterns = [
		/\bfrom\s*["']([^"']+)["']/g, // import ... from "x" / export ... from "x"
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

// Resolve an import specifier (as seen from `fromAbmlRel`) to a key we can classify.
// Returns { kind: "abml", abmlRel } | { kind: "src", srcRel } | { kind: "node" } | { kind: "bare" }.
function classifySpecifier(spec, fromAbmlRel) {
	const stripExt = (p) => p.replace(/\.(ts|js|mjs)$/i, "");
	if (spec.startsWith("node:")) return { kind: "node" };
	if (!spec.startsWith(".")) {
		if (NODE_BUILTINS.has(spec.split("/")[0])) return { kind: "node" };
		return { kind: "bare", spec };
	}
	// Relative — resolve against the importing file's directory, normalize to a src-relative key.
	const fromDirAbs = path.dirname(path.join(abmlDir, fromAbmlRel));
	const targetAbs = path.normalize(path.join(fromDirAbs, spec));
	const srcRoot = path.join(root, "src");
	const srcRel = stripExt(path.relative(srcRoot, targetAbs).split(path.sep).join("/"));
	if (srcRel.startsWith("abml/")) return { kind: "abml", abmlRel: `${srcRel.slice("abml/".length)}.ts` };
	return { kind: "src", srcRel };
}

// --- The invariant: pure core imports only pure core + whitelisted pure cross-cutting ----------
const violations = [];
for (const fileRel of PURE_CORE) {
	const text = read(path.join(abmlDir, fileRel));
	for (const spec of importSources(text)) {
		const c = classifySpecifier(spec, fileRel);
		if (c.kind === "node") {
			violations.push(`${fileRel} imports node builtin "${spec}" — pure core must be Node-free (move the consumer to RUNTIME).`);
		} else if (c.kind === "bare") {
			violations.push(`${fileRel} imports npm package "${spec}" — pure core must have zero runtime deps.`);
		} else if (c.kind === "abml") {
			if (runtimeSet.has(c.abmlRel)) violations.push(`${fileRel} imports RUNTIME sibling "${spec}" (${c.abmlRel}) — pure core must not depend on the runtime layer.`);
			else if (!pureCoreSet.has(c.abmlRel)) violations.push(`${fileRel} imports unclassified abml file "${spec}" (${c.abmlRel}).`);
		} else {
			// src-relative cross-cutting module
			const forbidden = FORBIDDEN_SRC_PREFIXES.find((p) => c.srcRel.startsWith(p));
			if (forbidden) violations.push(`${fileRel} imports forbidden layer "${spec}" (src/${c.srcRel}) — pure core must never reach ${forbidden}*.`);
			else if (!PURE_CROSSCUTTING.has(c.srcRel)) violations.push(`${fileRel} imports non-whitelisted cross-cutting module "${spec}" (src/${c.srcRel}) — verify it is transitively pure and add to PURE_CROSSCUTTING, or move the consumer to RUNTIME.`);
		}
	}
}
assert.deepEqual(violations, [], `ABML kernel boundary violated:\n  - ${violations.join("\n  - ")}`);

console.log(`abml kernel boundary ok — ${PURE_CORE.length} pure-core files, ${RUNTIME.length} runtime files, ${PURE_CROSSCUTTING.size} whitelisted cross-cutting modules`);
