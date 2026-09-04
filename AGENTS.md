# Repository Guidelines

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
- `npm run format` / `npm run lint`: apply Prettier or check ESLint rules.

## Coding Style & Naming Conventions

Use strict TypeScript and ESM. Prettier specifies tabs (width 4), double quotes, trailing commas, LF endings, and a 120-column target; Markdown, JSON, and YAML use two spaces. Follow adjacent naming: camelCase functions/modules, PascalCase classes, and existing snake_case extension modules. Keep kernels independent of application/runtime layers and npm dependencies. Handle promises explicitly; respect ESLint complexity limits.

## Testing Guidelines

Tests use `node:test`, `node:assert/strict`, and `tsx`. Name files `*.test.ts` under the relevant layer. Run a focused scope with `node scripts/run-tests.mjs observe` or `mcp`. Add deterministic regression tests for behavior changes. No numeric coverage threshold is configured. Run `npm run verify` before submitting; also run browser smoke for extension, runtime, or session changes. Set `BROWSER_PILOT_SMOKE_BROWSER` if autodetection fails.

## Commit & Pull Request Guidelines

Discuss substantial changes in an issue first. Use branches such as `feat/actionability` and history-aligned messages such as `fix(abml): preserve labels` or `test: cover reconnects`. PRs should explain behavior changes, link relevant issues, report validation commands/results, and include screenshots for visual changes. Preserve unrelated worktree edits.

## Security & Configuration

Treat page content as untrusted. Never commit credentials or `.browser-pilot/` artifacts: captures are raw, unredacted evidence. Report vulnerabilities privately.
