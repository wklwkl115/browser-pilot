# Commands Subdomains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize `src/commands` into enforced product subdomains while keeping `commandCatalog.ts` the authoritative and behavior-compatible public tool list.

**Architecture:** Establish characterization snapshots first, then move one dependency layer at a time behind export-only compatibility facades. Remove reverse dependencies through a small evidence augmentation port, update imports mechanically, and enforce the resulting ownership graph with the architecture audit.

**Tech Stack:** TypeScript 6 ESM, TypeBox schemas, Node test runner, existing command runtime/result APIs, architecture audit from Stage 3.

---

### Task 1: Freeze Public Command And Result Contracts

**Files:**
- Create: `tests/cli/commandCatalogParity.test.ts`
- Create: `tests/memory/commandEnvelopeParity.test.ts`
- Modify: `tests/cli/commandSchemaCatalog.test.ts`

- [ ] **Step 1: Write the failing full-parity assertions**

Extend the current count-only coverage so it records ordered command names, CLI subcommands,
normalized parameter schemas, labels, prompt-guideline presence, and the seven web-security names.
Add representative result parity fixtures for tabs, execute, observe, artifact, memory, and security.

```ts
assert.deepEqual(collectCommandDefs().map((item) => item.name), EXPECTED_COMMAND_ORDER);
assert.deepEqual(buildCliCommands().map((item) => item.subcommand), EXPECTED_CLI_SUBCOMMANDS);
assert.deepEqual(schemaDigest(collectCommandDefs()), EXPECTED_SCHEMA_DIGEST);
```

The first RED assertion requires the catalog to expose a stable registrar descriptor API rather
than tests parsing source text.

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/cli/commandCatalogParity.test.ts tests/memory/commandEnvelopeParity.test.ts`

Expected: FAIL because the registrar descriptor API and committed parity fixtures are absent.

- [ ] **Step 3: Add the minimal read-only catalog descriptor**

Modify `src/commands/commandCatalog.ts` to export a frozen descriptor derived from the same arrays:

```ts
export function browserCommandCatalogSnapshot() {
	return Object.freeze({
		coreRegistrars: [...CORE_BROWSER_COMMAND_REGISTRARS],
		securityRegistrars: [...WEB_SECURITY_COMMAND_REGISTRARS],
	});
}
```

Do not add a second tool-name list. Tests obtain names by registering into
`CommandManifestIndex`, then commit stable expected fixtures.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --import tsx --test tests/cli/commandCatalogParity.test.ts tests/memory/commandEnvelopeParity.test.ts`

Expected: all public catalog, CLI, schema, and envelope fixtures pass.

- [ ] **Step 5: Commit the parity lock**

```bash
git add src/commands/commandCatalog.ts tests/cli/commandCatalogParity.test.ts tests/memory/commandEnvelopeParity.test.ts tests/cli/commandSchemaCatalog.test.ts
git commit -m "test: lock command catalog parity"
```

### Task 2: Create Runtime And Evidence Owners

**Files:**
- Create: `src/commands/runtime/`
- Create: `src/commands/evidence/`
- Create: `src/commands/evidence/resultAugmentationPort.ts`
- Modify: `src/commands/defineBrowserCommands.ts`
- Modify: `src/commands/memory/autoSurface.ts`
- Create: `tests/governance/commandOwnership.test.ts`
- Modify: `tests/memory/resultMiddlewareEnvelope.test.ts`

- [ ] **Step 1: Write failing ownership and augmentation tests**

```ts
test("evidence result middleware has no knowledge implementation import", () => {
	const source = read("src/commands/evidence/resultMiddleware.ts");
	assert.doesNotMatch(source, /knowledge|memory\/autoSurface/);
});

test("registered memory augmenter preserves current envelope behavior", async () => {
	setResultMemoryAugmenter(async ({ envelope }) => ({ ...envelope, memory: { matched: 1 } }));
	const result = await augmentResultMemory({ cwd: fixture, envelope: baseEnvelope });
	assert.deepEqual(result.memory, { matched: 1 });
});
```

The ownership test fails because the target directories/files are not present; the port test fails
because evidence directly imports memory today.

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/governance/commandOwnership.test.ts tests/memory/resultMiddlewareEnvelope.test.ts`

Expected: target ownership and augmentation port assertions fail.

- [ ] **Step 3: Implement the evidence-owned augmentation port**

```ts
export type ResultMemoryAugmenter = (input: { cwd?: string; envelope: DistilledEnvelope }) => Promise<DistilledEnvelope>;
let augmenter: ResultMemoryAugmenter = async ({ envelope }) => envelope;
export function setResultMemoryAugmenter(value: ResultMemoryAugmenter): void { augmenter = value; }
export async function augmentResultMemory(input: Parameters<ResultMemoryAugmenter>[0]) { return await augmenter(input); }
```

`defineBrowserCommands()` installs the knowledge adapter once before registration. Tests restore
the default augmenter after each mutation.

- [ ] **Step 4: Move runtime and evidence files**

Move these implementation owners and leave export-only facades at old paths while consumers move:

```text
runtime/: commandRuntime, commandShared, middleware, prepareArguments,
          validationMiddleware, usageLog, budgets, executionEffect, executionJournal
