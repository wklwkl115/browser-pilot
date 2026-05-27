# Bridge ESM / Runtime History Archive

> Covers historical TODO 180-202. Current execution entry is `CURRENT.md`.

## Scope

This archive records the completed migration from the old MV3 `importScripts` bridge layout to the generated dist runtime built from `bridge_src/**`.

## Phase summary

### 180-186: prerequisites and boundary freezing

Completed:
- `wait.js` split planning and staged decomposition boundary freeze
- hook dispatcher single-file page-injection boundary freeze
- smoke port-conflict diagnostics
- ambient/global type tightening before TS/ESM migration

Outcome:
- wait/runtime/page boundaries became testable
- no runtime behavior claims were made early
- contracts were prepared before structural migration

Primary docs:
- `docs/bridge-wait-split.md`
- `docs/hook-dispatcher-boundary.md`

### 187-194: build pipeline and dist runtime cutover

Completed:
- `build:bridge` introduced
- `bridge_src/` became source of truth for bridge/page entries
- independent dist bundles for service worker/content/hook dispatcher/disable-dialogs
- manifest switched to dist runtime
- old hand-written production entrypoints were deleted
- isolated smoke path added for runtime proof without disturbing user Chrome profile

Outcome:
- manifest now points to generated dist output
- runtime verification moved from source claims to built-artifact claims
- isolated smoke became the preferred runtime proof path

Primary docs:
- `docs/bridge-esm-bundler-plan.md`

### 195-202: final ESM import-graph and type finalization

Completed:
- package portability gate for dist runtime
- design correction from ordered-concat compatibility to true ESM import graph
- foundation / command / startup layers moved into real import/export graph
- `strict:true` + `noImplicitAny:true`
- bridge/page `@ts-nocheck` removal
- final build/check/pack/isolated-smoke gate

Final state:
- service worker built from `bridge_src/service-worker.ts`
- manifest uses `dist/service-worker.js`
- `dist/build-manifest.json` proves `serviceWorkerBuildMode:"esm-import-graph"`
- package includes the dist runtime
- isolated smoke evidence passed

## Remaining non-active follow-ups

These are not unfinished migration bugs:
- hook dispatcher multi-file injection is now an explicit RFC-only evaluation topic
- any future popup/HUD evolution is optional and not part of bridge ESM completion

## Evidence anchors

- `npm run build:bridge`
- `npm run check`
- `npm pack --dry-run --json`
- `npm run smoke:browser:isolated`

## Current status

Closed. No active TODO from this stream remains in the current execution queue.
