# Security Policy

This project operates browser sessions and can process cookies, tokens, HTTP
traffic, local files selected for upload, and local-only artifacts.

## Reporting

- Use GitHub private vulnerability reporting when it is available for the
  published repository.
- If private reporting is unavailable, open a minimal public issue that asks for
  a maintainer contact path. Do not include exploit details, cookies, tokens,
  private URLs, HAR files, screenshots with secrets, or raw artifacts in a public
  issue.
- Include the affected commit, operating system, Node version, browser, extension
  version, reproduction steps, expected behavior, actual behavior, and the
  smallest redacted evidence that demonstrates impact.

## Handling Rules

- Do not upload `.browser-pilot/artifacts/`, cookies,
  authorization headers, access tokens, private keys, or site-specific
  credential material.
- Prefer local fixtures or redacted artifacts when reporting behavior.
- For suspected credential exposure in this repository, include the exact file
  path and line, but redact the value itself.

## Maintainer Triage

Security reports should be verified against the current worktree before a fix is
accepted. Accepted fixes should include focused regression coverage and the
narrowest relevant verification for the changed surface.
