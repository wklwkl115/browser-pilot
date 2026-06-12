# Concept Ownership

> Doc-class: reference

This reference answers two routing questions before cross-layer edits:

- Which layer owns a concept such as ref, artifact, lease, snapshot, operation,
  perception ledger, renderer, session delta, memory plane, effect, or wordlist?
- Which producer path is responsible for an envelope or summary field?

Generated field maps are synchronized by `npm run docs:sync` and checked by
`npm run check:docs-sync`. Hand notes are intentionally preserved by field key;
new generated rows start with an empty Hand notes cell and `--check` names them.

## Concept Ownership Matrix

| Concept | Owning modules | Key types / handles | Guarding gates | Maintenance note |
| --- | --- | --- | --- | --- |
| ref | `src/abml-core/refId.ts`, `src/abml-core/refPolicy.ts`, `src/abml-core/entity.ts`, compatibility shims in `src/abml/` | `pi-ref://...`, `Entity.ref`, ref policy decisions | `check:abml-ref-registry`, `check:abml-core-boundary`, `check:surface-liveness` | Ref minting is pure-kernel ownership; runtime may resolve refs but must not invent incompatible schemes. |
| artifact | `src/tools/artifacts.ts`, `src/tools/artifactReader.ts`, `src/resources/resourceStore.ts`, `src/tools/resultMiddleware.ts` | local artifact path, `jsonPath`, redaction pointer, `saved` descriptor | `check:artifact`, `check:summaries`, `check:token` | Raw evidence stays local; model-facing output should carry compact descriptors and read hints. |
| lease | `src/driver/BrowserLeaseRegistry.ts`, `src/driver/BrowserTabSessionRouter.ts`, native action tools through `src/tools/toolAdapter.ts` | tab lease info, `leaseOwnerHash`, browser session/tab ids | `check:lifecycle`, `check:pi-browser-bridge`, `check:tools` | Leases are driver/session write-conflict control, not agent strategy. |
| snapshot | `src/driver/BrowserObservationSnapshotRegistry.ts`, `src/tools/observe/scanRunner.ts`, `src/tools/observe/baseline.ts` | `snapshotId`, `BrowserObservationSnapshotInfo`, observe baseline | `check:scan`, `check:abml-scan-envelope`, `check:session-delta-long-conversation` | Snapshot ids are short-lived evidence handles; stale reads must fail with recovery. |
| operation | `src/driver/BrowserOperationRegistry.ts`, `src/tools/toolAdapter.ts`, action tool registrars | `operationId`, `BrowserActiveOperationInfo`, operation metadata | `check:lifecycle`, `check:summaries`, `check:artifact` | Operation metadata exists to correlate follow-up evidence, not to prove task success by itself. |
| perception ledger | `src/abml/perceptionLedger.ts`, `src/tools/observe/renderCache.ts`, `src/tools/observe/relevanceFusion.ts` | `PerceptionLedgerFrame`, `PerceptionLedgerKey`, stable refs, trace ring | `check:session-delta-long-conversation`, `check:task-conditioned-salience`, `check:token-economy` | Ledger state is live-session perception memory; keep pure facts separate from driver I/O. |
| token budget / renderer | `src/tools/budgets.ts`, `src/distill-core/`, `src/tools/resultMiddleware.ts` | `maxChars`, `detailLevel`, `renderer:"salience-v1"`, omitted markers | `check:token`, `check:token-economy`, `bench:distill`, `check:summaries` | Renderer changes must preserve omission disclosure and artifact fallback semantics. |
| session delta | `src/tools/observe/scanRunner.ts`, `src/tools/observe/baseline.ts`, `src/abml/perceptionLedger.ts`, `src/tools/resultMiddleware.ts` | `delta:"session"`, `baselineSnapshotId`, baseline entities | `check:session-delta-long-conversation`, `check:abml-diff`, `check:abml-tree-diff` | Session delta is an observe optimization; `fresh:true` and disabled env paths must remain honest. |
| memory plane | `src/tools/memory/`, `src/memory-core/`, `src/memory/`, `src/tools/memory/autoSurface.ts` | memory entry id, scope kind/key, memory evidence ref, `envelope.memory` | `check:memory-plane`, `check:memory-autosurface`, `check:memory-lifecycle`, `check:memory-core-boundary` | Auto-surface must not steal budget from live evidence or surface unrelated stale memories. |
| effect | `src/tools/executionEffect.ts`, `src/tools/registerExecuteTool.ts`, `src/tools/registerCommandTool.ts` | `effect`, mutation/network/hook deltas, target delta, anchor | `check:tools`, `check:summaries`, `test:unit:tools` | Unknown or partial signals must stay explicit; do not render uncertainty as zero effect. |
| wordlists | `src/tools/webSecurity/shared/normalize.ts`, `src/tools/webSecurity/browserNative/fuzzPaths.ts`, `src/tools/webSecurity/browserNative/fuzzParams.ts`, `src/tools/webSecurity/browserNative/fuzzVhosts.ts`, `src/tools/webSecurity/browserNative/sqliProbe.ts`, `src/tools/webSecurity/browserNative/cookieAnalyze.ts` | `wordlist`, `wordlistPath`, bounded local file entries, `WORDLIST_PATH_BLOCKED` | `check:web-security`, `check:tool-parameter-contract`, `check:input-surface` | Wordlist paths are scoped local inputs; keep size/path bounds and do not bundle private operator lists. |

