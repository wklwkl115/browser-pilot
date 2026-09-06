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
- `outputScope`: total, inline and folded groups, including mandatory groups, and whether all selected necessary context is inline and available. `groupsUnavailable` and `mandatoryGroupsUnavailable` count groups that reached the materialization bound and have no group expansion; they are not counted as folded.

`status` is `resolved`, `ambiguous`, `no-match-in-observed`, or `unresolved`. A resolved identity does not imply complete context. No match means no match under the stated literal rule in the captured inputs; it never proves absence from other pages or unloaded records. A text-only hit can remain unresolved because it does not identify a control or record.

Visible dialogs, alerts and status regions are retained independently of query relevance. Their text is evidence of what was displayed, not proof of a backend state. Missing relationships, uncaptured children, preferred fields not observed and internal selection limits are disclosed as gaps. Context text taken from the captured AX tree is marked `textSource: "ax"`.

The implementation uses captured structure and typed relationships. For DOM controls with simple `#id` selectors, a unique ID in the captured main-document DOMSnapshot can associate AX context. This does not add backend locators, upgrade ref identity, or confer actionability. Geometry alone does not establish task ownership. Unproven structure is reported as incomplete context.

`check` organizes current UI facts and related changes only. Use [`browser_operation`](operation-outcomes.md) for a specific operation's execution receipt, assertions and declared business outcome. A success-looking status and a remaining error are both retained.

## Budgets and resources

The canonical observation is saved unchanged before task selection. Selection precedes generic projection limits. The task view is limited to 32 KiB of serialized UTF-8 JSON and folds whole bundles or dependency-complete packets. If a mandatory group cannot fit, the view discloses the folded blocker and does not fill the space with actionable candidate fragments.

Internal bounds include 20,000 indexed entities, 256 materialized object groups and 128 facts per group. A text-only match can add one evidence group. Preferred fields are ranked before the context bound. Bounded text excerpts and incomplete relationships are disclosed; the original captured model remains independently available. These limits do not authorize further page exploration.

The task frontier links to a separate, versioned task artifact. Its index returns bounded pages of group descriptions, group resource URIs, a scope resource URI and, when needed, a next-index URI. Read a group to obtain its saved evidence and refs. Those refs remain subject to existing live execution freshness checks.

Task resources validate the artifact digest, schema, snapshot identity, expiry, project root and group index. They never reread the live page. Editing or navigating after an observation cannot change an older task resource. Missing or expired resources return an error; they do not refresh silently. Task artifacts use the existing observation-artifact retention policy.

The MCP text representation includes the task view alongside structured output so a text-only consumer can see ambiguity and gaps. Hosts consuming both channels may see duplicated text. The 32 KiB limit applies to view JSON, not the entire MCP envelope or explicitly expanded resources. Evaluation records daemon and rendered MCP sizes with resource reads included; bytes are not model tokens.

## Validation and limits

Deterministic tests cover selection, record identity, missing/conflicting refs, portal context, virtualized no-match boundaries, field changes, budget folding and historical resources. Browser scenarios `task-view-record` and `task-view-ambiguity` exercise task-resource refs, the text representation, targeted edits, conflicting visible feedback, and stale focus after navigation.

These are controlled single-Agent fixtures. They do not establish arbitrary-site success, universal host resource support or model-token savings. The runtime adds no multi-Agent coordination, semantic retrieval, incremental scanning, automatic recovery writes or business planning.

Task contexts traverse explicit container anchors even when those anchors were already selected. A nested layout group retains its local content and supplements captured fields under a proven enclosing form/row/article/dialog, including ordinary cells and text wrappers. Distinct structural objects are excluded. Sibling group/region boundaries have uncertain ownership: they remain excluded and produce explicit context gaps; labels such as Actions or invoice numbers never establish ownership. Cyclic captured ancestry is deduplicated.

