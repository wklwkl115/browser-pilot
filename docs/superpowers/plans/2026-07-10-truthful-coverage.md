# Truthful Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the misleading near-empty 80-percent coverage gate with a truthful nightly per-domain non-regression ratchet.

**Architecture:** Keep Node's built-in V8 test coverage, parse its file table into a stable JSON report, classify measured files by repository domain, and compare against an explicit checked-in baseline. Release verification stays deterministic and does not run coverage; nightly CI owns the blocking ratchet.

**Tech Stack:** Node.js 22 test runner and V8 coverage, ESM scripts, JSON baseline, mise, GitHub Actions.

---

### Task 1: Define The Measured Scope

**Files:**
- Create: `scripts/coverage/coverageScope.mjs`
- Create: `tests/governance/coverageScope.test.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write failing classification tests**

```ts
test("coverage scope includes handwritten Node-loadable source by domain", () => {
	assert.deepEqual(classifyCoveragePath("src/kernels/temporal/classify.ts"), { included: true, domain: "kernels" });
	assert.deepEqual(classifyCoveragePath("src/commands/observe/scanRunner.ts"), { included: true, domain: "commands" });
	assert.deepEqual(classifyCoveragePath("src/bridge/server/BrowserBridgeServer.ts"), { included: true, domain: "bridge-server" });
});

test("coverage scope excludes only owned non-Node or generated surfaces", () => {
	assert.equal(classifyCoveragePath("src/bridge/extension/service-worker.ts").reason, "mv3-extension-runtime");
	assert.equal(classifyCoveragePath("src/types/nativeProtocol.ts").reason, "generated-native-protocol");
	assert.equal(classifyCoveragePath("src/commands/nativeActionMetadata.ts").reason, "generated-native-protocol");
	assert.equal(classifyCoveragePath("dist/index.js").reason, "generated-output");
});

