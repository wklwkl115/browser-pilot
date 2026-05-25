# Browser Workflow Eval Plan

## 01 readable content artifact

- Goal: extract readable article content from a local fixture and preserve an artifact path.
- Starting tools: `browser_tabs`, `browser_content`, `browser_artifact`.
- Success: summary contains article title/body signal and an artifact path readable through `browser_artifact`.
- Recovery: if readable extraction is poor, use `browser_html` with a selector.

## 02 scan execute wait

- Goal: inspect a page, identify an actionable element, run a JavaScript action, and wait for visible state.
- Starting tools: `browser_scan`, `browser_execute`, `browser_wait`.
- Success: state change is verified through scan/html, not assumed from execute success.
- Recovery: if scan is ambiguous, use `browser_pick` only when user interaction is acceptable.

## 03 network capture replay

- Goal: capture one request and replay it with a narrow header/body mutation.
- Starting tools: `browser_network`, `browser_execute`, `browser_http_replay`, `browser_artifact`.
- Success: replay response delta is preserved in summary or artifact.
- Recovery: if captured request lacks body, inspect `browser_network body` or HAR artifact.

## 04 selector missing recovery

- Goal: trigger a selector miss and recover using page evidence.
- Starting tools: `browser_wait`, `browser_html`, `browser_scan`.
- Success: final selector/action is based on recovered DOM evidence.
- Recovery: use text/html snapshot before trying another wait.

## 05 download artifact

- Goal: download a local fixture file and inspect resulting artifact metadata.
- Starting tools: `browser_download`, `browser_artifact`.
- Success: completed download path/state and file metadata are reported.
- Recovery: if selector click is ambiguous, use direct URL download.

## 06 wait timeout diagnostics

- Goal: trigger a bounded wait timeout and verify diagnostics are actionable.
- Starting tools: `browser_wait`, `browser_evidence`, `browser_html`.
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