Task index entries include `resourceJsonBytes` (UTF-8 bytes of the full group JSON, excluding the MCP envelope) and `exceedsInlineBudget`. Large groups remain explicit opt-in expansions; the inline budget is not a resource cap. Evaluation separately reports cumulative `resourceResponseJsonBytes`, `maxResourceResponseJsonBytes`, and per-read `resourceKind` so index, group, and scope costs can be inspected. Total MCP bytes include these resource reads.

## Structured requirements and remedies

Each bundle exposes `requirements`, `gapDetails`, and `remedies`. The compatibility `gaps: string[]` is derived from `gapDetails` codes. Gap and remedy IDs are scoped to the saved task artifact; refs cite captured evidence and do not grant execution permission.

The four requirements remain `local` (fields and related context), `owner` (captured structural owner), `identity` (captured object identification context), and `actions` (applicable controls with object context and known dependencies). Identification completeness is scoped to the observed object; it does not prove a globally unique business identifier. Group requirements cover the logical object; packet requirements cover their explicitly declared subject and dependencies.

Each requirement contains independent `evidence` and `delivery` states, plus `reasonCodes`, `evidenceRefs`, and `gapIds`:

| Dimension  | States                                                         | Meaning                                                                                                                                                                                  |
| ---------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evidence` | `complete`, `incomplete`, `unknown`, `not-applicable`          | Whether the inspected canonical evidence meets the declared requirement. Known missing relations are incomplete; unproven ownership and uninspected index regions remain unknown.        |
| `delivery` | `inline`, `partial`, `folded`, `unavailable`, `not-applicable` | How much supporting evidence this response delivers. Inline means the applicable evidence and necessary context are delivered; partial can reflect missing evidence or selection limits. |

Evaluation traverses captured relations before ranking or truncation. Changing only the output byte budget never changes evidence status. A large captured form can have complete evidence with partial delivery after the 128-fact selection limit. Group index entries describe folded delivery; reading the group restores its saved inline/partial delivery, preserving all capture and association gaps. A budget-folded bundle is discovered through the task frontier's index rather than an orphan control or a truncated bundle. The index and group share the same evidence status.

Each `gapDetails` item includes its requirement, layer, related refs, human-readable reason, and remedy IDs:

| Layer         | Interpretation and available next step                                                                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delivery`    | Saved group evidence is omitted here. Follow the generated `read-snapshot` remedy for that group.                                                                                                           |
| `selection`   | The group omits captured facts/text, or a bounded index has not inspected them. A generated evidence resource may provide more of the same snapshot; reading the group itself cannot restore omitted facts. |
| `capture`     | Required evidence is missing from capture, or its existence is unknown. `observe-again` explicitly changes the snapshot and is not a promise that another observation will find it.                         |
| `association` | Structure or labels do not prove ownership. `disambiguate` retains the uncertain refs; an optional snapshot read allows inspection without establishing a relationship.                                     |
| `freshness`   | Reserved for explicit freshness gaps. Existing expired focus/resource checks still fail, without silently refreshing or substituting another object.                                                        |

`read-snapshot` specifies a generated `resourceUri` and `mayAddress` gap IDs, not a guarantee of resolution. `observe-again` carries `changesSnapshot: true`. `disambiguate` includes candidate refs and a reason. `page-action-required` is part of the contract but is not inferred from generic missing capture in this policy. No remedy runs automatically, and there is no `readyToAct` flag.

When selection or association needs inspection beyond the materialized group, an additional registered evidence resource reads the saved canonical artifact. It returns public facts, captured typed relations, structural parent refs and capture boundaries, with password values and locator internals omitted. Text is not truncated by the group's text limit. The entity index remains bounded at 20,000 and reports `selectionComplete`; this resource is a broad, explicit expansion, not a dependency-complete packet. Its SHA-256, snapshot identity, expiry, project scope and projection policy are checked before reading. It never queries the page or operation registry. The existing whole-page semantic resource and `/groups/...` resources retain their meanings.

