# Contributing

This repository is governed by `AGENTS.md`. Read it before changing code,
contracts, generated files, docs, skills, or release workflows.

## Local Setup

```bash
npm ci
npm run build
npm run build:bridge
npm run check
```

Use the narrowest relevant gate while iterating:

```bash
npm run check:all:src
npm run check:all:bridge
npm run check:all:package
npm run check:all:contracts
```

## Change Rules

- Keep public tool contracts stable unless the migration is explicit and
  documented.
- Update affected docs, generated contracts, skills, and package/release checks
  in the same workstream as code changes.
- Do not commit local artifacts, browser profiles, `.pi/`, credentials, tokens,
  cookies, HAR files, or real-site private evidence.
- Use `agent-audits/` only for audit reports. Audit agents do not modify project
  code; maintainers independently verify findings before fixing them.

## Generated Files

Run the relevant sync command after changing schema, registration metadata, or
managed docs:

```bash
npm run sync:protocol
npm run docs:sync
npm run sync:impact-map
```

Finish non-trivial work with `npm run check`.