## Envelope Field Map

Envelope fields are produced by the `distilledJsonResult` / `distilledTextResult`
path in `src/tools/resultMiddleware.ts`, not by a single tool summary schema.

<!-- BEGIN GENERATED: concept-envelope-fields (npm run docs:sync) -->
| Envelope field | Producer path | Hand notes |
| --- | --- | --- |
| `DistilledEnvelope.tool` | src/tools/resultMiddleware.ts:responseEnvelope() from options.toolName | Tool name from the shared result middleware; first field for cross-tool diagnosis. |
| `DistilledEnvelope.command` | src/tools/resultMiddleware.ts:responseEnvelope() from options.command | Native or logical subcommand when available. |
| `DistilledEnvelope.browserSessionId` | src/tools/resultMiddleware.ts:responseEnvelope() from options.browserSessionId | Browser-session correlation; optional when the tool is not session-scoped. |
| `DistilledEnvelope.detailLevel` | src/tools/resultMiddleware.ts:normalizeDetailLevel() | Normalized detail level that selected envelope rendering behavior. |
| `DistilledEnvelope.summary` | src/tools/resultMiddleware.ts + src/tools/distillerRegistry.ts | Budget-fitted distiller summary; schema depends on the tool/subcommand. |
| `DistilledEnvelope.diagnostics` | src/tools/resultMiddleware.ts:normalizedDiagnostics() | High-signal status/warning block assembled by normalizedDiagnostics(). |
| `DistilledEnvelope.diagnostics.artifact` | src/tools/resultMiddleware.ts:compactArtifactDescriptor() | Compact descriptor for saved raw result when diagnostics includes one. |
| `DistilledEnvelope.target` | src/tools/resultMiddleware.ts:normalizedTarget() | Normalized browser/tab/frame/url target metadata from summary and options. |
| `DistilledEnvelope.limits` | src/tools/resultMiddleware.ts:normalizedLimits() | Budget/truncation/request-count limits visible to the agent. |
| `DistilledEnvelope.privacy` | src/tools/resultMiddleware.ts:normalizedPrivacy() | Redaction/sensitive-evidence disclosure; raw sensitive values stay local. |
| `DistilledEnvelope.entities` | src/tools/resultMiddleware.ts:envelopeEntities() | Lifted entity subset for cheap follow-up refs. |
| `DistilledEnvelope.abmlIntegrated` | src/tools/resultMiddleware.ts from summary.abmlIntegrated | Boolean disclosure that ABML data was integrated into the observation. |
| `DistilledEnvelope.gist` | src/tools/resultMiddleware.ts:envelopeGist() | L0 page overview lifted so budget squeeze does not hide it. |
| `DistilledEnvelope.outline` | src/tools/resultMiddleware.ts:envelopeOutline() | L1 container fold lifted from scan focus when present. |
| `DistilledEnvelope.relations` | src/tools/resultMiddleware.ts:envelopeRelations() | Relationship graph summary lifted from scan focus. |
| `DistilledEnvelope.inference` | src/tools/resultMiddleware.ts type only / compatibility | Declared compatibility field; current response path does not lift it by default. |
| `DistilledEnvelope.diff` | src/tools/resultMiddleware.ts:envelopeDiff() | Temporal entity diff lifted from summary/focus when baseline exists. |
| `DistilledEnvelope.causal` | src/tools/resultMiddleware.ts:envelopeCausal() | Passive network/event delta lifted from summary when baseline exists. |
| `DistilledEnvelope.templates` | src/tools/resultMiddleware.ts type only / compatibility | Declared compatibility field; current response path keeps template data in summary/artifact. |
| `DistilledEnvelope.treeDiff` | src/tools/resultMiddleware.ts:envelopeTreeDiff() | Template-level living diff lifted from summary/focus. |
| `DistilledEnvelope.snapshotProjection` | src/tools/resultMiddleware.ts:envelopeSnapshotProjection() | Persisted living snapshot projection lifted from summary/focus. |
| `DistilledEnvelope.error` | src/tools/resultMiddleware.ts:envelopeError() | Compact structured error block when summary or explicit error indicates failure. |
| `DistilledEnvelope.nextActions` | src/tools/resultMiddleware.ts:normalizedNextActions() | Factual follow-up hints, capped and deduped; no hidden strategy chaining. |
| `DistilledEnvelope.correlation` | src/tools/resultMiddleware.ts:responseEnvelope() correlation assembly | Cross-tool ids copied from summary/operation/snapshot for artifact reads. |
| `DistilledEnvelope.operation` | src/tools/toolAdapter.ts + src/driver/BrowserOperationRegistry.ts | Tracked operation metadata from toolAdapter/driver registries. |
| `DistilledEnvelope.snapshot` | src/tools/observe/scanRunner.ts + src/driver/BrowserObservationSnapshotRegistry.ts | Observation snapshot metadata from observe/runtime snapshot registries. |
| `DistilledEnvelope.saved` | src/tools/resultMiddleware.ts:executeArtifactPlan() | Local artifact descriptor returned by saveTextArtifact(). |
| `DistilledEnvelope.memory` | src/tools/memory/autoSurface.ts via appendMemoryAutoSurface() | Optional browser_memory auto-surface block injected after base envelope fitting. |
| `DistilledEnvelope.renderer` | src/tools/resultMiddleware.ts:rendererMarker() | Self-marking salience renderer marker. |
| `DistilledEnvelope.delta` | src/tools/resultMiddleware.ts from summary.delta | Session-delta marker for P-frame observe results. |
| `DistilledEnvelope.baselineSnapshotId` | src/tools/resultMiddleware.ts from summary.baselineSnapshotId | Prior snapshot id used as the delta baseline. |
<!-- END GENERATED: concept-envelope-fields -->

