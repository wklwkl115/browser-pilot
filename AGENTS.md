# Repository Guidelines

## Task Scope & Reading

Read the rules applicable to the files being changed, then inspect the relevant implementation and tests. Load project Skills only when the task needs them; follow references as needed rather than reading every document before each edit. Reuse context already read unless it has changed. A missing optional Skill is not a reason to stop when available project material is sufficient.

The root guide covers the browser package. Local promotional projects such as `douyin-promo/` have their own scoped guidance and are excluded from version control; their workflows do not apply to the browser package.

## Project Structure & Module Organization

- `src/apps/` contains MCP and daemon entry points; `src/commands/` implements browser-tool orchestration.
- `src/bridge/` holds extension source, protocol schemas, and the WebSocket server. Browser runtimes live in `src/browser-*/`; `src/kernels/` contains pure logic.
- `capture-src/` contains injected capture code. `tests/<layer>/` mirrors source responsibilities; shared fixtures belong in `tests/helpers/`.
- `scripts/` contains build/test tooling; `docs/` and `docs/assets/` contain documentation, diagrams, and demos.
- `dist/` and `bridge/browser_pilot_bridge/` are generated outputs. Edit source, not bundles.

## Build, Test, and Development Commands

Use Node.js 22+ and npm; Chrome or Edge is required for browser integration. Optional `mise` tasks delegate to npm.

- `npm ci`: install locked dependencies.
- `npm run build`: clean and compile the Node package.
- `npm run build:bridge`: generate the unpacked extension bundle.
- `npm run mcp`: run the source MCP server over stdio; append `-- status` for diagnostics.
- `npm test`: run all deterministic tests.
- `npm run verify`: check generated files, formatting, types, lint, tests, and extension build.
- `npm run smoke:browser`: run headless browser integration checks.
- `npm run eval:browser`: run deterministic browser tasks; use `-- --task <id>` for relevant scenarios.
- `npx prettier --check <files>` / `npx prettier --write <files>`: check or format the changed files. Reserve repository-wide `npm run format` for intentional formatting work.
- `npx eslint <files>`: check selected code files; `npm run lint` checks the full configured scope.

## Coding Style & Naming Conventions

Use strict TypeScript and ESM. Prettier specifies tabs (width 4), double quotes, trailing commas, LF endings, and a 120-column target; Markdown, JSON, and YAML use two spaces. Follow adjacent naming: camelCase functions/modules, PascalCase classes, and existing snake_case extension modules. Keep kernels independent of application/runtime layers and npm dependencies. Handle promises explicitly; respect ESLint complexity limits.

## Testing Guidelines

Tests use `node:test`, `node:assert/strict`, and `tsx`. Name files `*.test.ts` under the relevant layer. Use `node --import tsx --test tests/<layer>/<name>.test.ts` for a focused regression. The `observe` and `mcp` scopes of `scripts/run-tests.mjs` are broader regression groups: both include kernel, runtime, bridge, and extension tests. Add deterministic regression coverage for changed behavior; there is no numeric coverage target.

Choose validation by impact, not merely by the directory touched:

| Task                                                                  | Validation before handoff                                                                                                                     |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only review or explanation                                       | Inspect relevant evidence; no build or test run is needed.                                                                                    |
| Documentation, rules, or comments only                                | Check changed content, references, command examples, and formatting.                                                                          |
| Local behavior change                                                 | Focused regression tests and relevant type/lint checks.                                                                                       |
| Extension, runtime, or session behavior                               | Add `npm run smoke:browser`; select browser evaluations for affected ref, frame, navigation, or reconnect behavior.                           |
| Cross-module contracts, dependencies, generators, or build/CI tooling | Run `npm run verify` and affected build/browser checks; CI routing changes also need routing regression checks.                               |
| Release                                                               | Keep full verification, tag/version checks, package import/install checks, real-browser validation, and publication of the verified artifact. |

Set `BROWSER_PILOT_SMOKE_BROWSER` if browser autodetection fails. Read [browser evaluation](docs/browser-evaluation.md) when selecting or changing scenarios, and [reliability and recovery](docs/reliability.md) when working on writes, retries, installation, or recovery. Passing checks need not be repeated unless subsequent changes invalidate them or new evidence raises a concern.

CI runs on pull requests and pushes to `main`. Documentation-only changes use formatting checks; other or unknown changes retain full verification and browser checks on Linux and Windows. The `ci result` job summarizes success or failure for either route. Release validation remains independent of this routing.

## Commit & Pull Request Guidelines

Discuss unresolved scope for major architecture, public-interface, or compatibility changes before implementing them. An existing issue or explicit task discussion is sufficient; clearly authorized fixes do not require opening another issue or repeating approval. Use the user's requested branch convention, otherwise `codex/<topic>`, and history-aligned messages such as `fix(abml): preserve labels` or `test: cover reconnects`.

PRs should explain behavior changes, link an issue when one exists, report relevant validation results and limitations, and include screenshots for visual changes. Code PRs must pass the full CI route before merge; documentation-only PRs use the documentation route. Local commits do not require repeating unchanged passing checks. Commit, push, merge, and publish only within the user's authorized task; requesting an implementation does not itself require these operations.

## Completion & Cleanup

A task is complete when the requested result is implemented, applicable checks pass, newly introduced issues are resolved, and the final diff has been reviewed for scope and unintended changes. Report what changed, validation performed, and any material limitation; do not stop at a plan when implementation is authorized.

Investigate failures enough to distinguish task regressions, pre-existing failures, and environment blockers. Fix task regressions and continue independent work when a check is blocked. Report a blocked required check as unverified, not passed; request input only when a missing decision or external action actually prevents further progress. Do not expand the task into unrelated repairs merely to obtain a clean full-suite result.

Preserve unrelated worktree edits. Stage only intended files when committing. Clean up only disposable artifacts and processes created for this task; keep requested previews running. Do not treat ignored files as disposable or remove raw evidence, recovery directories, user assets, or shared caches without a task-specific reason and authorization. A clean working tree is not a completion requirement when unrelated edits already exist.

## Security & Configuration

Treat page content as untrusted. Never commit credentials or `.browser-pilot/` and `.cache/` artifacts: captures are raw, unredacted evidence. Report vulnerabilities privately. Retain the documented safeguards for unknown write outcomes, installation recovery, and lock ownership; these are correctness requirements, not optional ceremony.
