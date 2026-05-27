# Eval 05: Download Artifact

## Goal

Download a local fixture file and inspect the resulting artifact metadata.

## Fixture

- Local target: `fixtures/download.html`
- Required files: page with a download link and a deterministic downloadable file such as `fixtures/files/report.txt`.
- Setup notes: direct URL and selector-click paths should both be possible.

## Allowed starting tools

- `browser_tabs`
- `browser_observe mode=scan`
- `browser_download`
- `browser_artifact`

## Expected tool sequence

1. Open the fixture page and identify the download link.
2. Use `browser_download` through selector click or direct URL.
3. Inspect returned path/state/metadata.
4. Use `browser_artifact` only for metadata or bounded content checks.

## Success criteria

- Download completes successfully.
- Returned path/state is reported.
- File metadata or bounded content confirms the expected fixture file.

## Required evidence

- Summary evidence: download-state and filename/path.
- Artifact evidence: downloaded file path, file-metadata, or tool artifact path.
- Diagnostics evidence: ambiguity reason if selector matched multiple links.

## Recovery checks

- Expected failure mode: selector click is ambiguous.
- Required recovery path: use direct URL download or index-specific selector handling.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after ambiguous selector
- artifact sufficiency
- direct vs selector download appropriateness