## Summary Field Maps

These tables enumerate registered distiller output schemas from
`src/tools/distillerRegistry.ts`, plus `ScanSummarySchema` as the first-class
observe scan summary contract.

### EvidenceSummarySchema

<!-- BEGIN GENERATED: concept-fields-evidence-summary-schema (npm run docs:sync) -->
| Field | Required | Type | Schema description | Producer candidates | Hand notes |
| --- | --- | --- | --- | --- | --- |
| `EvidenceSummarySchema.tabId` | no | unknown | - | `src/tools/observe/scanRunner.ts`<br>`src/tools/observe/contentRunner.ts`<br>`src/tools/observe/htmlRunner.ts`<br>`src/tools/summaries/network.ts` | Target tab metadata; keep correlation-safe and optional for aggregate evidence. |
| `EvidenceSummarySchema.collected_at` | no | unknown | - | `src/tools/summaries/evidence.ts` | Collection timestamp from evidence capture; do not treat as ordering authority across tools. |
| `EvidenceSummarySchema.event_types` | no | unknown | - | `src/tools/summaries/evidence.ts` | Legacy/open event distribution; prefer structured source summaries when present. |
| `EvidenceSummarySchema.source_count` | yes | number | Number of evidence source types captured | `src/tools/summaries/evidence.ts` | Fast diagnostic count of evidence source families included in this capture. |
| `EvidenceSummarySchema.sources` | yes | object | - | `src/tools/summaries/evidence.ts`<br>`src/tools/observe/relevanceFusion.ts` | Per-source compact counts; raw evidence stays in artifacts when large or sensitive. |
<!-- END GENERATED: concept-fields-evidence-summary-schema -->

