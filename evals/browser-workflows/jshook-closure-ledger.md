# jshookmcp Capability Closure Ledger

This ledger is the TODO 241.2 handoff artifact. It maps each jshookmcp-inspired capability class to a bounded eval and a closure path inside existing Pi browser tool boundaries.

## Closure states

- `existing-tool-eval`: eval should prove current canonical tools are sufficient.
- `hook-enhancement-candidate`: eval may justify bounded `browser_hook` static targets/presets.
- `rejected`: capability is outside browser-pilot or requires separate RFC.
- `rfc-only`: not implemented in TODO 241; future work needs independent RFC and eval evidence.

## Ledger

| Capability class | Eval | Canonical surface | State | Closure requirement |
|---|---|---|---|---|
| Runtime sinks, DOM sinks, storage/websocket/crypto/canvas events | `11-jshook-runtime-hook-targets.md` | `browser_hook`, `browser_evidence`, `browser_artifact` | `hook-enhancement-candidate` | Close as either existing custom hook flow sufficient or bounded static hook targets needed. No strategy presets. |
| Source map, bundle/source artifact discovery | `12-jshook-source-map-artifact.md` | `browser_crawl`, `browser_artifact`, focused `browser_execute` | `existing-tool-eval` | Prove crawl artifacts can surface source-map metadata and original source snippets. Unresolved runtime-only gaps become RFC-only. |
| Browser storage state and events | `13-jshook-storage-evidence.md` | `browser_execute`, `browser_hook`, `browser_evidence`, `browser_artifact` | `existing-tool-eval` | Prove bounded focused JS plus storage hooks can summarize state/events without raw leakage. CRUD public tools require RFC. |
| Request mutation and response deltas | `14-jshook-replay-not-intercept.md` | `browser_network`, `browser_http_replay`, `browser_artifact` | `existing-tool-eval` | Prove passive capture plus replay closes mutation/delta work. Live intercept remains RFC-only. |
| Canvas/WebGL observation | `15-jshook-canvas-observation.md` | `browser_screenshot`, `browser_execute`, `browser_hook`, `browser_evidence`, `browser_artifact` | `existing-tool-eval` | Prove bounded observation works without solver/gameplay/captcha semantics. Repeated primitive gaps become RFC-only. |
| Debugger pause/breakpoint/scope workflow | No TODO 241 implementation eval | `browser_execute` command mode for one-shot CDP only | `rfc-only` | Must not enter TODO 241 code. Requires separate RFC with non-overlap proof against `browser_execute` and cleanup/state diagnostics. |
| Stealth, CAPTCHA, human behavior, macro workflow, LLM deobfuscation, binary/process/memory/frida/adb | No eval | None in this package | `rejected` | Confirm no code/docs/tool contracts import these capabilities into browser-pilot. |

## TODO 241.2 completion checklist

- All five jshook eval specs exist in `manifest.json` and pass `npm run check:eval-workflows`.
- Fixtures are local, deterministic, synthetic, and safe to commit.
- Each jshook spec includes `Capability closure classification` and forbids new public tool creation.
- Manual or future-run result records classify each capability as: existing tools sufficient, hook enhancement needed, rejected, or separate RFC.
- TODO 241.3 may only start when eval records justify bounded `browser_hook` enhancement.
