# Historical Task Artifacts

These JSON files are byte-for-byte outputs of `projectTaskObservation()` executed from clean, detached checkouts. They were generated for this regression corpus, not collected from a user's historical browsing session. The input is a synthetic invoice with fixed observation time and opaque example refs; no personal capture was copied or redacted after generation.

| Version | Producer Commit                            | Cases            |
| ------- | ------------------------------------------ | ---------------- |
| v1      | `9bc01936f12c3ed84513610e24a3f452593d7c27` | owned, mixed-gap |
| v2      | `645570730a974f44be9d3bd0fc60b05c949c7194` | owned, mixed-gap |
| v3      | `f0a7afea5148ad327a5000c878f2aa6862493cf2` | owned, mixed-gap |
| v4      | `75c2aafd5387cbf6e4186416783d65aeba3c7f05` | owned, mixed-gap |

`provenance-v*.json` records the producer revision, source module digest, Node version, complete synthetic input/spec and output SHA-256. The input uses capture fields available to every producer. `owned` has complete local context; `mixed-gap` combines an uncaptured description and an unproven sibling action group. Older outputs intentionally retain their historical gaps and even historical bundle/packet disagreements: resource reading must not rewrite them using today's evaluator.

Ordinary tests read these committed files. They never invoke the current producer to synthesize an older schema, fetch Git history, or require the detached checkouts. The output files are excluded from Prettier because formatting would change their byte digests; `.gitattributes` preserves LF across platforms. Provenance files remain formatted normally.

To deliberately regenerate a version, create a clean checkout of its recorded revision and run:

```sh
git worktree add --detach .cache/task-history-producers/v1 9bc01936f12c3ed84513610e24a3f452593d7c27
node --import tsx scripts/generate-task-history.mjs .cache/task-history-producers/v1 9bc01936f12c3ed84513610e24a3f452593d7c27 tests/fixtures/task-history
```

The generator checks the checkout identity and runs that checkout's production module. It copies emitted artifacts without changing their schema, policy, evidence or timestamps. Resource UUIDs are genuinely producer-generated and may change on explicit regeneration; review the artifact and provenance diff together. Do not regenerate fixtures merely to make a reader change pass.
