# Browser Memory / Learning Mechanism — Design Plan (WIP)

Status: DESIGN RECORD ONLY. Execution source of truth is now `docs/browser-memory-learning-mechanism-plan.md`.
Do not implement directly from this `.plan` file.

## Goal

Give pi-browser-tools a learning/memory layer: after a task succeeds, distill reusable
knowledge so a later similar task does it with fewer wrong actions. Driving examples:
- 小红书：打开 → 搜 AI → 给第一个作品点赞（具体过程）
- 逆向/渗透分析一个网站（方法论）

## Research findings (subagents, facts only)

- **D:\GA** = the real learning engine. File-based, LLM-driven, NO embeddings.
  L0 governance SOP; L1 ≤30-line scene→file index injected into prompt; L2 stable facts;
  L3 flat HOW-only SOPs (linear AND routing skeletons); L4 cron-archived transcripts.
  Write = model explicitly calls `start_long_term_update` after a task → distills
  action-verified facts. Axioms: "No Execution, No Memory"; patch-only; ROI prune.
  Recall = L1 always-injected + model reads files by name. No ranking engine.
- **pi-re-tools** = NOT learning. Per-call raw artifact logging `<scope>/<run_id>/<cmd>.json`,
  no cross-run synthesis/index. An evidence substrate only.
- **Current pi-browser-tools** ALREADY has the evidence substrate (`.pi/browser-artifacts/`
  + resultMiddleware + registerArtifactTool) ≈ GA L4, and a static bootstrap methodology
  (`skills/pi-browser-tools/SKILL.md`) ≈ factory L3.

## Core insight

We have L4 (evidence) and a static bootstrap L3 (skill). MISSING = GA's accretion loop:
distill → layered store → recall. Build that, adapted to standard MCP + origin context.
Do NOT rebuild pi-re-tools logging (already have it).

## Model — 4 layers, NO domain split

"Site-procedural vs methodology" split RETRACTED — orthogonal to the layer axis. SOPs are one
flat set; their skeleton (linear vs routing) is a per-SOP authoring choice. The axis that
actually matters for storage/sharing is **sensitivity + scope**, captured by `scopeKind`.

| Layer | Form | Notes |
|---|---|---|
| L4 evidence | existing `.pi/browser-artifacts/` | unchanged; source of `evidenceRefs` |
| L3 SOP | flat `sop/` (frontmatter + HOW body) | skeleton is authoring choice |
| L2 facts | `facts/` keyed by `scopeKey` | facts carry concrete/sensitive data |
| L1 index | **DERIVED** from L2/L3 frontmatter | never hand-edited (avoids drift) |
| L0 governance | enforced in tool code + short doc | evidence gate, redaction, schema, caps |

## LOCKED decisions

### Storage — all-local in v1, promote deferred (user ① + reviewer 1,5)
- v1 writes EVERYTHING to `.pi/browser-memory/` (gitignored, per-machine). L1/L2/L3 are just
  layered subdirs there. **No repo-tracked memory in v1. No promote/export-to-repo in v1.**
- Rationale (beyond git-cleanliness): auto-tracking would rely on v1 L0 (format + secret
  regex) to catch semantic leaks like an internal endpoint embedded in a SOP step — regex
  completeness is not trustworthy. All-local removes that risk class entirely.
- v2 `export`/promote: explicit action with diff preview + dry-run + CI scan (IP/internal
  domains); tracked target only accepts curated, generalized SOPs with NO
  selector/auth/target-details/stealth/captcha/human-behavior/engagement content.
- MCP/install-package may be read-only → another reason runtime never writes into the package.

### Recall faces — explicit tool + bounded auto-surface pointer (user ②, OVERRIDES reviewer 9)
Reviewer 9 preferred v1 = explicit recall only. User keeps a **minimal one-line pointer** in
v1, bounded by reviewer 9's constraints:
- Emit ONLY when index has an exact-origin hit (no "0 SOPs" noise line).
- Append ONE `nextActions` string, NO body, e.g.
  `relevant memory: browser_memory recall origin=xiaohongshu.com (3 SOPs, 1 fact)`.
