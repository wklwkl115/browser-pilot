import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	CHECK_GROUPS,
	CHECK_IMPACT_MAP_PATH,
	DAG_EXTRA_NODE_IDS,
	DEFAULT_GROUP_SEQUENCE,
	ROOT,
	groupScriptSequence,
	packageScripts,
	resolveScriptSteps,
	writeJsonFile,
} from "./check-graph.mjs";
import {
	extractLiteralRepoPaths,
	normalizeInputPath,
	normalizeRel,
	pathKind,
	readText,
	unresolvedInputSites,
	walkEsmImportGraph,
} from "./lib/repo-introspection.mjs";

const checkMode = process.argv.includes("--check");
const scripts = packageScripts(ROOT);

/**
 * Explicit scope overrides for nodes whose inputs cannot be resolved by static
 * analysis (e.g. glob-pattern test commands like `tsx --test tests/unit/abml/**`).
 *
 * Safety rule: unit shards import broadly across src/, so their scope MUST include
 * all of src/ — the goal is only to exclude docs/ and other unrelated trees so a
 * docs-only change skips the shards.  Any code change in src/ must still trigger
 * every shard.  cli/ is included for shards that test CLI code.
 *
 * Format: script → { scope, inputs }
 * inputs are normalised repo-relative paths / directory prefixes (same convention
 * as other paths-scoped impact-map entries).
 */
