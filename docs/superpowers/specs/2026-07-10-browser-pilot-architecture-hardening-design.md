# Browser Pilot Architecture Hardening Design

Status: approved design input for implementation planning on 2026-07-10.

This document is a non-authoritative implementation specification. It does not replace
`REPO_GOVERNANCE.md`, `CODE_WIKI.md`, `SECURITY.md`, or module-local owner documentation.
Implementation must update those canonical owners whenever shipped behavior or repository
rules change.

## Objective

Strengthen Browser Pilot in six consecutive, independently verifiable stages:

1. Add a real Chrome/Edge smoke covering daemon startup, extension handshake, tab listing,
   observe, execute, ACK semantics, and service-worker restart recovery.
2. Make coverage measurement truthful and establish it as a nightly non-regression gate.
3. Enforce the import graph, including a real pure-helper allowlist for kernels.
4. Split `src/commands` by product subdomain while keeping `commandCatalog.ts` authoritative.
5. Make high-privilege and side-effecting behavior part of the formal security and behavior
   contracts.
6. Split the largest handwritten hotspots and add integration scenarios for tab replacement,
   leases, reconnects, and degraded observation providers.

## Delivery Strategy

Use staged compatibility-preserving delivery. Each stage starts with a failing behavioral or
governance test, implements only the required behavior, runs its focused gate, then runs
`mise run affected`. The final audit runs `mise run verify`, Markdown link validation, protocol
drift validation, and the real-browser smoke on both locally available browser families.

Public tool names, TypeBox parameter contracts, native protocol names, result-envelope fields,
and the package export surface remain compatible unless this specification explicitly says
otherwise. `src/commands/commandCatalog.ts` remains the only public `browser_*` catalog.

Existing uncommitted user changes are authoritative input. Implementation must not reset,
replace, or silently stage those changes.

## Stage 1: Real Browser Smoke

### Components

- `scripts/run-browser-smoke.mjs`: owns process orchestration, browser discovery, temporary
  directories, local fixture serving, timeouts, cleanup, and machine-readable reporting.
- `tests/integration/browserSmoke.test.ts`: owns assertions over the smoke report and can invoke
  the script only when an explicit live-smoke environment flag is present.
- Existing `src/apps/cli/cliSelftest.ts`: remains the bounded operator-facing selftest. Shared
  assertions may be extracted, but the command continues to work without owning browser launch.
- A scheduled/manual CI workflow: runs the smoke outside the deterministic PR verification job.

### Browser Lifecycle

The smoke accepts `BROWSER_PILOT_SMOKE_BROWSER` as an explicit executable path and otherwise
discovers supported Chrome, Edge, Chromium, or Chrome for Testing installations. It launches an
isolated profile with only the freshly built unpacked extension enabled. Daemon state, auth state,
artifact state, bridge ports, and browser profile all use temporary directories.

The driver serves a same-machine fixture over HTTP instead of using an external site. The fixture
contains stable text, an actionable control, a lazy/scroll region, and deterministic DOM mutation
hooks. Network access is not required after dependencies and a CI browser are installed.

### Required Flow

1. Build the extension through the canonical build implementation.
2. Start the daemon with isolated state and wait for the control endpoint.
3. Start the browser with the unpacked extension and fixture URL.
4. Wait for `extensionConnected:true` and a completed `ext_ready` handshake.
5. Call `browser_tabs` list and retain its stable `targetRef` or tab handle.
6. Call `browser_execute`, mutate the fixture, and assert an acknowledged bridge result.
7. Call canonical `browser_observe` without an explicit mode and assert the PageObservation
   marker and mutated content.
8. Send the native management reload command, then assert a changed worker boot ID, stable
   extension instance ID, and incremented service-worker restart/reconnect metrics.
9. Reuse the pre-restart stable target for another execute and observe.
10. Stop daemon and browser processes and remove all temporary state in `finally` cleanup.

### Failure Semantics

Every failure report names the failed phase, browser executable/version, daemon status,
extension readiness, active port, last connection metrics, and bounded log paths. It never emits
daemon tokens, pairing tokens, request bodies, cookies, or browser profile contents. Cleanup
errors are reported separately and do not hide the original failure.

### CI Policy

PR and release verification remain deterministic and browser-free. A scheduled/manual nightly
workflow runs the real-browser smoke on Windows Edge and a CI-supported Chromium or Chrome for
Testing on Linux. Missing browser support is a failing setup error in that workflow, not a skip.

## Stage 2: Truthful Coverage

