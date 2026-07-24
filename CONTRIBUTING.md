# Contributing

## Before You Start

- Search existing issues before opening a new one.
- Discuss public contract changes in an issue before implementation.
- Report vulnerabilities through [SECURITY.md](SECURITY.md), never a public issue.

## Development

Requirements are Node.js 22+, Chrome or Edge, and `mise`.

```bash
npm ci
npm run build:bridge
mise run verify
```

Edit source under `src/` and `capture-src/`. Do not edit generated `dist/` or `bridge/browser_pilot_bridge/` files. Public tools are owned by `src/commands/commandCatalog.ts`; pure kernels under `src/kernels/` must remain free of browser and npm runtime dependencies.

## Pull Requests

- Keep changes focused and follow nearby code.
- Add the smallest test that proves non-trivial behavior.
- Update `README.md` and `CHANGELOG.md` when user-visible behavior changes.
- Run `mise run verify` before submitting. Use `mise run smoke-browser` for browser integration changes.

By contributing, you agree that your contributions are licensed under the Apache License 2.0.