const SCOPE_OVERRIDES = {
	// Common config inputs shared by all unit shards
	// (tsconfig.json, tsconfig.base.json, package.json govern compilation + test runner)
	"test:unit:abml": {
		scope: "paths",
		inputs: [
			"src/",
			"tests/unit/abml/",
			"tsconfig.json",
			"tsconfig.base.json",
			"package.json",
			"package-lock.json",
		],
	},
	"test:unit:cli:commands": {
		// cli/ contains the tested CLI commands; src/ is imported transitively
		scope: "paths",
		inputs: [
			"src/",
			"cli/",
			"tests/unit/cli/",
			"tsconfig.json",
			"tsconfig.base.json",
			"package.json",
			"package-lock.json",
		],
	},
	"test:unit:cli:daemon": {
		scope: "paths",
		inputs: [
			"src/",
			"cli/",
			"tests/unit/cli/",
			"tsconfig.json",
			"tsconfig.base.json",
			"package.json",
			"package-lock.json",
		],
	},
	"test:unit:distill": {
		scope: "paths",
		inputs: [
			"src/",
			"tests/unit/distill-core/",
			"tsconfig.json",
			"tsconfig.base.json",
			"package.json",
			"package-lock.json",
		],
	},
	"test:unit:temporal": {
		scope: "paths",
		inputs: [
			"src/",
			"tests/unit/temporal-core/",
			"tsconfig.json",
			"tsconfig.base.json",
			"package.json",
			"package-lock.json",
		],
	},
	"test:unit:driver": {
		scope: "paths",
		inputs: [
			"src/",
			"tests/unit/driver/",
			"tsconfig.json",
			"tsconfig.base.json",
			"package.json",
			"package-lock.json",
		],
	},
	"test:unit:memory": {
		scope: "paths",
		inputs: [
			"src/",
			"tests/unit/memory/",
			"tests/unit/memory-core/",
			"tsconfig.json",
			"tsconfig.base.json",
			"package.json",
			"package-lock.json",
		],
	},
	"test:unit:tools": {
		scope: "paths",
		inputs: [
			"src/",
			"tests/unit/tools/",
			"tests/unit/toolAdapter/",
			"tsconfig.json",
			"tsconfig.base.json",
			"package.json",
			"package-lock.json",
		],
	},
	"test:unit:web-security": {
		scope: "paths",
		inputs: [
			"src/",
			"tests/unit/webSecurity/",
			"tsconfig.json",
			"tsconfig.base.json",
			"package.json",
			"package-lock.json",
		],
	},
	"test:unit:misc": {
		// misc covers frontend/, resources/, utils/, validation/ under tests/unit/
		scope: "paths",
		inputs: [
			"src/",
			"tests/unit/frontend/",
			"tests/unit/resources/",
			"tests/unit/utils/",
			"tests/unit/validation/",
			"tsconfig.json",
			"tsconfig.base.json",
			"package.json",
			"package-lock.json",
		],
	},

	// ── Pure boundary checks ──────────────────────────────────────────────────────
	// These checks are static-analysis-only: they walk exactly one source subtree
	// and verify import purity.  They do NOT execute any src logic.
	// Safety: narrowing is safe because the only inputs are (a) the subtree under
	// scrutiny, (b) the check script itself, and (c) purity-vocabulary helpers.
	// A change anywhere in src/ outside the kernel subtree cannot affect the outcome.

	"check:distill-core-boundary": {
		// Walks src/distill-core/ only; checks each file for forbidden imports.
		// purity-vocabulary.js provides the pattern set.
		scope: "paths",
		inputs: [
			"src/distill-core/",
			"tests/contracts/drift/check-distill-core-boundary.mjs",
			"tests/contracts/drift/purity-vocabulary.js",
			"package.json",
			"package-lock.json",
		],
	},

	"check:memory-core-boundary": {
		// Walks src/memory-core/ only; checks each file for forbidden imports.
		scope: "paths",
		inputs: [
			"src/memory-core/",
			"tests/contracts/drift/check-memory-core-boundary.mjs",
			"tests/contracts/drift/purity-vocabulary.js",
			"package.json",
			"package-lock.json",
		],
	},

	"check:temporal-core-boundary": {
		// Walks src/temporal-core/ only; checks each file for forbidden imports.
		scope: "paths",
		inputs: [
			"src/temporal-core/",
			"tests/contracts/drift/check-temporal-core-boundary.mjs",
			"tests/contracts/drift/purity-vocabulary.js",
			"package.json",
			"package-lock.json",
		],
	},

	"check:abml-core-boundary": {
		// Walks src/abml-core/ AND src/abml/ (runtime shims live there).
		// abml-core-manifest.js is the authoritative file-set list read by the check.
		scope: "paths",
		inputs: [
			"src/abml-core/",
			"src/abml/",
			"tests/contracts/drift/abml-core-manifest.js",
			"tests/contracts/drift/check-abml-core-boundary.mjs",
			"tests/contracts/drift/purity-vocabulary.js",
			"package.json",
			"package-lock.json",
		],
	},

	"check:recovery-boundary": {
		// Walks ALL of src/ to hunt for scattered recovery-template patterns (the scatter
		// check at check-recovery-boundary.mjs:115 readdirSync-walks the whole src/ tree).
		// Also reads three specific src files.  Because the whole src/ tree is scanned,
		// any src change can potentially remove a file from the grandfathered list or add
		// a new recovery template — so we include all of src/.
		scope: "paths",
		inputs: [
			"src/",
			"tests/contracts/drift/check-recovery-boundary.mjs",
			"package.json",
			"package-lock.json",
		],
	},

	// ── Summary-tree boundary (structure only) ────────────────────────────────────

	"check:summary-boundary": {
		// Walks src/tools/summaries/ only; counts local truncation sites.
		// Does NOT import/execute any src code.
		scope: "paths",
		inputs: [
			"src/tools/summaries/",
			"tests/contracts/drift/check-summary-boundary.mjs",
			"package.json",
			"package-lock.json",
		],
	},

	// ── Compaction ledger (static source scan) ────────────────────────────────────

	"check:compaction-ledger": {
		// Walks ALL of src/ for truncation-pattern matches against the committed ledger.
		// Also imports assertCompactionTuningBounds from src/distill-core/compactionTuning.ts
		// at runtime, but that only reads the ledger JSON — no full src execution path.
		// Because the scatter walk covers all of src/, any src change may affect results.
		scope: "paths",
		inputs: [
			"src/",
			"docs/compaction-ledger.json",
			"tests/contracts/drift/check-compaction-ledger.mjs",
			"package.json",
			"package-lock.json",
			"tsconfig.json",
			"tsconfig.base.json",
		],
	},

	"check:runtime-fixtures": {
		// Executes local runtime fixtures from bridge service-worker sources plus src helpers.
		// .pi/browser-artifacts/fixtures is output-only and must not affect the public impact map.
		scope: "paths",
		inputs: [
			"bridge_src/service_worker/",
			"src/",
			"tests/contracts/runtime/check-runtime-fixtures.mjs",
			"tests/contracts/runtime/check-input-ref-runtime.mjs",
			"tsconfig.json",
			"tsconfig.base.json",
			"package.json",
			"package-lock.json",
		],
	},

	// ── Eval artifact checks (no src imports) ─────────────────────────────────────

	// check:eval-workflows is intentionally left global: its spawnSync subprocess plus a
	// top-level WORKSTREAMS_A_E_SUMMARY.md existence assert make its footprint unsafe to bound.

	"check:browser-workflow-results": {
		// Reads evals/browser-workflows/results/*.result.json + manifest.json + result-schema.json.
		// No src imports; validates only eval result artifact structure.
		scope: "paths",
		inputs: [
			"evals/browser-workflows/",
			"tests/contracts/tools/check-browser-workflow-results.mjs",
			"package.json",
			"package-lock.json",
		],
	},
};

