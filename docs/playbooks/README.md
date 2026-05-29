# Browser Security Playbooks

Use these playbooks when a browser task needs multi-step testing, evidence correlation, false-positive checks, or a reportable finding. Keep `SKILL.md` short; load only the playbook that matches the task.

## Route index

| Task | Load |
|---|---|
| Unknown live browser target, vague web task, first pass | `docs/playbooks/first-pass-browser-triage.md` |
| Status/header/title/path/API discovery | `docs/playbooks/recon-and-discovery.md` |
| Capturing, replaying, mutating, or comparing HTTP requests | `docs/playbooks/request-capture-and-replay.md` |
| SQL injection validation | `docs/playbooks/sqli-verification.md` |
| JWT, Cookie, JWE, PASETO, Rails session analysis | `docs/playbooks/auth-session-jwt.md` |
| SSRF, blind injection, webhook/callback proof | `docs/playbooks/ssrf-oast.md` |
| Evidence packaging, finding write-up, final report | `docs/playbooks/evidence-and-reporting.md` |

## Base loop

```text
scope -> tabId -> baseline -> focused route -> evidence artifact -> replay/verify -> finding or stop
```

## Rules

- Start tab-scoped browser work with `browser_tabs action=list`; pass explicit `tabId` after selection.
- Prefer typed route tools over hand-written page JavaScript for replay, crawl, fuzz, SQLi, cookie/session, OAST, and template checks.
- Keep every expansive step bounded: scope, paths, words, params, max cases, timeout, rate, and output path.
- Preserve evidence in artifacts; read it back with `browser_artifact` using `jsonPath`, `pick`, offset, or search.
- Stop without a finding when the signal is not reproducible, not scoped, or has no stable response delta/oracle.