### HookDomFlowSummarySchema

<!-- BEGIN GENERATED: concept-fields-hook-dom-flow-summary-schema (npm run docs:sync) -->
| Field | Required | Type | Schema description | Producer candidates | Hand notes |
| --- | --- | --- | --- | --- | --- |
| `HookDomFlowSummarySchema.nodeCount` | no | number | Number of nodes with listeners | `src/tools/summaries/webSecurity/replay.ts` | Number of nodes with listener/sink data in the summarized hook result. |
| `HookDomFlowSummarySchema.listenerCount` | no | number | Total listener count across all nodes | `src/tools/summaries/outputSchemas.ts` (schema only) | Total listener count across returned nodes. |
| `HookDomFlowSummarySchema.nodes` | no | array<object+> | - | `src/tools/summaries/outputSchemas.ts` (schema only) | Loose node samples; preserve bounded sample semantics. |
| `HookDomFlowSummarySchema.rows` | no | array<object+> | - | `src/tools/summaries/scan.ts`<br>`src/tools/summaries/common.ts` | Open-tail row samples for table-style hook commands. |
| `HookDomFlowSummarySchema.sinkHints` | no | array<object+> | - | `src/tools/summaries/outputSchemas.ts` (schema only) | Sink hint samples; keep as triage hints, not vulnerability claims. |
| `HookDomFlowSummarySchema.items` | no | array<object+> | - | `src/tools/summaries/network.ts`<br>`src/tools/summaries/transfer.ts`<br>`src/tools/summaries/common.ts`<br>`src/tools/summaries/evidence.ts` | DOM-flow item list for listener-chain style commands. |
| `HookDomFlowSummarySchema.total` | no | unknown | - | `src/tools/summaries/hook.ts`<br>`src/tools/summaries/evidence.ts`<br>`src/tools/summaries/network.ts`<br>`src/tools/summaries/webSecurity/jsAst.ts` | Compatibility total for commands that return paged or table results. |
| `HookDomFlowSummarySchema.truncated` | no | unknown | - | `src/tools/summaries/webSecurity/jsAst.ts`<br>`src/tools/summaries/scan.ts`<br>`src/tools/summaries/webSecurity/replay.ts`<br>`src/tools/summaries/common.ts` | Signals capped hook output; follow artifact nextActions for full data. |
<!-- END GENERATED: concept-fields-hook-dom-flow-summary-schema -->

### MemorySummarySchema

