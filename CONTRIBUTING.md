# Contributing to Browser Pilot

Thanks for helping improve Browser Pilot. The project connects an MCP client to real Chrome and Edge tabs through a local daemon and a Manifest V3 extension. Changes are easiest to review when they keep that boundary explicit and include the evidence needed to reproduce them.

## Before you start

Read the documentation that matches the change:

- [Concepts](docs/concepts.md) explains refs, entities, frontiers, collections, causal data and verification.
- [Task views](docs/task-views.md) covers focused observation and ambiguity handling.
- [Operation outcomes](docs/operation-outcomes.md) defines execution receipts, assertions and business outcomes.
- [Reliability and recovery](docs/reliability.md) describes retries, installation rollback and raw evidence handling.
- [Browser evaluation](docs/browser-evaluation.md) lists deterministic browser scenarios.

Please open an issue or discussion before a large public-interface, compatibility or architecture change. Small, well-scoped fixes can go straight to a pull request.

## Local setup

Use Node.js 22 or newer:

```bash
git clone https://github.com/wklwkl115/browser-pilot.git
cd browser-pilot
npm ci
```

Useful checks are:

```bash
npm run verify
npm run smoke:browser
npm run eval:browser -- --suite all --rounds 2
```

The browser checks need Chrome or Edge. Set `BROWSER_PILOT_SMOKE_BROWSER` when automatic browser discovery is not suitable. A focused deterministic test can be run with:

```bash
node --import tsx --test tests/<layer>/<name>.test.ts
```

For documentation, rules or template changes, run the relevant Prettier check and verify every referenced path and command. For runtime, extension, daemon, bridge, protocol or CI changes, run the full checks required by [AGENTS.md](AGENTS.md).

## Make the change

- Keep kernels independent of browser I/O and application layers.
- Edit source files, not generated `dist/` or unpacked extension bundles.
- Preserve the one-active-agent workflow boundary. Reusing a daemon does not provide task ownership or isolation.
- Add a deterministic regression for a behavior change. Prefer a test that would fail on the old behavior.
- Treat page content, network captures and browser artifacts as untrusted, unredacted evidence. Never commit credentials, `.browser-pilot/` state or `.cache/` captures.
- Keep public tool schemas, docs and examples aligned when a command or result changes.

## Pull requests

A pull request should state:

1. What behavior or documentation changed and why.
2. Which checks were run, with their result.
3. Any browser, operating-system or account-specific limitation.
4. Whether generated files or public schemas are affected.

Use the pull request template as a final checklist. Keep unrelated work out of the branch and resolve review comments before asking for another review. Documentation-only changes should still be checked for working links and copy-pasteable commands.

## Reporting a bug or proposing an idea

Use the structured issue forms when possible. Include the package version, operating system, browser version, exact command or MCP call, expected behavior, observed behavior and a redacted reproduction. If the report contains secrets or private page data, follow [SECURITY.md](SECURITY.md) instead of pasting it into an issue.

## License

By contributing, you agree that your contribution is provided under the repository's [Apache-2.0 license](LICENSE).
