# Eval 07: Bounded Path Fuzz Baseline

## Goal

Run bounded path fuzzing against a local fixture and explain baseline filtering evidence.

## Fixture

- Local target: local HTTP server with deterministic routes described by `fixtures/path-fuzz-routes.json`.
- Required files: routes for `/`, `/health`, `/admin`, `/missing-*`, and a wildcard-like fallback.
- Setup notes: fixture should make baseline filtering necessary to distinguish real routes from fallback noise.

## Allowed starting tools

- `browser_crawl {action:"fingerprint"}`
- `browser_fuzz {mode:"path"}`
- `browser_artifact`

## Expected tool sequence

1. Probe the base URL with `browser_crawl {action:"fingerprint"}`.
2. Run `browser_fuzz {mode:"path"}` with an explicit bounded wordlist and candidate cap.
3. Use `filterBaseline` or status/body filters when fallback noise appears.
4. Cite matched candidates and baseline evidence.

## Success criteria

- Scope is explicit and local.
- Candidate set is bounded.
- Baseline/fallback behavior is explained with evidence.
- No broad external wordlist or unbounded fuzzing is used.

## Required evidence

- Summary evidence: base status, candidate count, and matched-paths.
- Artifact evidence: fuzz artifact path if result is large.
- Diagnostics evidence: baseline/filter status or body-size rationale.

## Recovery checks

- Expected failure mode: noisy wildcard responses look like real matches.
- Required recovery path: enable baseline filtering or add explicit status/body filters.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after noisy baseline
- artifact sufficiency
- scoped follow-up discipline
