# Auth, Session, Cookie, and JWT

## Trigger

Use when the task involves cookies, JWT/JWE/PASETO/session values, role or claim changes, weak secrets, Rails sessions, auth bypass, IDOR with authenticated requests, replaying old tokens, or comparing authenticated vs unauthenticated behavior.

## Inputs

- Browser tab/URL for cookie collection, or explicit Cookie/Set-Cookie/JWT/session values.
- Target request for claim replay or auth comparison.
- Allowed mutations: role, user id, tenant id, balance, feature flags, expiry, or auth removal.

## Route

1. If values are in the browser, `browser_tabs list` -> keep `tabId` -> call `browser_cookie_analyze` with `bindBrowserSession:true` and target `url`.
2. If values are provided, pass `cookie`, `cookies`, `jwt`, `jwts`, or `values` directly to `browser_cookie_analyze`.
3. For candidate HMAC/secret checks, pass bounded `secretCandidates`, `wordlist`, or `wordlistPath` with `maxSecretCandidates`.
4. For claim mutation, pass `claimMutations` and a bounded `claimReplay` only when a replay target is explicit.
5. For endpoint authorization checks, use request capture and replay:
   - capture normal authenticated request
   - replay baseline
   - replay with auth removed or claims changed
   - compare status/body/redirect/data ownership
6. Read artifacts with `browser_artifact`; extract decoded claims, verification result, generated token metadata, replay delta.

## Evidence

- Token/cookie type and decoded non-sensitive claim names.
- Signature/encryption verification result and tested secret count, not the secret dump.
- Mutation performed and replay response delta.
- Request URL/method and auth state.
- Artifact path.

## Pivot

- JWT/JWE exposes public key, JWKS, JKU, KID, alg, weak secret, or unsigned behavior -> use focused mutation/replay.
- Cookie controls request authorization -> replay affected endpoint with original and mutated/removed cookie.
- Role/user/tenant ID appears in request body or URL, not token -> request capture and replay playbook, then `browser_fuzz_params` if needed.
- Session value leads to SQL-like backend behavior -> SQLi verification playbook.

## Stop

Do not report auth/session weakness when:
- decoded claims are readable but signed/encrypted correctly and no replay change is shown;
- mutation token is generated but not accepted by the server;
- response delta is only login redirect/CSRF expiry/cache noise;
- testing requires another user's data without explicit authorization.