function entryFromStep(step) {
	if (step.command === "node" || step.command === "tsx") {
		return step.args.find((arg) => /\.(?:mjs|js|ts|tsx)$/.test(arg) && pathKind(normalizeRel(arg), ROOT) === "file");
	}
	return undefined;
}

function commandUnresolvedReason(step) {
	if (step.command === "tsc") return "TypeScript project command has compiler-managed input expansion";
	if (step.command === "eslint") return "ESLint command has config-managed input expansion";
	if (!["node", "tsx"].includes(step.command)) return `unsupported command ${step.command}`;
	if (!entryFromStep(step)) return "script command has no literal JS/TS entry file";
	return undefined;
}

function addInput(inputs, rel) {
	if (!rel) return;
	inputs.add(normalizeInputPath(rel, ROOT));
}

function analyzeEntry(entryRel) {
	const inputs = new Set();
	const unresolved = [];
	const graph = walkEsmImportGraph(entryRel, { root: ROOT });
	for (const item of graph.unresolvedImports) unresolved.push({ ...item, reason: "unresolved relative import" });
	for (const file of graph.files) {
		addInput(inputs, file);
		if (pathKind(file, ROOT) !== "file") continue;
		const text = readText(file, ROOT);
		for (const rel of extractLiteralRepoPaths(text, file, ROOT)) addInput(inputs, rel);
		unresolved.push(...unresolvedInputSites(text, file));
	}
	return { inputs, unresolved };
}

function analyzeScript(script) {
	const inputs = new Set();
	const unresolvedInputs = [];
	const steps = resolveScriptSteps(script, { scripts, root: ROOT });
	for (const step of steps) {
		const reason = commandUnresolvedReason(step);
		if (reason) unresolvedInputs.push({ script, nodeId: step.id, commandLine: step.commandLine, reason });
		const entry = entryFromStep(step);
		if (!entry) continue;
		const analysis = analyzeEntry(normalizeRel(entry));
		for (const input of analysis.inputs) addInput(inputs, input);
		for (const unresolved of analysis.unresolved) unresolvedInputs.push({ script, nodeId: step.id, ...unresolved });
	}
	return {
		script,
		scope: unresolvedInputs.length ? "global" : "paths",
		inputs: [...inputs].sort(),
		unresolvedInputs: unresolvedInputs.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
		commandSteps: steps.map((step) => ({ nodeId: step.id, commandLine: step.commandLine })),
	};
}

function generateImpactMap() {
	const scriptIds = [...new Set([...DAG_EXTRA_NODE_IDS, ...groupScriptSequence(DEFAULT_GROUP_SEQUENCE)])];
	const nodes = {};
	for (const script of scriptIds) {
		const analyzed = analyzeScript(script);
		const override = SCOPE_OVERRIDES[script];
		if (override) {
			// Apply explicit override: replace scope, inputs, and clear unresolvedInputs.
			// The SCOPE_OVERRIDES table is the authoritative declaration of what this node
			// depends on; static analysis failed (unresolvedInputs would have forced global)
			// but the override makes the dependency set explicit and machine-verifiable.
			// Clearing unresolvedInputs preserves the contract invariant:
			//   paths-scoped nodes must have zero unresolved inputs.
			nodes[script] = {
				...analyzed,
				scope: override.scope,
				inputs: [...override.inputs].sort(),
				unresolvedInputs: [],
			};
		} else {
			nodes[script] = analyzed;
		}
	}
	for (const [script, node] of Object.entries(nodes)) {
		assert(node.scope === "global" || node.unresolvedInputs.length === 0, `${script} has unresolved inputs but non-global scope`);
	}
	return {
		schemaVersion: 1,
		source: "scripts/sync-impact-map.mjs",
		groups: Object.fromEntries(Object.entries(CHECK_GROUPS).map(([group, items]) => [group, [...items]])),
		nodes,
	};
}

const next = generateImpactMap();
const text = `${JSON.stringify(next, null, 2)}\n`;
if (checkMode) {
	const current = existsSync(CHECK_IMPACT_MAP_PATH) ? readFileSync(CHECK_IMPACT_MAP_PATH, "utf8") : "";
	if (current !== text) {
		console.error(`check-impact-map drift: run npm run sync:impact-map to update ${path.relative(ROOT, CHECK_IMPACT_MAP_PATH).replace(/\\/g, "/")}`);
		process.exit(1);
	}
	console.log("check impact map ok");
} else {
	writeJsonFile(CHECK_IMPACT_MAP_PATH, next);
	console.log(`wrote ${path.relative(ROOT, CHECK_IMPACT_MAP_PATH).replace(/\\/g, "/")}`);
}
