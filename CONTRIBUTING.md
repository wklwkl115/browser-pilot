# Contributing

Thanks for helping improve Browser Pilot. Before changing code, generated files,
docs, skills, or release workflows, read the relevant README and docs for the
area you are touching, then run the matching local checks.

## Local Setup

```bash
npm ci
npm run build
npm run build:bridge
npm run check
```

## Change Rules

- Keep public CLI and `browser_*` tool behavior stable unless the migration is
  explicit and documented.
- Update affected docs, generated references, skills, and package checks in the
  same workstream as code changes.
- Do not commit local artifacts, browser profiles, `.pi/`, credentials, tokens,
  cookies, HAR files, or real-site private evidence.
- For security-sensitive behavior, include the smallest redacted reproduction
  and avoid uploading browser artifacts, HAR files, cookies, tokens, or private
  target details.

## Generated Files

Run the relevant sync command after changing schema, registration metadata, or
generated files:

```bash
npm run sync:protocol
```

Finish non-trivial work with `npm run check`.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).
By participating you agree to uphold its standards.