<!-- BEGIN GENERATED: concept-fields-memory-summary-schema (npm run docs:sync) -->
| Field | Required | Type | Schema description | Producer candidates | Hand notes |
| --- | --- | --- | --- | --- | --- |
| `MemorySummarySchema.action` | yes | string | - | `src/tools/summaries/scan.ts`<br>`src/tools/summaries/memory.ts`<br>`src/tools/summaries/webSecurity/oast.ts`<br>`src/tools/summaries/webSecurity/ws.ts` | Memory subcommand/action label; required so all memory outputs stay diagnosable. |
| `MemorySummarySchema.ok` | no | boolean | - | `src/tools/summaries/webSecurity/cookie.ts`<br>`src/tools/observe/scanRunner.ts`<br>`src/tools/summaries/hook.ts`<br>`src/tools/summaries/webSecurity/crawl.ts` | Boolean success diagnostic for memory operations that expose one. |
| `MemorySummarySchema.scopeKind` | no | string | - | `src/tools/summaries/memory.ts`<br>`src/tools/observe/memoryAugmentation.ts` | Scope classifier for task/project/origin memory routing. |
| `MemorySummarySchema.scopeKey` | no | string | - | `src/tools/summaries/memory.ts`<br>`src/tools/observe/memoryAugmentation.ts` | Scope key; do not expose unredacted sensitive local paths. |
| `MemorySummarySchema.query` | no | string | - | `src/tools/observe/memoryAugmentation.ts`<br>`src/tools/summaries/memory.ts` | Recall query text after normal memory input handling. |
| `MemorySummarySchema.id` | no | string | - | `src/tools/observe/scanRunner.ts`<br>`src/tools/observe/memoryAugmentation.ts`<br>`src/tools/summaries/memory.ts`<br>`src/tools/summaries/network.ts` | Memory entry id for read/update/record follow-up. |
| `MemorySummarySchema.uri` | no | string | - | `src/tools/summaries/memory.ts` | Resource-style memory URI when the operation returns one. |
| `MemorySummarySchema.mode` | no | string | - | `src/tools/observe/scanRunner.ts`<br>`src/tools/observe/renderCache.ts`<br>`src/tools/observe/htmlRunner.ts`<br>`src/tools/observe/contentRunner.ts` | Read/recall mode selector, not a browser observe mode. |
| `MemorySummarySchema.count` | no | number | - | `src/tools/summaries/scan.ts`<br>`src/tools/summaries/common.ts`<br>`src/tools/summaries/webSecurity/domFlow.ts`<br>`src/tools/summaries/webSecurity/fuzz.ts` | General result count for list/recall style operations. |
| `MemorySummarySchema.superseded` | no | number | - | `src/tools/summaries/memory.ts` | Number of entries superseded by a write/validate flow. |
| `MemorySummarySchema.supersedeCandidates` | no | number | - | `src/tools/summaries/memory.ts` | Candidate count before supersede decision; useful for duplicate diagnostics. |
| `MemorySummarySchema.entryCount` | no | number | - | `src/tools/summaries/memory.ts` | Stored/returned memory entry count. |
| `MemorySummarySchema.error_code` | no | string | - | `src/tools/summaries/hook.ts`<br>`src/tools/summaries/generic.ts`<br>`src/tools/summaries/memory.ts`<br>`src/tools/summaries/evidence.ts` | Structured failure code; keep aligned with memory recovery contract. |
| `MemorySummarySchema.message` | no | string | - | `src/tools/summaries/webSecurity/jsAst.ts`<br>`src/tools/summaries/generic.ts`<br>`src/tools/summaries/memory.ts`<br>`src/tools/observe/baseline.ts` | Short model-facing diagnostic; sensitive evidence remains in artifacts. |
| `MemorySummarySchema.error` | no | string | - | `src/tools/observe/baseline.ts`<br>`src/tools/summaries/memory.ts`<br>`src/tools/summaries/webSecurity/fuzz.ts`<br>`src/tools/summaries/webSecurity/ws.ts` | Compatibility error text for older memory paths. |
| `MemorySummarySchema.recovery` | no | object+ | - | `src/tools/summaries/memory.ts`<br>`src/tools/observe/baseline.ts` | Factual remediation object; keep actionable and non-strategic. |
<!-- END GENERATED: concept-fields-memory-summary-schema -->

### NetworkSummarySchema