test("every TypeScript source path is included or has a named exclusion", () => {
	for (const file of listCoverageSourceFiles(process.cwd())) {
		const classification = classifyCoveragePath(file);
		assert.ok(classification.included || classification.reason, file);
	}
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --import tsx --test tests/governance/coverageScope.test.ts`

Expected: FAIL because the coverage scope owner does not exist.

- [ ] **Step 3: Implement explicit classification**

Export `COVERAGE_EXCLUSIONS`, `classifyCoveragePath()`, and `listCoverageSourceFiles()`. Normalize paths to `/`; exclude only generated outputs, the extension worker/page environment, and schema-derived files with exact path rules. Return domains from the first stable owner segment rather than ad hoc filename matching.

```js
export function classifyCoveragePath(input) {
	const file = normalizePath(input);
	const exclusion = COVERAGE_EXCLUSIONS.find((rule) => rule.matches(file));
	if (exclusion) return { included: false, reason: exclusion.reason };
	if (!file.startsWith("src/") && file !== "index.ts") return { included: false, reason: "outside-runtime-source" };
	return { included: true, domain: coverageDomain(file) };
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --import tsx --test tests/governance/coverageScope.test.ts`

Expected: all scope ownership tests pass.

- [ ] **Step 5: Commit scope ownership**

```bash
git add scripts/coverage/coverageScope.mjs tests/governance/coverageScope.test.ts scripts/run-tests.mjs
git commit -m "test: define truthful coverage scope"
```

### Task 2: Parse Stable V8 Coverage Results

**Files:**
- Create: `scripts/coverage/coverageReport.mjs`
- Create: `tests/governance/coverageReport.test.ts`

- [ ] **Step 1: Write failing report parser tests**

Use a fixed Node coverage table fixture and assert Windows/Unix path normalization, percentages,
uncovered lines, and domain aggregation:

```ts
const parsed = parseNodeCoverageTable(COVERAGE_TABLE_FIXTURE);
assert.deepEqual(parsed.files[0], {
	path: "src/kernels/temporal/classify.ts",
	lines: 92.5,
	branches: 81.25,
	functions: 100,
	uncoveredLines: [44, 51],
});
assert.deepEqual(aggregateCoverageByDomain(parsed.files).kernels, {
	lines: 92.5,
	branches: 81.25,
	functions: 100,
	files: 1,
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/governance/coverageReport.test.ts`

Expected: FAIL because `coverageReport.mjs` is absent.

- [ ] **Step 3: Implement parser and weighted aggregation**

Export `parseNodeCoverageTable(text)`, `aggregateCoverageByDomain(files)`, and
`writeCoverageSummary(path, report)`. Reject missing table headers, malformed numeric cells, duplicate normalized paths, and an empty measured set. Preserve raw percentages without rounding until JSON rendering.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --import tsx --test tests/governance/coverageReport.test.ts`

Expected: parser, normalization, rejection, and aggregation tests pass.

- [ ] **Step 5: Commit report parsing**

```bash
git add scripts/coverage/coverageReport.mjs tests/governance/coverageReport.test.ts
git commit -m "test: parse Node coverage by domain"
```

### Task 3: Add The Checked-In Ratchet

**Files:**
- Create: `scripts/coverage/coverageBaseline.mjs`
- Create: `scripts/coverage-baseline.json`
- Create: `tests/governance/coverageBaseline.test.ts`

- [ ] **Step 1: Write failing baseline comparison tests**

```ts
test("coverage ratchet rejects a domain regression", () => {
	const result = compareCoverage({ commands: metric(60, 55, 50) }, { commands: metric(61, 55, 50) });
	assert.equal(result.ok, false);
	assert.match(result.failures[0], /commands lines 60 < baseline 61/);
});

test("coverage ratchet rejects a missing measured file", () => {
	const result = compareCoverage(report(["src/a.ts"]), baseline(["src/a.ts", "src/b.ts"]));
	assert.equal(result.ok, false);
	assert.match(result.failures.join("\n"), /src\/b\.ts disappeared/);
});

test("baseline updates require an explicit update mode", async () => {
	await assert.rejects(() => updateCoverageBaseline(current, { explicit: false }), /explicit update/);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/governance/coverageBaseline.test.ts`

Expected: FAIL because the baseline comparator is absent.

- [ ] **Step 3: Implement non-regression comparison**

The baseline schema is:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-10T00:00:00.000Z",
  "domains": {
    "commands": { "lines": 0, "branches": 0, "functions": 0, "files": 0 }
  },
  "measuredFiles": []
}
```

`compareCoverage()` rejects metric decreases beyond 0.01 percentage points, missing domains,
missing baseline files, and eligible files that are neither measured nor explicitly excluded.
`--update-baseline` writes a sorted deterministic file only when explicitly supplied.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --import tsx --test tests/governance/coverageBaseline.test.ts`

Expected: all ratchet behavior tests pass.

- [ ] **Step 5: Commit baseline mechanics**

```bash
git add scripts/coverage/coverageBaseline.mjs scripts/coverage-baseline.json tests/governance/coverageBaseline.test.ts
git commit -m "test: add per-domain coverage ratchet"
```

### Task 4: Replace The Misleading Coverage Runner

**Files:**
- Modify: `scripts/run-coverage.mjs`
- Modify: `mise.toml`
- Modify: `tests/governance/workflow.test.ts`

- [ ] **Step 1: Write failing runner-governance tests**

Assert that the runner no longer contains blanket exclusions for apps, commands, bridge server,
runtime, artifacts, memory, resources, scan, utils, validation, or kernels. Assert it imports the
scope/report/baseline owners, writes `coverage/summary.json`, and accepts only `--update-baseline`
as the baseline mutation flag.

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/run-tests.mjs governance`

Expected: FAIL against the current blanket exclusion list.

- [ ] **Step 3: Implement the runner**

Spawn Node coverage with captured stdout/stderr, echo both streams, parse the final table, filter
through `classifyCoveragePath()`, write `coverage/summary.json`, then compare with
`scripts/coverage-baseline.json`. Do not pass hardcoded 80-percent threshold flags. Exit nonzero
with one line per domain/file regression.

Add a separate maintenance task:

```toml
[tasks.coverage-update]
description = "Explicitly update the checked-in truthful coverage baseline"
run = "node scripts/run-coverage.mjs all --update-baseline"
```

- [ ] **Step 4: Generate the first truthful baseline**

Run: `mise run coverage-update`

Expected: `coverage/summary.json` and `scripts/coverage-baseline.json` contain non-empty measured
files and real per-domain metrics. Inspect every exclusion reason before staging the baseline.

- [ ] **Step 5: Prove the ratchet passes and detects regression**

Run: `mise run coverage`

Expected: exit code 0 against the new baseline.

Use the comparator fixture to pass a lower domain metric and require a failing result that names
the domain and metric. Do not change the checked-in baseline for this proof.

- [ ] **Step 6: Commit the runner and real baseline**

```bash
git add scripts/run-coverage.mjs scripts/coverage-baseline.json mise.toml tests/governance/workflow.test.ts
git commit -m "ci: make coverage a truthful domain ratchet"
```

### Task 5: Nightly Policy And Canonical Documentation

**Files:**
- Create: `.github/workflows/coverage-nightly.yml`
- Modify: `REPO_GOVERNANCE.md`
- Modify: `CODE_WIKI.md`
- Modify: `tests/governance/workflow.test.ts`

- [ ] **Step 1: Write failing policy tests**

Assert that coverage runs from a scheduled/manual workflow, `verify.yml` does not invoke it,
governance names it a nightly ratchet, and `CODE_WIKI.md` no longer claims unqualified whole-repo
80-percent enforcement.

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/run-tests.mjs governance`

Expected: FAIL until the workflow and canonical descriptions agree.

- [ ] **Step 3: Add the nightly workflow and accurate owner text**

The nightly job runs `npm ci`, `mise run coverage`, uploads `coverage/summary.json` plus V8 JSON,
and fails on ratchet regression. `REPO_GOVERNANCE.md` defines release, nightly, and maintenance
gate ownership without teaching raw npm commands.

- [ ] **Step 4: Verify Stage 2**

Run: `mise run dev-governance`

Expected: exit code 0.

Run: `mise run coverage`

Expected: exit code 0 with non-empty domain metrics.

Run: `mise run affected`

Expected: exit code 0.

- [ ] **Step 5: Commit Stage 2**

```bash
git add .github/workflows/coverage-nightly.yml REPO_GOVERNANCE.md CODE_WIKI.md tests/governance/workflow.test.ts
git commit -m "docs: define nightly coverage policy"
```
