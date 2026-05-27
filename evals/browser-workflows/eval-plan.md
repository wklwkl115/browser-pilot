# Browser Workflow Eval Plan

## 01 readable content artifact

- Goal: extract readable article content from a local fixture and preserve an artifact path.
- Starting tools: `browser_tabs`, `browser_observe mode=content`, `browser_artifact`.
- Success: summary contains article title/body signal and an artifact path readable through `browser_artifact`.
- Recovery: if readable extraction is poor, use `browser_observe mode=html` with a selector.

## 02 scan execute wait

- Goal: inspect a page, identify an actionable element, run a JavaScript action, and wait for visible state.
- Starting tools: `browser_observe mode=scan`, `browser_execute`, `browser_wait`.
- Success: state change is verified through scan/html, not assumed from execute success.
- Recovery: if scan is ambiguous, use `browser_pick` only when user interaction is acceptable.

## 03 network capture replay

- Goal: capture one request and replay it with a narrow header/body mutation.
- Starting tools: `browser_network`, `browser_execute`, `browser_http_replay`, `browser_artifact`.
- Success: replay response delta is preserved in summary or artifact.
- Recovery: if captured request lacks body, inspect `browser_network body` or HAR artifact.

## 04 selector missing recovery

- Goal: trigger a selector miss and recover using page evidence.
- Starting tools: `browser_wait`, `browser_observe mode=html`, `browser_observe mode=scan`.
- Success: final selector/action is based on recovered DOM evidence.
- Recovery: use text/html snapshot before trying another wait.

## 05 download artifact

- Goal: download a local fixture file and inspect resulting artifact metadata.
- Starting tools: `browser_download`, `browser_artifact`.
- Success: completed download path/state and file metadata are reported.
- Recovery: if selector click is ambiguous, use direct URL download.

## 06 wait timeout diagnostics

- Goal: trigger a bounded wait timeout and verify diagnostics are actionable.
- Starting tools: `browser_wait`, `browser_evidence`, `browser_observe mode=html`.
- Success: output includes timeout/target/next action evidence.
- Recovery: use diagnose/html before retrying broader waits.

## 07 bounded path fuzz baseline

- Goal: run bounded path fuzzing against a local fixture and explain baseline filtering.
- Starting tools: `browser_recon_probe`, `browser_fuzz_paths`, `browser_artifact`.
- Success: fuzz scope is explicit, candidate count bounded, and baseline evidence is cited.
- Recovery: reduce candidates or add filterBaseline/matchStatus controls.

## 08 cookie jwt redaction

- Goal: analyze a JWT/cookie fixture and produce a redacted summary.
- Starting tools: `browser_cookie_analyze`, `browser_artifact`.
- Success: decoded metadata is useful while secrets remain redacted.
- Recovery: add bounded secret candidates only for fixture-provided values.

## 09 sqli probe vs bridge

- Goal: compare SQLi oracle probing with sqlmap bridge roles on a fixture request.
- Starting tools: `browser_http_replay`, `browser_sqli_probe`, `browser_sqlmap_bridge`.
- Success: probe is used for oracle evidence; sqlmap bridge is used only for deeper explicit automation.
- Recovery: replay raw request first if target/request template is ambiguous.

## 10 multi-session lease conflict

- Goal: create or simulate a lease conflict and recover with explicit session/tab handling.
- Starting tools: `browser_tabs`, `browser_execute`, `browser_evidence`.
- Success: conflict is detected, target session/tab is explicit, and retry is bounded.
- Recovery: release lease or select/attach the intended tab before writing.

## 11 jshook runtime hook targets

- Goal: observe deterministic runtime sink calls and decide whether explicit `browser_hook` use is enough or bounded static hook targets are needed.
- Starting tools: `browser_tabs`, `browser_hook`, `browser_execute`, `browser_evidence`, `browser_artifact`.
- Success: hook event classes, cleanup diagnostics, and artifact paths are sufficient without strategy presets.
- Recovery: narrow hook target list, keep redaction enabled, and reinstall explicitly after cleanup.

## 12 jshook source map artifact

