# Contributing to Browser Pilot

First off, thanks for taking the time to contribute! Every contribution helps
make Browser Pilot better for the AI agent community.

## Ways to Contribute

- **Report bugs** — use the [bug report template](https://github.com/wklwkl115/browser-pilot/issues/new?template=bug_report.yml)
- **Suggest features** — use the [feature request template](https://github.com/wklwkl115/browser-pilot/issues/new?template=feature_request.yml)
- **Ask questions** — start a thread in [Discussions](https://github.com/wklwkl115/browser-pilot/discussions)
- **Submit a PR** — fixes, improvements, and documentation are all welcome

## Local Setup

```bash
git clone https://github.com/wklwkl115/browser-pilot.git
cd browser-pilot
npm ci
npm run build
npm run build:bridge
npm run check          # runs all gates: lint, types, tests, contracts
```

## Development Workflow

1. Fork the repo and create your branch from `main`
2. Make your changes
3. Run `npm run check` to verify everything passes
4. If you changed tools or protocol, run `npm run sync:protocol` and `npm run docs:sync`
5. Open a Pull Request using the provided template

## Change Rules

- Keep public CLI and `browser_*` tool behavior stable unless the migration is
  explicit and documented.
- Update affected docs, generated references, and package checks in the same
  workstream as code changes.
- Do not commit local artifacts, browser profiles, `.pi/`, credentials, tokens,
  cookies, HAR files, or real-site private evidence.
- For security-sensitive behavior, include the smallest redacted reproduction
  and avoid uploading browser artifacts, HAR files, cookies, tokens, or private
  target details.

## Generated Files

Several files are auto-generated from `bridge/native_command_schema.json`. Do
not edit them manually — instead run:

```bash
npm run sync:protocol    # regenerate protocol types, metadata, docs
npm run docs:sync        # regenerate tool contract docs and managed blocks
```

Finish non-trivial work with `npm run check`.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
By participating you agree to uphold its standards.