Coverage is a nightly ratchet gate. It is not part of `mise run verify`, and it is not merely an
informational report.

`scripts/run-coverage.mjs` measures all handwritten Node-loadable TypeScript reachable from the
test process. It excludes only:

- schema-generated protocol/type/metadata files;
- packaged outputs under `dist/` and `bridge/browser_pilot_bridge/`;
- the MV3 extension execution environment, which is measured by integration evidence rather
  than falsely attributed Node coverage;
- browser-only or worker-only entrypoints that cannot execute in the Node test runner.

The runner emits a machine-readable summary by domain. A checked-in baseline stores line,
branch, and function percentages for each measured domain. Nightly coverage fails when a domain
drops below its baseline or when an eligible handwritten file disappears from measurement.
Baselines can move upward through an explicit maintenance command but cannot be regenerated as a
side effect of the normal gate.

`CODE_WIKI.md` must describe the actual measured scope, exclusions, current baseline, nightly
ratchet semantics, and the fact that `mise run verify` does not run coverage. Statements claiming
an unqualified whole-repository 80 percent threshold are removed unless the measured evidence
actually supports them.

## Stage 3: Import Graph And Kernel Purity

Create a dedicated architecture audit rather than overloading reachability terminology.
Reachability answers whether production modules are wired; the architecture audit answers whether
wired dependencies are legal.

The audit parses static ESM imports, resolves `.js` specifiers back to TypeScript sources, and
checks both direct edges and transitive closure. It is invoked by `mise run verify` and relevant
development gates.

### Kernel Rules

- Kernels may import other kernel modules.
- ABML, evidence, memory, refs, security, and temporal kernels may import only helpers listed in
  the real `PURE_CROSSCUTTING` allowlist.
- The allowlist initially contains only helpers whose complete dependency closure is pure, such
  as record guards, stable JSON helpers, and redaction primitives.
- No allowlisted helper may reach Node built-ins, npm packages, apps, bridge, commands,
  browser-runtime, browser-command-runtime, browser-page-runtime, artifacts, resources, memory
  storage, scan, content, or validation adapters.
- `src/kernels/session/*` retains its narrowly enumerated `node:crypto` exception for random IDs
  and irreversible diagnostic hashes.

`src/kernels/abml/errors.ts` must stop reaching the non-pure `src/utils/errors.ts` path. A focused
kernel-owned normalization helper replaces that edge. `src/kernels/abml/README.md` points to the
actual allowlist owner and no longer describes a nonexistent test constant.

The audit tests must prove that an illegal direct import, an illegal transitive import, an
unlisted helper, and an unauthorized Node built-in all fail with the complete dependency path.

## Stage 4: Commands Subdomains

The target ownership layout is:

```text
src/commands/
  commandCatalog.ts             authoritative public tool list
  defineBrowserCommands.ts      registration composition root
  commandDefinition.ts          stable command host types
  browser/                      tabs, execute, native actions, transfer, screenshot
  observation/                  observe orchestration, providers, baseline, cache, projection
  evidence/                     result envelope, distillation, artifacts, evidence summaries
  knowledge/                    memory record, recall, read, and auto-surface
  security/                     existing web-security commands and adapters
  runtime/                      execution wrapper, operations, validation, middleware, budgets
```

Moves happen behind compatibility facades when current internal consumers or tests depend on a
top-level path. Facades contain exports only and are removed only after all consumers use the new
owner. Catalog registrar order, the set of 21 public tools, command schemas, CLI subcommands, and
native command behavior stay unchanged.

The architecture audit enforces allowed subdomain edges:

- catalog/composition may depend on every registrar subdomain;
- browser and observation may depend on runtime and evidence contracts;
- knowledge may depend on evidence contracts but not browser implementations;
- security may depend on runtime/evidence contracts and browser runtime ports;
- evidence and runtime do not depend on concrete command subdomains;
- no subdomain imports another subdomain's private implementation file.

Characterization tests snapshot tool names, schemas, CLI metadata, registrar order, and selected
result-envelope shapes before moves begin.

## Stage 5: Security And Behavior Contracts

No new canonical rule source is introduced. `SECURITY.md` owns operator-facing threat and trust
boundaries. `CODE_WIKI.md` owns contributor-facing runtime behavior, module ownership, and
validation. Module-local documentation owns only narrower implementation rules.

The formal contract states:

- canonical observe performs a bounded temporary growth-probe scroll and attempts restoration;
  this may trigger lazy loading, scroll handlers, and analytics;
