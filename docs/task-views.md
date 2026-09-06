# Declarative task views

`browser_observe` accepts an optional `view` that organizes already captured evidence around an object or literal text query. It does not click, scroll, load another page, run a planner, or decide business success. Omit `view`, or use `"page"`, for the existing whole-page output.

```json
{
  "view": {
    "focus": { "query": "INV-2048" },
    "intent": "locate"
  }
}
```

After locating the object, use its actual returned ref:

```json
{
  "mode": "diff",
  "view": {
    "focus": { "refs": ["bp-ref://element/example-invoice"] },
    "intent": "interact",
    "fields": ["Note"]
  }
}
```

The example ref is illustrative. An expired ref is rejected; the observer never substitutes a same-named object. Focus refs must belong to one current browser target. An explicit `targetRef` must agree with that owner.

## Input

| Field         | Meaning                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `focus.refs`  | One to eight page refs, with duplicates removed after validation. Identity anchors, not ranking hints.                                                                               |
| `focus.query` | A non-blank literal query of at most 256 characters. Mutually exclusive with refs. Matching normalizes whitespace and case; it does not interpret dates, synonyms or business rules. |
| `intent`      | `locate`, `read` (default), `interact`, or `check`. Observation interests, not action permissions.                                                                                   |
| `fields`      | Up to 16 non-blank field labels, each at most 64 characters. Priorities, not an exclusive whitelist.                                                                                 |

Every task view requires explicit focus. There is no persistent task filter or display-history cache. Switching fields on an unchanged page returns current context; `mode: "diff"` adds available changes without turning the task view into a patch that depends on earlier output.

## Output and evidence

Task output adds `task` and `bundles` to the observation view. Each bundle keeps an object identity together with its fields, related controls, captured text, observed changes and known context gaps. Folded controls are not left behind as isolated `actionSpace` entries.

`task` separates three scopes:

- `observationScope`: captured entity count, content/action completeness, collection counts, pagination or virtualization limits, and whether selection reached an internal bound.
- `matchScope`: matching method, candidate count and counting unit, text occurrence count, and searched input categories. Hits in one proven structural object are one candidate; distinct records are not merged by name.
- `outputScope`: total, inline and folded groups, including mandatory groups, and whether all selected necessary context is inline and available.

`status` is `resolved`, `ambiguous`, `no-match-in-observed`, or `unresolved`. A resolved identity does not imply complete context. No match means no match under the stated literal rule in the captured inputs; it never proves absence from other pages or unloaded records. A text-only hit can remain unresolved because it does not identify a control or record.

Visible dialogs, alerts and status regions are retained independently of query relevance. Their text is evidence of what was displayed, not proof of a backend state. Missing relationships, uncaptured children, preferred fields not observed and internal selection limits are disclosed as gaps. Context text taken from the captured AX tree is marked `textSource: "ax"`.

The implementation uses captured structure and typed relationships. For DOM controls with simple `#id` selectors, a unique ID in the captured main-document DOMSnapshot can associate AX context. This does not add backend locators, upgrade ref identity, or confer actionability. Geometry alone does not establish task ownership. Unproven structure is reported as incomplete context.

`check` organizes current UI facts and related changes only. Use [`browser_operation`](operation-outcomes.md) for a specific operation's execution receipt, assertions and declared business outcome. A success-looking status and a remaining error are both retained.

## Budgets and resources

The canonical observation is saved unchanged before task selection. Selection precedes generic projection limits. The task view is limited to 32 KiB of serialized UTF-8 JSON and folds whole bundles. If a mandatory group cannot fit, the view discloses the folded blocker and does not fill the space with actionable candidate fragments.

Internal bounds include 20,000 indexed entities, 256 materialized object groups and 128 facts per group. A text-only match can add one evidence group. Preferred fields are ranked before the context bound. Bounded text excerpts and incomplete relationships are disclosed; the original captured model remains independently available. These limits do not authorize further page exploration.

The task frontier links to a separate, versioned task artifact. Its index returns bounded pages of group descriptions, group resource URIs, a scope resource URI and, when needed, a next-index URI. Read a group to obtain its saved evidence and refs. Those refs remain subject to existing live execution freshness checks.

Task resources validate the artifact digest, schema, snapshot identity, expiry, project root and group index. They never reread the live page. Editing or navigating after an observation cannot change an older task resource. Missing or expired resources return an error; they do not refresh silently. Task artifacts use the existing observation-artifact retention policy.

The MCP text representation includes the task view alongside structured output so a text-only consumer can see ambiguity and gaps. Hosts consuming both channels may see duplicated text. The 32 KiB limit applies to view JSON, not the entire MCP envelope or explicitly expanded resources. Evaluation records daemon and rendered MCP sizes with resource reads included; bytes are not model tokens.

## Validation and limits

Deterministic tests cover selection, record identity, missing/conflicting refs, portal context, virtualized no-match boundaries, field changes, budget folding and historical resources. Browser scenarios `task-view-record` and `task-view-ambiguity` exercise task-resource refs, the text representation, targeted edits, conflicting visible feedback, and stale focus after navigation.

These are controlled single-Agent fixtures. They do not establish arbitrary-site success, universal host resource support or model-token savings. The runtime adds no multi-Agent coordination, semantic retrieval, incremental scanning, automatic recovery writes or business planning.