- Goal: discover a synthetic source map and inspect original-source evidence through crawl artifacts.
- Starting tools: `browser_tabs`, `browser_crawl`, `browser_artifact`, `browser_execute`.
- Success: source-map discovery and original source metadata are artifact-first; no `browser_sources` tool is needed.
- Recovery: inspect script artifact and resolve relative map paths under same-origin scope.

## 13 jshook storage evidence

- Goal: read deterministic local/session/IndexedDB evidence using focused JS and optional storage API hook events.
- Starting tools: `browser_tabs`, `browser_execute`, `browser_hook`, `browser_evidence`, `browser_artifact`.
- Success: storage keys/stores are bounded, redacted, and separated from event evidence.
- Recovery: narrow database/store/key filters and keep token-like fixture values redacted.

## 14 jshook replay not intercept

- Goal: validate passive capture plus request replay for mutation/delta tasks instead of live interception.
- Starting tools: `browser_tabs`, `browser_network`, `browser_execute`, `browser_http_replay`, `browser_artifact`.
- Success: replay request derives from captured evidence and reports one narrow mutation delta.
- Recovery: filter recorder entries, inspect body/HAR artifacts, then replay captured request.

## 15 jshook canvas observation

- Goal: inspect deterministic canvas evidence with screenshot/focused JS/hook primitives without canvas-specific strategy tooling.
- Starting tools: `browser_tabs`, `browser_screenshot`, `browser_execute`, `browser_hook`, `browser_evidence`, `browser_artifact`.
- Success: canvas dimensions, scene metadata, and visual/artifact evidence are sufficient without solver semantics.
- Recovery: use focused JS metadata reads and bounded image/pixel evidence when screenshot alone is insufficient.

## 16 scan high entropy summary

- Goal: verify `browser_observe mode=scan` summary exposes high-signal primary_actions, forms, lists, text_signals, and artifact_hints without a blind artifact read.
- Starting tools: `browser_tabs`, `browser_observe mode=scan`, `browser_artifact`, `browser_execute`, `browser_wait`.
- Success: the agent can choose grounded actions from compact summary evidence and only uses targeted artifact jsonPath reads when needed.
- Recovery: use `artifact_hints` jsonPath reads before broad artifact text reads.

## 17 debugger evidence workflow

- Goal: determine whether existing canonical tools can capture meaningful debugger-like evidence before any new public capability is proposed.
- Starting tools: `browser_tabs`, `browser_observe mode=scan`, `browser_execute`, `browser_frame`, `browser_artifact`.
- Success: one-shot CDP evidence and lifecycle gaps are explicitly separated, and unresolved gaps are recorded as RFC-only instead of triggering a new public tool.
- Recovery: if bounded CDP evidence is insufficient, record the insufficiency as RFC-only evidence and stop; do not widen the tool surface.

## 18 debugger script provenance

- Goal: determine whether existing tools can recover authored script provenance and distinguish it from thrown eval source evidence.
- Starting tools: `browser_tabs`, `browser_observe mode=scan`, `browser_execute`, `browser_crawl`, `browser_artifact`.
- Success: the result captures some script-provenance evidence and clearly states whether authored script correlation remains RFC-only.
- Recovery: collect bounded artifact evidence, then classify unresolved provenance gaps as RFC-only.

## 19 debugger pause lifecycle

- Goal: determine whether pause/resume cleanup risk can be measured with current tools before any lifecycle enhancement is proposed.
- Starting tools: `browser_tabs`, `browser_observe mode=scan`, `browser_execute`, `browser_wait`, `browser_artifact`.
- Success: pause/resume cleanup behavior and stale-state risk are independently observed and classified.
- Recovery: detach/cleanup, re-observe state, and record insufficiency as RFC-only instead of widening the tool surface.

## 20 debugger navigation recovery

- Goal: determine whether debugger-like evidence collection recovers cleanly across navigation or reload.
- Starting tools: `browser_tabs`, `browser_observe mode=scan`, `browser_execute`, `browser_wait`, `browser_artifact`.
- Success: before/after state and stale-state diagnostics show whether navigation recovery remains RFC-only.
- Recovery: re-open or re-observe the tab and record the insufficiency as RFC-only if lifecycle recovery is not clean.