- exact-origin match only; ≤3 handles; toggleable via env (e.g. PI_BROWSER_MEMORY_AUTOSURFACE=0).
- Do NOT trigger on URL-less surfaces (e.g. tabs list). Only on results with a real origin.
- Reuses existing `nextActions` semantics — NO new section/resource_link machinery in v1.
- Hot-path cost = lookup index → if hit → push one string. Zero heavy logic. (Full
  section/resource sub-surfacing → v2.)

### Origin key — normalized host, zero-dependency (user ③ + reviewer 10)
- `normalize(url) = new URL(url).hostname.toLowerCase().replace(/^www\./, '')`.
  `www.xiaohongshu.com → xiaohongshu.com`; `m.xiaohongshu.com` stays split (no wrong merge);
  `XiaoHongShu.COM → xiaohongshu.com`.
- **localhost / IP literals stored verbatim** (`localhost`, `192.168.1.100`), no normalization
  — pentest targets are IPs; literal is correct.
- NO eTLD+1 in v1 (avoids public-suffix-list ~200KB dep + update mechanism). Revisit when a
  real "subdomain must share memory" case appears, with data to justify the dependency.
- Filesystem path uses a safe slug of the key.

### Write is evidence-gated — makes "No Execution, No Memory" verifiable (reviewer 2)
`record` MUST carry `evidenceRefs` (operationId / snapshotId / saved.path / browser-result://
uri). Tool validates each ref is **readable, not expired, and redacted** before persisting.
No evidence → reject. This is the enforceable form of GA's axiom.

### Persistent resource is browser-memory://, NEW standalone store (reviewer 3, decision E)
The existing resource store holds short-TTL result-artifact handles and MUST keep that
"short-lived result handle" semantics unchanged. Memory is persistent → build a SEPARATE store:
- New scheme `browser-memory://` (`browser-memory://index`, `://sop/<id>`, `://fact/<scopeKey>`);
  URIs MUST NOT expose local fs paths.
- New store: persistent semantics, NO short TTL; still carries etag/stale detection.
- **Extract shared freshness module** `mcp/resourceFreshness.ts` (move/share `computeEtag` /
  `isFresh` out of residual-B `mcp/resourceStore.ts`) so both stores use one impl. ← refactor task.
- Dedicated small reader for the memory store, rooted at `.pi/browser-memory/`. Do NOT force it
  through `browser_artifact`'s `.pi/browser-artifacts/` root/boundary.

### Single tool `browser_memory` (reviewer 4, decision A)
One tool, `action` discriminator. v1 actions: `record | recall | read | validate` ONLY.
`export`/promote is v2 — and is NOT to be written as a current capability anywhere in docs.
Not `browser_memory_recall`-style separate names.

### Append-only + tombstone, explicit compaction (reviewer 8 — resolves patch-only vs prune)
- Updates are append-only; superseded entries get `status: deprecated` (tombstone), never
  destructive overwrite.
- Compaction/cleanup is an EXPLICIT maintenance action that writes an audit artifact
  (`.pi/browser-memory/audit/<ts>-<op>.json`). No silent pruning.

### L1 derived from frontmatter (reviewer 7, decision C)
L1 is regenerated by scanning L2/L3 frontmatter — never hand-patched. Only the machine-derived
`index.json` is maintained; NO `index.md` (human-read need is met by `recall` summaries + docs
examples). Frontmatter schema (min): `id, title, triggers[], scopeKind, scopeKey, sensitivity,
status, confidence, verifiedAt, evidenceRefs[], updatedAt, schemaVersion`.

### Scope schema generalized (reviewer 6, decision B)
Entries carry `{ scopeKind: "origin" | "task" | "project", scopeKey }`. v1 default/only allows
`origin`. A `record`/`validate` with `scopeKind: task|project` is REJECTED with
`UNSUPPORTED_SCOPE_KIND` (no fake capability). The enum exists in schema so v2 needs no
migration; task/project curation = v2.

