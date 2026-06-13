# Dictionary And Wordlist Governance Plan

> Summary archive for `docs/archive/dictionary-and-wordlist-governance-plan.full.md`.

This 2026-06-04 future plan captured a one-time inventory of hard-coded
dictionaries, keyword lists, and payload tables. It was never activated as a
current execution line and is now archived as historical planning context.

## Archived Decisions

- ABML pure-core vocabulary cannot add runtime dependencies; any ARIA vocabulary
  refresh must use build-time code generation into static constants.
- WebSecurity payload/signature wordlists are the best candidate for external
  wordlist support, bounded by local-only file handling and unchanged defaults.
- Redaction-sensitive field lists should stay built in and deterministic, with
  occasional reference calibration rather than runtime dependency loading.
- Tool-specific noise lists and intent heuristics stay local unless a new
  evidence-backed execution contract reopens them.

## Evidence

- Full historical plan:
  `docs/archive/dictionary-and-wordlist-governance-plan.full.md`
- Original source date:
  2026-06-04