- extension content scripts run on `<all_urls>`, including the MAIN-world dialog suppression
  script, so loading the extension can alter page behavior before a tool call;
- debugger, cookies, management, content settings, downloads, scripting, and broad host
  permissions make the extension a high-privilege local agent;
- daemon and bridge listeners are loopback-only; daemon token, pairing, consent, and tenant lease
  protect different boundaries and are not interchangeable;
- model-facing redaction does not imply that persisted local artifacts contain no secrets;
- relative artifact reads are confined to the caller's artifact root, while an explicit absolute
  path authorizes reading that local file;
- the browser-result and ref stores are process-local, bounded, and expire independently from
  persisted artifacts.

The bridge WebSocket origin policy is tightened to the fixed Browser Pilot extension ID by
default. Development builds can accept an explicit allowlist supplied through a documented local
environment/config boundary. A syntactically valid arbitrary Chrome extension ID is no longer
sufficient.

Governance tests connect each contract statement to its implementation owner: manifest
permissions/content scripts, observe growth probe, bridge origin validation, daemon binding,
artifact path resolution, and result redaction.

## Stage 6: Hotspot Splits And Integration Scenarios

Only handwritten hotspots are split. Generated protocol files are excluded from file-size goals.
The first split set is:

- `src/commands/observe/scanRunner.ts`: cache reuse, provider execution, causal/diff assembly,
  and final envelope projection become focused collaborators;
- `src/bridge/server/BrowserTabSessionRouter.ts`: replacement history, session selection, and
  target resolution become separate owners;
- `src/kernels/abml/collections.ts`: evidence normalization, completeness inference, and
  continuation projection become separate pure modules;
- `src/browser-command-runtime/programEngine.ts`: validation/dispatch, execution, and result/ref
  collection become separate modules;
- `src/browser-runtime/abml/runtime.ts` and `axRuntime.ts`: browser capture providers and merge
  orchestration become separate owners.

Each original path remains a readable facade or orchestrator. New production functions receive a
failing focused test before extraction. Characterization tests prove output parity before and
after every move. File-size checks are secondary guardrails, not substitutes for responsibility
boundaries.

### Integration Tiers

The real-browser tier covers daemon, extension, tabs, execute, observe, ACK, and worker restart.

The real-protocol tier starts the production HTTP/WebSocket bridge and uses protocol messages over
actual sockets. It does not call private methods or replace registries with object stubs. It covers:

- tab replacement migration, stable target reuse, and replacement-chain failure diagnostics;
- tenant and tab lease acquisition, conflict, expiry, disconnect cleanup, and release;
- durable reconnect redelivery and non-durable `not-delivered` versus `inflight-unknown` outcomes;
- observe behavior when structure, AX, readability, axe, tabs refresh, or artifact providers
  degrade independently.

Chrome does not expose a deterministic API to force every `tabs.onReplaced` case. Therefore the
tab-replacement integration sends the real extension protocol event through an actual WebSocket
and production Bridge Server. It is classified as protocol integration, not real-browser smoke.

## Verification Matrix

| Requirement | Authoritative evidence |
| --- | --- |
| Daemon and extension lifecycle | Real-browser smoke report and process cleanup assertions |
| ACK semantics | Actual bridge result with `acknowledged:true` and request metrics |
| Worker restart recovery | Changed worker boot ID, stable instance ID, reused target |
| Truthful coverage | Domain summary, inclusion audit, nightly baseline comparison |
| Kernel purity | Direct and transitive architecture-audit failure fixtures |
| Public tool stability | Catalog/schema/CLI characterization tests |
| Commands ownership | Architecture edge rules and facade-only checks |
| Security contract | Governance tests tied to implementation owners |
| Hotspot responsibility | Focused modules, parity tests, source-size guardrails |
| Replacement/lease/reconnect/degradation | Actual HTTP/WebSocket protocol integration tests |

## Completion Criteria

Completion requires all six stages to satisfy their verification matrix. Focused tests alone do
not prove the program complete. The final audit must show:

- Chrome and Edge smoke each pass on the current implementation;
- all protocol integration scenarios pass;
- coverage measures its documented scope and the ratchet passes;
- architecture audit and reachability audit pass;
- the public tool and native protocol surfaces remain compatible;
- canonical documentation matches shipped source behavior;
- Markdown links are valid;
- `mise run verify` exits successfully;
- no generated output was manually edited;
- pre-existing user changes remain present unless the implementation deliberately extends them.
