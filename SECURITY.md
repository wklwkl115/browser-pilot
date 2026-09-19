# Security policy

Browser Pilot handles authenticated browser sessions, page content and network evidence. Please report security problems carefully so private data is not exposed.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting flow for this repository. Include:

- the affected version, commit or installation method;
- the smallest reproducible steps;
- the impact and any required browser or operating-system conditions;
- a redacted log or proof of concept.

Do not include passwords, pairing secrets, session cookies, private URLs, raw page captures or unredacted network responses in a public issue, pull request or discussion. If private reporting is unavailable, open a minimal public issue asking for a private contact path and do not disclose the vulnerability details.

Please do not use a public issue to report a suspected credential leak. Rotate the credential through the owning service first, then report the exposure privately.

## Scope

Reports about the MCP server, local daemon, extension bridge, command validation, browser attachment, evidence handling and release artifacts are in scope. A website's own security bug, a third-party dependency's upstream vulnerability or a page-specific selector failure should be reported to the responsible project unless Browser Pilot adds a distinct security impact.

The repository does not promise a response time or a bounty. We will keep the report private while it is being investigated and will credit reporters when they request it and disclosure is safe.