### Recall return shape (reviewer 11)
Inline = L1 cards only: `{id, title, triggers, scopeKind, scopeKey, matchReason, handles[]}`.
Full SOP/fact bodies are read via `browser-memory://` (action `read`), never pasted inline.

### Relation to the static skill (reviewer 12)
Learned SOPs SUPPLEMENT `skills/pi-browser-tools/SKILL.md`; they never silently supersede a
skill route. On conflict, `recall`/`read` returns a `diagnostics` note rather than overriding.

## Tool contract (draft — to firm before execution)

`browser_memory` params (per action):
- `record`: `kind("sop"|"fact")`, `scopeKind`, `scopeKey`(or `url` to normalize), `title`,
  `triggers[]`, `body`(HOW-only), `evidenceRefs[]`(required), `sensitivity?`, `confidence?`.
  → enforce evidenceRefs + schema + redaction/secret-scan + scope/origin normalization →
  append-only write → regen `index.json`. `scopeKind` task|project → `UNSUPPORTED_SCOPE_KIND`.
- `recall`: `url?`/`scopeKey?`/`query?` → inline bounded L1 cards (no bodies).
- `read`: `id` or `browser-memory://…` + bounded `mode/offset/limit/jsonPath` → body via
  the memory store (never inline-dumped).
- `validate`: dry-run a `record` payload (same enforcement) → diagnostics, no write.

**Enforcement invariant (v1):** `record`/`validate` MUST enforce evidenceRefs + schema +
redaction/secret-scan + scope/origin normalization; `recall`/`read` MUST return only bounded
cards/handles, bodies via `browser-memory://`. L0 governance lives in this CODE validation +
a short `docs/browser-memory.md` design note — NO separate L0 SOP file (decision D, avoids
governance-rule drift).

## Storage layout (v1, all gitignored)

```
.pi/browser-memory/
  sop/<scopeKind>-<scopeKey-slug>-<title-slug>.md   # L3: frontmatter + HOW body
  facts/<scopeKey-slug>.md                           # L2: frontmatter + facts
  index.json                                         # L1: DERIVED, regenerated on write
  audit/<ts>-<op>.json                               # explicit compaction audit
```
`.pi/` is already fully gitignored — confirm `browser-memory/` is covered.

## Execution-plan requirements (reviewer 13 — for when we DO build)

- Atomic writes: temp + rename; file lock for concurrent record.
- `schemaVersion` on every persisted entry.
- Reuse existing `redactSensitiveValue` for redaction (no parallel impl).
- Contract tests (e.g. `check-mcp-memory.mjs`, evidence-gate test, L1-derivation test,
  auto-surface bound test) wired into BOTH `package.json` scripts AND the `contracts` array
  in `scripts/run-check-groups.mjs`; gated by `npm run check`.
- Sync generated docs / README / CHANGELOG / TODO / skill on tool addition (per AGENTS.md).
- Final gate: `tsc` both projects + `npm run check` green.

## Resolved (all LOCKED)

A. v1 actions = `record/recall/read/validate`; `export`/promote v2, not a documented capability.
B. `scopeKind` enum in schema; v1 allows `origin` only; task|project → `UNSUPPORTED_SCOPE_KIND`.
C. Maintain machine-derived `index.json` only; no `index.md`.
D. L0 = code validation + `docs/browser-memory.md`; no separate L0 SOP file.
E. New standalone `browser-memory://` store (persistent, no TTL, keeps etag/stale); extract
   shared `mcp/resourceFreshness.ts` (`computeEtag`/`isFresh`) from residual-B; dedicated reader
   rooted at `.pi/browser-memory/`; `browser-result://` semantics unchanged.

## Out of scope (v1)

- export/promote to repo, task/project curation, eTLD+1, MCP-prompt bundling, full
  section/resource auto-surface, embeddings, rebuilding per-call logging.

## Execution handoff

Use `docs/browser-memory-learning-mechanism-plan.md` for the executable plan. That plan includes
final implementation clarifications discovered during review, including durable evidence gating,
per-entry fact files, MCP resolver injection, and the browser-memory resource store boundary.
