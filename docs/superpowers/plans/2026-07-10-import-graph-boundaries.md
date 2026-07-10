# Import Graph Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a transitive architecture audit with a real `PURE_CROSSCUTTING` allowlist and make kernel purity mechanically true.

**Architecture:** Build a reusable ESM import graph parser/resolver, apply repository boundary rules separately from reachability, and test rules against temporary fixture graphs. Kernel code may import other kernels, allowlisted helpers with pure closure, and only the enumerated session `node:crypto` exception.

**Tech Stack:** Node.js 22 ESM, filesystem graph analysis, Node test runner, mise governance gates.

---

### Task 1: Extract A Reusable Static Import Graph

**Files:**
- Create: `scripts/architecture/importGraph.mjs`
- Create: `tests/governance/importGraph.test.ts`

- [ ] **Step 1: Write failing graph parser tests**

Create temporary `.ts` fixtures and assert static import, export-from, type import, and literal dynamic
import edges resolve `.js` specifiers to `.ts`. Assert non-literal dynamic imports are reported as
unsupported rather than silently ignored.

```ts
const graph = buildImportGraph({ root: fixtureRoot, sourceFiles: ["src/a.ts", "src/b.ts"] });
assert.deepEqual(graph.edges.get("src/a.ts"), ["src/b.ts"]);
assert.deepEqual(graph.unsupported, []);
```

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/governance/importGraph.test.ts`

Expected: FAIL because the graph module is missing.

- [ ] **Step 3: Implement graph construction**

Export `scanSourceFiles()`, `parseStaticSpecifiers()`, `resolveLocalImport()`,
`buildImportGraph()`, and `findDependencyPath()`. Reuse the repository's `.js` to `.ts/.mts/.d.ts`
resolution behavior from the current reachability audit. Store normalized repository-relative paths.

```js
export function findDependencyPath(graph, start, predicate) {
	const queue = [[start]];
	const seen = new Set([start]);
	while (queue.length) {
		const path = queue.shift();
		const current = path.at(-1);
		if (current !== start && predicate(current)) return path;
		for (const next of graph.edges.get(current) || []) {
			if (!seen.has(next)) { seen.add(next); queue.push([...path, next]); }
		}
	}
	return undefined;
}
```

- [ ] **Step 4: Run and verify GREEN**

Run: `node --import tsx --test tests/governance/importGraph.test.ts`

Expected: static imports, exports, dynamic imports, unsupported forms, and resolution errors pass.

- [ ] **Step 5: Commit the graph library**

```bash
git add scripts/architecture/importGraph.mjs tests/governance/importGraph.test.ts
git commit -m "test: add reusable ESM import graph"
```

### Task 2: Define Kernel And Pure Helper Rules

**Files:**
- Create: `scripts/architecture/boundaryRules.mjs`
- Create: `tests/governance/architectureBoundaries.test.ts`

- [ ] **Step 1: Write failing direct/transitive rule tests**

```ts
test("kernel rejects a direct command dependency", () => {
	const result = auditArchitecture(fixture({ "src/kernels/a.ts": 'import "../../commands/x.js";' }));
	assert.match(result.violations[0].message, /src\/kernels\/a\.ts -> src\/commands\/x\.ts/);
});

test("allowlisted helper rejects an impure transitive dependency", () => {
	const result = auditArchitecture(fixture({
		"src/kernels/a.ts": 'import "../../utils/records.js";',
		"src/utils/records.ts": 'import "node:fs";',
	}));
	assert.match(result.violations[0].message, /a\.ts -> .*records\.ts -> node:fs/);
});