evidence/: resultMiddleware, resultTypes, resultRedaction, resultNextActions,
           resultEvidence, resultEnvelopeBudget, resultBudgeting, distillerRegistry,
           artifactCommand, evidenceCommand, summaries/
```

`commandDefinition.ts`, `commandManifestIndex.ts`, `commandCatalog.ts`, and
`defineBrowserCommands.ts` stay top-level. `nativeActionMetadata.ts` stays top-level because it is
schema-generated.

An old-path facade contains only exports, for example:

```ts
export * from "./runtime/commandRuntime.js";
```

- [ ] **Step 5: Run parity and ownership tests**

Run: `node --import tsx --test tests/governance/commandOwnership.test.ts tests/cli/commandCatalogParity.test.ts tests/memory/commandEnvelopeParity.test.ts tests/memory/resultMiddlewareEnvelope.test.ts`

Expected: ownership, augmentation, and behavior parity pass.

- [ ] **Step 6: Commit runtime/evidence ownership**

```bash
git add src/commands/runtime src/commands/evidence src/commands/defineBrowserCommands.ts src/commands/memory/autoSurface.ts src/commands/*.ts tests/governance/commandOwnership.test.ts tests/cli/commandCatalogParity.test.ts tests/memory/commandEnvelopeParity.test.ts tests/memory/resultMiddlewareEnvelope.test.ts
git commit -m "refactor: split command runtime and evidence owners"
```

### Task 3: Move Observation And Knowledge Subdomains

**Files:**
- Create: `src/commands/observation/`
- Create: `src/commands/knowledge/`
- Modify: `src/commands/observeCommand.ts`
- Modify: `src/commands/observeRunners.ts`
- Modify: `src/commands/memoryCommand.ts`
- Modify: `src/commands/commandCatalog.ts`
- Modify: `tests/governance/commandOwnership.test.ts`
- Modify: `tests/memory/observeScanRunner.test.ts`
- Modify: `tests/memory/memoryFactBoundary.test.ts`

- [ ] **Step 1: Write failing subdomain ownership tests**

Require `observation/index.ts` to own `defineObserveCommand`, `knowledge/index.ts` to own
`defineMemoryCommand`, catalog imports to use those owners, and old top-level files to contain
exports only.

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/governance/commandOwnership.test.ts`

Expected: FAIL because catalog still imports top-level implementations.

- [ ] **Step 3: Move observation implementation**

Move `observeCommand.ts`, `observeRunners.ts`, `observe/`, `pageSignals.ts`,
`relevanceTraceAdapter.ts`, `relevanceTaps.ts`, and `memoryAugmentationTypes.ts` under
`observation/`. Keep temporary old-path facades for tests and external package source consumers.
Update imports using `.js` specifiers and run the main typecheck after each directory move.

- [ ] **Step 4: Move knowledge implementation**

Move `memoryCommand.ts` and `memory/` under `knowledge/`. Register the evidence result augmenter
from `knowledge/autoSurface.ts` through the port created in Task 2. No evidence implementation may
import knowledge after the move.

- [ ] **Step 5: Run focused behavior and type checks**

Run: `node --import tsx --test tests/memory/observeScanRunner.test.ts tests/memory/memoryFactBoundary.test.ts tests/cli/commandCatalogParity.test.ts`

Expected: observe, memory, and catalog parity pass.

Run: `npm run typecheck`

Expected: exit code 0 with no stale relative imports.

- [ ] **Step 6: Commit observation/knowledge ownership**

```bash
git add src/commands/observation src/commands/knowledge src/commands/observeCommand.ts src/commands/observeRunners.ts src/commands/memoryCommand.ts src/commands/commandCatalog.ts tests/governance/commandOwnership.test.ts tests/memory/observeScanRunner.test.ts tests/memory/memoryFactBoundary.test.ts
git commit -m "refactor: split observation and knowledge commands"
```

### Task 4: Move Browser And Security Subdomains

**Files:**
- Create: `src/commands/browser/`
- Create: `src/commands/security/`
- Modify: `src/commands/commandCatalog.ts`
- Modify: `src/commands/webSecurityCore.ts`
- Modify: `src/commands/webSecurityCommands.ts`
- Modify: `tests/governance/commandOwnership.test.ts`
- Modify: `tests/cli/commandExecution.test.ts`
- Modify: `tests/js-ast/webSecuritySharedBridge.test.ts`

- [ ] **Step 1: Write failing browser/security owner tests**

Require catalog core imports from `browser/index.ts`, security imports from `security/index.ts`,
and forbid catalog imports from individual implementation files. Require `webSecurityCore.ts` and
`webSecurityCommands.ts` to become export-only compatibility facades.

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/governance/commandOwnership.test.ts`

Expected: FAIL against current catalog imports and webSecurity owners.

- [ ] **Step 3: Move browser implementations**

Move these implementation files under `browser/`:

```text
tabsCommand.ts, tabsProjection.ts, executeCommand.ts, execute/, nativeCommand.ts,
nativeActionCommands.ts, actionCommands.ts, nativeActionMetadata consumers,
transferCommands.ts, transferValidation.ts, screenshotCommand.ts
```

Keep schema-generated `nativeActionMetadata.ts` at its canonical generated path. Browser modules
import it through `../nativeActionMetadata.js`.

- [ ] **Step 4: Move security implementations**

Move the existing `webSecurity/` tree under `security/webSecurity/` and move
`webSecurityCommands.ts` plus `webSecurityCore.ts` implementation into `security/`. Preserve the
OAST worker product entrypoint through an export/path-compatible wrapper or update its authoritative
entrypoint references and reachability root in the same commit.

- [ ] **Step 5: Run focused behavior, reachability, and type checks**

Run: `node --import tsx --test tests/cli/commandExecution.test.ts tests/js-ast/webSecuritySharedBridge.test.ts tests/cli/commandCatalogParity.test.ts`

Expected: core and security command parity pass.

Run: `npm run audit:reachability`

Expected: all moved implementations remain production-reachable.

Run: `npm run typecheck`

Expected: exit code 0.

- [ ] **Step 6: Commit browser/security ownership**

```bash
git add src/commands/browser src/commands/security src/commands/commandCatalog.ts src/commands/webSecurityCore.ts src/commands/webSecurityCommands.ts scripts/audit-reachability.mjs tests/governance/commandOwnership.test.ts tests/cli/commandExecution.test.ts tests/js-ast/webSecuritySharedBridge.test.ts
git commit -m "refactor: split browser and security commands"
```

### Task 5: Enforce Subdomain Edges And Facade Shape

**Files:**
- Modify: `scripts/architecture/boundaryRules.mjs`
- Modify: `tests/governance/architectureBoundaries.test.ts`
- Modify: `tests/governance/commandOwnership.test.ts`

- [ ] **Step 1: Write failing illegal-edge fixtures**

Add fixtures proving evidence cannot import knowledge/browser, runtime cannot import concrete
subdomains, knowledge cannot import browser implementations, and private cross-subdomain imports
fail while allowed public index imports pass.

```ts
assertViolation("commands/evidence -> commands/knowledge", "COMMAND_SUBDOMAIN_REVERSE_EDGE");
assertViolation("commands/runtime -> commands/browser", "COMMAND_RUNTIME_CONCRETE_EDGE");
assertAllowed("commands/observation -> commands/evidence/index.ts");
```

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/governance/architectureBoundaries.test.ts tests/governance/commandOwnership.test.ts`

Expected: illegal command-domain fixtures are not yet rejected.

- [ ] **Step 3: Implement command-domain rules**

Encode allowed edges by owner directory and require cross-domain imports to target `index.ts` or an
explicit `contracts/` file. Add a facade-shape check that allows only import/export statements,
comments, and type declarations in compatibility facades.

- [ ] **Step 4: Run architecture and parity gates**

Run: `npm run audit:architecture`

Expected: repository has no command-domain violations.

Run: `node --import tsx --test tests/cli/commandCatalogParity.test.ts tests/memory/commandEnvelopeParity.test.ts`

Expected: public behavior remains unchanged.

- [ ] **Step 5: Commit subdomain enforcement**

```bash
git add scripts/architecture/boundaryRules.mjs tests/governance/architectureBoundaries.test.ts tests/governance/commandOwnership.test.ts
git commit -m "ci: enforce command subdomain ownership"
```

### Task 6: Synchronize Architecture Documentation

**Files:**
- Modify: `CODE_WIKI.md`
- Modify: `REPO_GOVERNANCE.md`
- Modify: `scripts/coverage-baseline.json`
- Modify: `tests/governance/workflow.test.ts`

- [ ] **Step 1: Write failing documentation map tests**

Require the Code Wiki module map, maintenance table, and dependency diagram to name the new owners;
forbid contributor guidance that sends new implementation to compatibility facades.

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/run-tests.mjs governance`

Expected: stale command paths fail the new documentation assertions.

- [ ] **Step 3: Update canonical architecture and workflow owners**

Document where to add each command kind, which top-level files are authoritative versus temporary
facades, and the command subdomain edge rules. Do not duplicate the 21-tool list.

- [ ] **Step 4: Verify Stage 4**

Run: `mise run dev-governance`

Expected: exit code 0.

Run: `mise run affected`

Expected: exit code 0.

Run: `npm run audit:reachability`

Expected: exit code 0.

Run: `mise run coverage-update`

Expected: the measured-file manifest replaces pre-move command paths with their new subdomain
paths, per-domain metrics remain non-decreasing, and no unrelated baseline metric changes. Review
the baseline diff before staging it.

- [ ] **Step 5: Commit Stage 4**

```bash
git add CODE_WIKI.md REPO_GOVERNANCE.md scripts/coverage-baseline.json tests/governance/workflow.test.ts
git commit -m "docs: map command subdomain ownership"
```