New artifacts use `browser-task-projection/v4` and `literal-context-v4`. The reader still accepts valid v1, v2 and v3 artifacts and returns their original bundle/packet shape; it does not fabricate new evidence for historical artifacts. Unknown or mismatched schema/policy versions fail. The task artifact digest binds the normalized task spec, canonical digest and saved requirements together. Reading any expansion leaves the saved report unchanged; only a new assessment with the missing evidence can remove a capture or association gap.

## Progressive field packets

`packets` are independent delivery units alongside `bundles`. A focused editable/control ref or a captured field matching `fields` can produce a field/action packet from the canonical entity index, including fields beyond the group's 128-fact materialization bound. Each packet identifies its `bundleId`, question, subject, owner, snapshot, identification refs and complete dependency refs. `/groups/...` continues to read the saved logical group; it does not return a packet.

The fixed `field-context-v2` policy retains the subject, captured owner, static leaf identification fields, same-owner independent controls and feedback, then follows captured label, description, column, occlusion and control relations transitively. Identification uses captured non-editable leaf values/text, including ordinary wrappers; label/description subtrees belong to their respective fields. Clickable labels are field dependencies rather than independent owner operations. Unknown ownership and uncaptured dependencies remain gaps. Unrelated fields are excluded by policy, with an exclusion count and up to 16 representative reasons; budget changes never alter these rules. Packet context completeness is scoped to these dependencies, and does not imply that the whole form is displayed.

The planner materializes up to 256 packets with at most 128 required entities each. Larger dependency sets count as `packetsUnavailable`, with no false expansion promise. Required text is not truncated: an oversized error folds the whole packet, preserving the exact error in its resource. `packetsInline` and `packetsFolded` describe delivery independently of whole-group scope. Mandatory dialogs and blockers still take precedence. Packets that share an owner reuse the same captured refs; each resource retains its own identification context so it can be understood independently.

The task index includes a `packetIndex` with generated packet URIs, question, owner, gaps, completeness and exact expanded `resourceJsonBytes`. Follow its index/next URI for additional bounded pages. Packet reads include snapshot and canonical digest, capture/expiry times, task scope and the saved packet. They use no live browser or operation registry. Standard MCP resource reading and text/structured tool output expose the same evidence boundaries; the link alone does not mean a host has read the packet.

## Captured ownership evidence

Normal DOM capture reads native control `.form` and `.labels`, plus explicit ARIA labels/descriptions. Referenced targets enter the canonical entity model; selectors resolve only to unambiguous captured refs in the same target scope. A missing or conflicting endpoint remains incomplete. Projection remains pure and adds no browser reads.

Controls without IDs can bind AX context through matching structured DOM paths captured by both the normal scan and main-document DOMSnapshot. Paths count only element siblings, ignore JSON property ordering and are bounded to 64 ancestors and the first 20,000 snapshot nodes (ID lookup remains available). This association does not upgrade execution locators or ref identity. Unmapped captured AX controls mark their container context incomplete, so a proven subset cannot silently discharge an unknown boundary. DOM-derived label/description text carries `textSource: "dom"` and explicit capture truncation; AX context remains marked `ax`.

`relationEvidence` records `fromRef`, `toRef`, relation, basis (`native-association`, `captured-structure`, or `explicit-relation`), snapshot ID and source. Native form ownership can admit an external or sibling-group control individually. It does not admit the entire wrapper, unrelated descendants, another form, or another structural record under the same form. A sibling boundary is only discharged when its captured controls have proven associations and no unexplained static evidence remains. Unclassified/custom controls retain association gaps. A captured null native owner does not become a proven action owner through ancestry.

Table cell/row/header relations retain their captured structural evidence. Multiple competing headers for the same column no longer silently select the last header; that relation remains incomplete. Identification completeness remains local to the observed object and candidate set, and equal titles never merge records.

These distinctions follow the [HTML form-owner model](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#form-owner) and [ARIA relationship semantics](https://www.w3.org/TR/wai-aria-1.2/#aria-controls). A controls relation is not a business ownership relation. Custom form-associated components, arbitrary cross-frame native association and general semantic retrieval remain outside this policy.