<!-- BEGIN GENERATED: concept-fields-network-summary-schema (npm run docs:sync) -->
| Field | Required | Type | Schema description | Producer candidates | Hand notes |
| --- | --- | --- | --- | --- | --- |
| `NetworkSummarySchema.entryCount` | no | number | Total entries captured in this recording | `src/tools/summaries/memory.ts` | Primary count for captured network entries in the current recorder result. |
| `NetworkSummarySchema.total` | no | unknown | - | `src/tools/summaries/hook.ts`<br>`src/tools/summaries/evidence.ts`<br>`src/tools/summaries/network.ts`<br>`src/tools/summaries/webSecurity/jsAst.ts` | Compatibility total; compare with entryCount before changing summary wording. |
| `NetworkSummarySchema.statusCounts` | no | array<object+> | - | `src/tools/summaries/webSecurity/fuzz.ts`<br>`src/tools/summaries/network.ts`<br>`src/tools/summaries/webSecurity/crawl.ts`<br>`src/tools/summaries/webSecurity/recon.ts` | Top status buckets from recorder entries; bounded count array, not a record map. |
| `NetworkSummarySchema.methodCounts` | no | array<object+> | - | `src/tools/summaries/network.ts`<br>`src/tools/summaries/webSecurity/oast.ts` | Top HTTP method buckets; keep small and deterministic. |
| `NetworkSummarySchema.typeCounts` | no | array<object+> | - | `src/tools/summaries/webSecurity/domFlow.ts`<br>`src/tools/summaries/network.ts`<br>`src/tools/summaries/webSecurity/sqli.ts` | Resource type buckets from native network events. |
| `NetworkSummarySchema.hostCounts` | no | array<object+> | - | `src/tools/summaries/webSecurity/fuzz.ts`<br>`src/tools/summaries/network.ts`<br>`src/tools/summaries/webSecurity/bridges.ts`<br>`src/tools/summaries/webSecurity/crawl.ts` | Host buckets; avoid leaking full sensitive URLs in this summary column. |
| `NetworkSummarySchema.failed` | no | object+ | - | `src/tools/summaries/network.ts` | Compact table of failed requests; full request/response evidence belongs in artifacts. |
| `NetworkSummarySchema.samples` | no | object+ | - | `src/tools/summaries/network.ts`<br>`src/tools/summaries/hook.ts` | Representative rows for triage; bounded table shape may evolve with recorder fields. |
| `NetworkSummarySchema.tabId` | no | unknown | - | `src/tools/observe/scanRunner.ts`<br>`src/tools/observe/contentRunner.ts`<br>`src/tools/observe/htmlRunner.ts`<br>`src/tools/summaries/network.ts` | Target tab metadata from native/network command context. |
| `NetworkSummarySchema.sessionId` | no | unknown | - | `src/tools/summaries/network.ts`<br>`src/tools/summaries/webSecurity/oast.ts`<br>`src/tools/summaries/webSecurity/ws.ts`<br>`src/tools/summaries/hook.ts` | Recorder session correlation handle for follow-up list/get/body calls. |
| `NetworkSummarySchema.active` | no | unknown | - | `src/tools/observe/scanRunner.ts`<br>`src/tools/summaries/network.ts`<br>`src/tools/summaries/webSecurity/ws.ts` | Recorder lifecycle state; keep as diagnostic, not success proof. |
<!-- END GENERATED: concept-fields-network-summary-schema -->

### ScanSummarySchema

