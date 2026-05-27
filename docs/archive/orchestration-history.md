# Orchestration History Archive

> Covers historical TODO 216-240. Current execution entry is `CURRENT.md`.

## Scope

This archive records the now-withdrawn orchestration / target-resolver / profile-isolation workstream. It remains important as history, but it is not the current runtime direction.

## Phase summary

### 216-222: coordinator core and first production loop

Completed historically:
- orchestration coordinator design and runtime implementation
- cookie write primitive
- coordinator core
- `browser_orchestrate` registration
- watch/self-heal loop
- runtime smoke and first production closure gate

Historical outcome:
- the package proved that a higher-level orchestration layer was technically possible
- contracts, smoke, and release acceptance covered this path at the time

### 223-233: target resolver, persistence, window/group, pre-navigation hook, profile design

Completed historically:
- target resolver design and runtime implementation
- window / tabGroups primitives and smoke
- pre-navigation hook policy and runtime
- persistence and adoption gate
- profile/incognito isolation design and managed profile-first gate

Historical outcome:
- logical targeting and orchestration state became much richer
- however, the surface also became heavier and further from the preferred explicit-tab workflow

### 234-240: terminology freeze, assertions, adoption-first, then rollback

Completed historically:
- orchestration terminology freeze
- assertions/readiness design and runtime
- isolated smoke preflight improvements
- adoption-first usability pass
- final hard rollback of `browser_orchestrate`

Final outcome:
- the orchestration tool surface was deliberately removed
- current browser workflow returned to `browser_tabs list/switch/create` plus explicit `tabId`
- orchestration remains historical evidence, not current product direction

## Why this is not an active TODO stream

- current product direction explicitly rejects reopening orchestration by default
- operation metadata is diagnostic only
- future high-level coordination would require a new RFC and fresh proof that it improves the current explicit workflow

## Still-relevant lessons

- explicit ownership/cleanup boundaries matter
- session/profile isolation work is expensive and should not be reopened casually
- tool-level abstraction cost must be proven, not assumed

## Current status

Closed and withdrawn from the public tool surface. Keep only as historical reference.
