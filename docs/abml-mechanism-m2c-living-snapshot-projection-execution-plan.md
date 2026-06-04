# ABML mechanism arm M2c — living snapshot projection execution contract

> Status: **COMPLETE**. M2c follows completed M1/M2a/M2b. It remains an internal
> `browser_observe` substrate: no new public `browser_*` tool, no native protocol/schema change,
> no DOM tag/class/selector guessing.

## 1. Goal

M1 folds repeated structures into templates. M2a reports template-level `treeDiff`. M2b stabilizes
safe repeated-item refs. M2c persists a compact **living snapshot projection** so follow-up observe
results and saved artifacts carry the structure model directly:

- current templates are available as a compact projection with stable template keys,
- when a baseline exists, each affected template carries its `delta`,
- snapshot artifacts persist the projection next to full ABML entities, so agents can inspect
  structure/O(change) deltas without loading the full entity set first.

## 2. Hard boundaries

- No new public `browser_*` tool.
- No native command/schema surface change.
- No change to action resolution or ref minting.
- No site/framework-specific heuristic.
- No DOM structural pattern matching; projection must reuse ARIA-grounded M1/M2a grouping.
- Projection must be lossy only at presentation level: instance handles remain present/capped with
  true counts, and full entities remain in saved artifacts for `read(ref)`/baseline resolution.

## 3. Reuse from earlier phases

- M1 `buildTemplateSummary` and `templateGroupDescriptorForEntity` define template eligibility.
- M2a `TreeDiff` already contains appeared/disappeared/changed/reordered buckets.
- M2b ensures high-confidence repeated item refs are stable enough for projection deltas to be
  actionable across reorder/insert.
- `resultMiddleware` already budget-lifts `templates` and `treeDiff`; M2c adds one more lifted
  block for `snapshotProjection`.

## 4. Projection shape

Pure core returns a bounded structure projection:

```ts
type SnapshotProjection = {
  summary: {
    templateCount: number;
    instanceCount: number;
    projectedInstanceRefCount: number;
    changedTemplateCount?: number;
    appeared?: number;
    disappeared?: number;
    changed?: number;
    reordered?: number;
    partialBaseline?: boolean;
  };
  templates: Array<{
    templateKey: string;
    container?: string;
    containerName?: string;
    role: string;
    kind: EntityKind;
    count: number;
    setSize?: number;
    varies: TemplateVaryField[];
    constant: Record<string, unknown>;
    instanceRefs: string[];
    instanceRefCount: number;
    sample?: { ref: string; name?: string; value?: string };
    delta?: {
      beforeCount: number;
      afterCount: number;
      appeared: TreeDiffInstanceBucket;
      disappeared: TreeDiffInstanceBucket;
      changed: TreeDiffChangedBucket;
      reordered?: TreeTemplateDiff["reordered"];
    };
  }>;
};
```

## 5. Phases

### P0 — contract + blast-radius inventory  (COMPLETE)

- Activate this document from `CURRENT.md` / `TODO.md`.
- Inventory touched paths:
  - pure core: new `src/abml-core/snapshotProjection.ts`, shim, barrel, boundary manifest,
  - observe: `src/tools/observeRunners.ts`,
  - envelope: `src/tools/resultMiddleware.ts`,
  - contracts/smoke/docs.

### P1 — pure snapshot projection  (COMPLETE)

- Add pure `buildSnapshotProjection(entities, { treeDiff? })`.
- Reuse M1 grouping and M2a delta objects; do not create a second grouping heuristic.
- Include capped `instanceRefs` plus `instanceRefCount` / `count` so the projection is handle-lossless.
- Unit/contract coverage: plain templates, attached delta, partial baseline, cap/summary counts.
- Result: `src/abml-core/snapshotProjection.ts` builds a bounded pure projection from entities plus optional `treeDiff`.

### P2 — observe/envelope/artifact wiring  (COMPLETE)

- Build projection from the same attributed ABML entities used by `templates`/`relations`.
- Add `summary.snapshotProjection` and lift it to top-level `envelope.snapshotProjection`.
- Persist under saved raw artifact `abml.snapshotProjection` while keeping `abml.entities` intact for
  existing baseline resolution.
- Result: `browser_observe` summary/envelope lifts `snapshotProjection`; raw observe artifacts store `abml.snapshotProjection` next to full `abml.entities`.

### P3 — live smoke + full regression  (COMPLETE)

- Extend `smoke:browser:abml-templating`:
  - observe repeated list,
  - mutate reorder/insert,
  - observe with baseline,
  - assert `snapshotProjection.templates[].delta.appeared` contains the new item,
  - assert saved artifact has `abml.snapshotProjection` and full `abml.entities`.
- Gate on targeted contracts plus `npm run check`.
- Result: `smoke:browser:abml-templating` verifies `Product Golf` appears under `snapshotProjection.templates[].delta` and saved artifact preserves both `abml.snapshotProjection` and full `abml.entities`.

## 6. Acceptance

M2c is complete only when:

- projection is pure-core and boundary-checked,
- `browser_observe` summary/envelope contains `snapshotProjection` under tight budgets,
- saved snapshot artifacts persist `abml.snapshotProjection` without removing full entities,
- live smoke proves projection delta after reorder/insert,
- no public tool/protocol/action/ref behavior changes.

## 7. Rollback path

Rollback is one branch: remove observe/envelope/artifact wiring. The pure projection module may stay
if it remains unused and covered, but no live output should include `snapshotProjection` after rollback.