<!-- BEGIN GENERATED: concept-fields-scan-summary-schema (npm run docs:sync) -->
| Field | Required | Type | Schema description | Producer candidates | Hand notes |
| --- | --- | --- | --- | --- | --- |
| `ScanSummarySchema.summaryVersion` | yes | number | - | `src/tools/summaries/scan.ts` | Version of scan summary contract; bump only with explicit migration. |
| `ScanSummarySchema.url` | no | unknown | - | `src/tools/observe/scanRunner.ts`<br>`src/tools/observe/memoryAugmentation.ts`<br>`src/tools/summaries/network.ts`<br>`src/tools/summaries/webSecurity/crawl.ts` | Observed page URL after navigation/cache handling. |
| `ScanSummarySchema.title` | no | unknown | - | `src/tools/summaries/webSecurity/fuzz.ts`<br>`src/tools/observe/memoryAugmentation.ts`<br>`src/tools/summaries/scan.ts`<br>`src/tools/observe/renderCache.ts` | Observed document title; not a stable identity key. |
| `ScanSummarySchema.readyState` | no | unknown | - | `src/tools/observe/renderCache.ts`<br>`src/tools/summaries/scan.ts` | DOM readiness signal from page-world scan. |
| `ScanSummarySchema.text_only` | no | unknown | - | `src/tools/summaries/scan.ts` | Compatibility flag for text-oriented scans. |
| `ScanSummarySchema.contentChars` | yes | number | - | `src/tools/summaries/scan.ts` | Top-level content length for quick budget diagnostics. |
| `ScanSummarySchema.lineCount` | yes | number | - | `src/tools/summaries/scan.ts`<br>`src/tools/summaries/webSecurity/bridges.ts` | Top-level visible text line count. |
| `ScanSummarySchema.truncated` | no | unknown | - | `src/tools/summaries/webSecurity/jsAst.ts`<br>`src/tools/summaries/scan.ts`<br>`src/tools/summaries/webSecurity/replay.ts`<br>`src/tools/summaries/common.ts` | Signals capped page text/structure; use artifact_hints for full reads. |
| `ScanSummarySchema.node_count` | no | unknown | - | `src/tools/summaries/scan.ts` | Approximate scanned DOM node count from page-world extraction. |
| `ScanSummarySchema.iframe_notes` | no | unknown | - | `src/tools/summaries/scan.ts` | Frame visibility/access notes; detailed frame work belongs in browser_frame. |
| `ScanSummarySchema.top_layer` | no | unknown | - | `src/tools/summaries/scan.ts` | Top-layer/dialog hint from scan extraction. |
| `ScanSummarySchema.tabs_count` | yes | number | - | `src/tools/observe/scanRunner.ts`<br>`src/tools/summaries/scan.ts` | Bridge tab count mirrored into scan summary for context. |
| `ScanSummarySchema.page` | yes | object+ | - | `src/tools/summaries/scan.ts` | Nested page metrics; keep consistent with top-level count fields. |
| `ScanSummarySchema.focus` | yes | object+ | - | `src/tools/observe/baseline.ts`<br>`src/tools/observe/scanRunner.ts`<br>`src/tools/summaries/scan.ts` | Primary action/entity and ABML-derived focus block. |
| `ScanSummarySchema.artifact_hints` | yes | object+ | - | `src/tools/summaries/common.ts`<br>`src/tools/summaries/scan.ts` | Preferred local artifact reads; never require opening raw artifact blindly. |
| `ScanSummarySchema.list_hints` | yes | object+ | - | `src/tools/summaries/scan.ts` | Table of repeated/list-like structures for agent scanning. |
| `ScanSummarySchema.media_candidates` | no | object+ | - | `src/tools/summaries/scan.ts` | Visible media candidates; bounded table, optional on sparse pages. |
| `ScanSummarySchema.rows` | no | object+ | - | `src/tools/summaries/scan.ts`<br>`src/tools/summaries/common.ts` | DOM-ordered visible rows; preserve sibling order semantics. |
| `ScanSummarySchema.actionables` | yes | object+ | - | `src/tools/summaries/scan.ts` | Primary actionable table; refs and jsonPaths must stay stable enough for follow-up. |
| `ScanSummarySchema.interactive` | yes | array<string> | - | `src/tools/summaries/scan.ts` | Compact interactive text/ref list for quick triage. |
| `ScanSummarySchema.headings` | yes | array<string> | - | `src/tools/summaries/scan.ts`<br>`src/tools/summaries/content.ts` | Visible heading list for orientation. |
| `ScanSummarySchema.textPreview` | yes | string | - | `src/tools/summaries/scan.ts`<br>`src/tools/summaries/content.ts`<br>`src/tools/summaries/html.ts` | Budgeted text preview; not the full page body. |
| `ScanSummarySchema.summaryOmitted` | no | array<string> | - | `src/tools/summaries/scan.ts` | Budget omission disclosure; update when renderer hides new classes of data. |
<!-- END GENERATED: concept-fields-scan-summary-schema -->
