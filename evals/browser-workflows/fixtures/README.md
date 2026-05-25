# Browser Workflow Fixtures

Fixtures in this directory must be local, deterministic, synthetic, and safe to commit.

## Planned fixtures

- `article.html`: article page with title, byline, body, navigation noise, and footer noise.
- `interactive.html`: deterministic UI state change for scan/execute/wait and lease-conflict evals.
- `network.html`: page that triggers a same-origin JSON request against a local fixture server.
- `selector-recovery.html`: page with a misleading absent selector and a discoverable correct selector.
- `download.html`: page linking to `files/report.txt`.
- `files/report.txt`: deterministic downloaded text file.
- `wait-timeout.html`: page with one present selector and one absent selector.
- `cookies.json`: synthetic Cookie/Set-Cookie/JWT samples; no production secrets.

## Rules

- Do not require external network access.
- Do not include real tokens, credentials, cookies, or private data.
- Keep payloads small enough for bounded artifact reads.
- SQLi fixtures must be local simulations, not real database exploitation targets.
- OAST/bridge/scanner evals must use bounded local fixtures and explicit scope.
