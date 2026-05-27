# Eval 01: Readable Content Artifact

## Goal

Open a local article fixture, extract readable content, and cite an artifact path.

## Fixture

- Local target: `fixtures/article.html`
- Required files: HTML page with a clear article title, byline, body, navigation noise, and footer noise.
- Setup notes: serve from a local static server or open through a local file URL when supported.

## Allowed starting tools

- `browser_tabs`
- `browser_observe mode=content`
- `browser_observe mode=html`
- `browser_artifact`

## Expected tool sequence

1. Create or select a tab for the local fixture.
2. Run `browser_observe mode=content` with an explicit `tabId` or URL.
3. If extraction is weak, run `browser_observe mode=html` on an article/main selector.
4. Read the artifact path with `browser_artifact` only if the summary is insufficient.

## Success criteria

- Extracted content includes the article title and at least two body facts.
- Navigation/footer noise is excluded or clearly identified as noise.
- The final answer cites a saved artifact path when one is produced.

## Required evidence

- Summary evidence: readable title and body excerpt.
- Artifact evidence: content artifact path or targeted HTML artifact path.
- Diagnostics evidence: selector/extraction limitation if fallback was needed.

## Recovery checks

- Expected failure mode: automatic readable extraction selects navigation or wrapper text.
- Required recovery path: use `browser_observe mode=html` with a narrower selector before retrying content extraction.

## Metrics

- success/failure
- tool call count
- first wrong tool choice
- recovery after poor extraction
- artifact sufficiency
- whether broader tools were avoided