test("only session kernel may use enumerated crypto imports", () => {
	assert.equal(auditArchitecture(sessionCryptoFixture()).ok, true);
	assert.equal(auditArchitecture(abmlCryptoFixture()).ok, false);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/governance/architectureBoundaries.test.ts`

Expected: FAIL because rules and the allowlist are absent.

- [ ] **Step 3: Implement the explicit allowlist and closure audit**

Export:

```js
export const PURE_CROSSCUTTING = new Set([
	"src/utils/records.ts",
	"src/utils/json.ts",
	"src/utils/redaction.ts",
]);

export const SESSION_NODE_EXCEPTIONS = new Map([
	["node:crypto", new Set([
		"src/kernels/session/leaseDiagnostics.ts",
		"src/kernels/session/leaseRegistry.ts",
		"src/kernels/session/observationSnapshotRegistry.ts",
		"src/kernels/session/operationRegistry.ts",
		"src/kernels/session/sessionRegistry.ts",
	])],
]);
```

Before accepting these exact entries, inspect each transitive closure. Remove an entry or split a
helper when its closure is not pure. Violation output includes rule ID, source, target, and the full
shortest dependency path.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --import tsx --test tests/governance/architectureBoundaries.test.ts`

Expected: direct, transitive, allowlist, Node built-in, npm, and session exception tests pass.

- [ ] **Step 5: Commit boundary rules**

```bash
git add scripts/architecture/boundaryRules.mjs tests/governance/architectureBoundaries.test.ts
git commit -m "test: define kernel dependency boundaries"
```

### Task 3: Make ABML Error Normalization Physically Pure

**Files:**
- Create: `src/kernels/shared/unknownError.ts`
- Modify: `src/kernels/abml/errors.ts`
- Modify: `tests/bootstrap/kernelRuntimeHelpers.test.ts`
- Modify: `tests/governance/architectureBoundaries.test.ts`

- [ ] **Step 1: Write the failing pure helper characterization**

```ts
test("kernel unknown-error normalization preserves safe Error fields", () => {
	const normalized = normalizeUnknownError(Object.assign(new Error("failed"), { code: "ABML_FAILED", details: { phase: "read" } }));
	assert.deepEqual(normalized, { name: "Error", message: "failed", code: "ABML_FAILED", details: { phase: "read" } });
});

test("ABML errors no longer reach utils/errors", () => {
	const result = auditRepositoryArchitecture(repoRoot);
	assert.equal(result.paths.some((path) => path.join(" -> ").includes("kernels/abml/errors.ts -> src/utils/errors.ts")), false);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/bootstrap/kernelRuntimeHelpers.test.ts tests/governance/architectureBoundaries.test.ts`

Expected: FAIL because the kernel-owned helper is missing and the current import edge exists.

- [ ] **Step 3: Implement and switch the owner**

`normalizeUnknownError(value)` returns only bounded plain fields required by ABML recovery shaping.
It uses no Node or npm imports. Replace `normalizeError` from `src/utils/errors.ts` in ABML errors
without changing normalized ABML error codes, messages, redaction, or recovery.

```ts
export function normalizeUnknownError(value: unknown): Record<string, unknown> {
	if (value instanceof Error) {
		const error = value as Error & { code?: unknown; details?: unknown };
		return {
			name: error.name || "Error",
			message: error.message,
			...(typeof error.code === "string" ? { code: error.code } : {}),
			...(error.details && typeof error.details === "object" ? { details: error.details } : {}),
		};
	}
	return { name: "Error", message: typeof value === "string" ? value : String(value) };
}
```

- [ ] **Step 4: Run and verify GREEN**

Run: `node --import tsx --test tests/bootstrap/kernelRuntimeHelpers.test.ts tests/governance/architectureBoundaries.test.ts`

Expected: behavior parity and architecture closure pass.

- [ ] **Step 5: Commit the pure error owner**

```bash
git add src/kernels/shared/unknownError.ts src/kernels/abml/errors.ts tests/bootstrap/kernelRuntimeHelpers.test.ts tests/governance/architectureBoundaries.test.ts
git commit -m "refactor: keep ABML error normalization pure"
```

### Task 4: Add The Architecture Audit CLI And Gate

**Files:**
- Create: `scripts/audit-architecture.mjs`
- Modify: `scripts/audit-reachability.mjs`
- Modify: `scripts/run-validation.mjs`
- Modify: `package.json`
- Modify: `mise.toml`
- Modify: `tests/governance/workflow.test.ts`

- [ ] **Step 1: Write failing gate ownership tests**

Assert that reachability imports the shared graph implementation, architecture has a separate CLI,
`package.json` exposes `audit:architecture`, and verify runs reachability plus architecture before
tests/build.

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/run-tests.mjs governance`

Expected: FAIL because the new audit is not wired.

- [ ] **Step 3: Implement CLI and validation integration**

`scripts/audit-architecture.mjs` prints
`ok: architecture files=<n> edges=<n> violations=0 pureHelpers=<n>` on success and one structured
line per violation on failure. `run-validation.mjs` executes architecture alongside reachability,
main typecheck, extension typecheck, protocol drift, and tests in verify mode.

Add:

```json
"audit:architecture": "node scripts/audit-architecture.mjs"
```

- [ ] **Step 4: Verify the audit catches a controlled fixture and passes the repository**

Run: `node --import tsx --test tests/governance/importGraph.test.ts tests/governance/architectureBoundaries.test.ts`

Expected: fixture violations are detected and tests pass.

Run: `npm run audit:architecture`

Expected: repository audit exits 0 with `violations=0`.

- [ ] **Step 5: Commit the canonical gate**

```bash
git add scripts/audit-architecture.mjs scripts/audit-reachability.mjs scripts/run-validation.mjs package.json mise.toml tests/governance/workflow.test.ts
git commit -m "ci: enforce architecture import graph"
```

### Task 5: Synchronize The Owner Documentation

**Files:**
- Modify: `src/kernels/abml/README.md`
- Modify: `CODE_WIKI.md`
- Modify: `REPO_GOVERNANCE.md`
- Modify: `tests/governance/workflow.test.ts`

- [ ] **Step 1: Write failing documentation-owner tests**

Require ABML README to link the real architecture script and name `PURE_CROSSCUTTING`; require
`CODE_WIKI.md` to distinguish reachability from architecture closure; require governance to name
the architecture audit as part of verify.

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/run-tests.mjs governance`

Expected: FAIL against the stale nonexistent-whitelist wording.

- [ ] **Step 3: Update canonical owner text**

Document the exact allowed helper list location, transitive closure rule, session crypto exception,
and maintenance sequence for proposing a new pure helper. Do not duplicate the list into Markdown;
link to the script owner.

- [ ] **Step 4: Verify Stage 3**

Run: `mise run dev-governance`

Expected: exit code 0.

Run: `npm run audit:architecture`

Expected: exit code 0.

Run: `mise run affected`

Expected: exit code 0.

- [ ] **Step 5: Commit Stage 3**

```bash
git add src/kernels/abml/README.md CODE_WIKI.md REPO_GOVERNANCE.md tests/governance/workflow.test.ts
git commit -m "docs: define enforced kernel purity boundary"
```
