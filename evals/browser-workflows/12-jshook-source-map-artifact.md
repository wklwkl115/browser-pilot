# Eval 12: jshook Source Map Artifact

## Goal

Discover source map evidence from a local bundle fixture and verify that `browser_crawl` plus `browser_artifact` can close source/source-map inspection without adding `browser_sources`.

## Fixture

- Local target: `fixtures/jshook-source-map.html`
- Required files: `fixtures/jshook/bundle.js`, `fixtures/jshook/bundle.js.map`, and at least one synthetic original source entry in the map.
- Setup notes: source map content must be synthetic, small, deterministic, and safe to commit; no minified production code.

## Allowed starting tools

- `browser_tabs`
- `browser_crawl`
- `browser_artifact`
- `browser_execute`

## Expected tool sequence

1. Start from explicit tab/session state with `browser_tabs` or an explicit local URL target.
2. Run bounded `browser_crawl` against the local fixture with same-origin scope and JavaScript extraction enabled.
3. Inspect crawl summary for `source-map` hints and saved source-map artifact references.
4. Use `browser_artifact` search/sample/json reads to locate original source names or source-map metadata.
5. Use `browser_execute` only for a focused runtime check when crawl evidence is insufficient.

## Success criteria

- The source map URL is discovered from the loaded script or local resource.
- Original source metadata or bounded `sourcesContent` evidence is available through artifact reads.
- The conclusion states whether source-map needs are closed by existing crawl/artifact flow.

## Required evidence

- Summary evidence: source-map discovery result with script URL, map URL, source count, and saved artifact path.
- Artifact evidence: source-map `artifact` path and bounded snippet/search result for a synthetic original source identifier.
- Diagnostics evidence: crawl scope, max pages, same-origin setting, and any parser-diagnostics or parser warnings.

## Recovery checks

- Expected failure mode: source map comment is absent, path is relative, or map content is too large for summary.
- Required recovery path: inspect script artifact with `browser_artifact`, resolve relative map path under same origin, and keep full map content artifact-first.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after missing or relative source map
- artifact sufficiency
- scoped follow-up discipline

## Capability closure classification

- Classification: existing `browser_crawl` plus `browser_artifact` is sufficient unless eval shows repeated runtime-only script source gaps that cannot be represented as crawl artifacts.
- Canonical surface: `browser_crawl` and `browser_artifact`; focused runtime reads remain `browser_execute`.
- Closure result: this eval must not introduce `browser_sources`; unresolved gaps require a separate RFC.
