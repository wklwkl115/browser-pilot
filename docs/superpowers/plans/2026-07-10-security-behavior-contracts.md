# Security And Behavior Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Browser Pilot's high privileges, local trust boundaries, page side effects, artifact access, and redaction limits explicit and mechanically synchronized with source.

**Architecture:** Keep operator-facing threat boundaries in `SECURITY.md` and contributor/runtime ownership in `CODE_WIKI.md`. Add governance tests that read implementation owners, tighten WebSocket origins to the manifest-key-derived extension ID, and preserve explicit development overrides without weakening production defaults.

**Tech Stack:** Markdown owner docs, TypeScript bridge policy, MV3 manifest, Node governance tests, existing bridge config synchronization.

---

### Task 1: Lock The Security Contract To Implementation Owners

**Files:**
- Create: `tests/governance/securityContract.test.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write failing owner-correlation tests**

```ts
test("security policy names every high-privilege manifest capability", () => {
	const manifest = JSON.parse(read("src/bridge/extension/static/manifest.json"));
	const security = read("SECURITY.md");
	for (const permission of ["debugger", "cookies", "management", "contentSettings", "downloads", "scripting"]) {
		assert.ok(manifest.permissions.includes(permission));
		assert.match(security, new RegExp(`\\b${permission}\\b`, "i"));
	}
	assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
	assert.match(security, /<all_urls>/);
	const mainWorld = manifest.content_scripts.find((script: Record<string, unknown>) => script.world === "MAIN") as Record<string, unknown>;
	assert.deepEqual(mainWorld.matches, ["<all_urls>"]);
	assert.equal(mainWorld.run_at, "document_start");
	assert.deepEqual(mainWorld.js, ["dist/disable_dialogs.js"]);
});

test("behavior contract names observe scroll and dialog suppression owners", () => {
	const scan = read("src/scan/buildScanScript.ts");
	assert.match(scan, /setScrollTop\(candidate\.scrollPort, candidate\.metrics\.scrollTop\)/);
	assert.match(scan, /restoredScrollTop/);
	assert.match(read("CODE_WIKI.md"), /growth probe[\s\S]*temporary scroll|临时滚动/i);
	assert.match(read("CODE_WIKI.md"), /disable_dialogs[\s\S]*alert[\s\S]*confirm[\s\S]*prompt/i);
});

test("artifact contract distinguishes relative confinement from absolute authorization", () => {
	assert.match(read("SECURITY.md"), /relative[\s\S]*\.browser-pilot\/artifacts[\s\S]*absolute/i);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/governance/securityContract.test.ts`

Expected: FAIL because current `SECURITY.md` and `CODE_WIKI.md` omit required behavior and threat details.

- [ ] **Step 3: Register the new governance test scope**

Ensure `scripts/run-tests.mjs governance` includes the new `.test.ts` file through directory discovery.
Do not add a one-off runner path.

- [ ] **Step 4: Commit the failing contract lock**

```bash
git add tests/governance/securityContract.test.ts scripts/run-tests.mjs
git commit -m "test: lock security contract to source owners"
```

### Task 2: Derive And Enforce The Fixed Extension Origin

**Files:**
- Create: `src/bridge/server/browserBridgeOriginPolicy.ts`
- Modify: `src/bridge/server/BrowserBridgeHttpServer.ts`
- Modify: `src/bridge/server/browserBridgeConfig.ts`
- Modify: `bridge/browser_bridge_config.json`
- Modify: `scripts/sync-bridge-config.mjs`
- Modify: `tests/bootstrap/bridgeReadiness.test.ts`
- Modify: `tests/governance/securityContract.test.ts`

- [ ] **Step 1: Write failing fixed-origin tests**

```ts
const EXPECTED_ID = "lkfcdgafdedpmnlhlpemgkfbagbmaagg";

test("bridge accepts only the manifest-key-derived extension by default", () => {
	assert.equal(isAllowedBridgeOrigin(`chrome-extension://${EXPECTED_ID}`), true);
	assert.equal(isAllowedBridgeOrigin("chrome-extension://abcdefghijklmnopabcdefghijklmnop"), false);
	assert.equal(isAllowedBridgeOrigin(undefined), false);
	assert.equal(isAllowedBridgeOrigin("null"), false);
});

test("development allowlist is explicit and additive", () => {
	const policy = bridgeOriginPolicy({ expectedExtensionId: EXPECTED_ID, developmentAllowlist: ["abcdefghijklmnopabcdefghijklmnop"] });
	assert.equal(policy.allows("chrome-extension://abcdefghijklmnopabcdefghijklmnop"), true);
	assert.equal(policy.allows("https://example.test"), false);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/bootstrap/bridgeReadiness.test.ts tests/governance/securityContract.test.ts`

Expected: current arbitrary-extension and originless acceptance fails the new assertions.

- [ ] **Step 3: Add the generated extension ID owner**

Extend `bridge/browser_bridge_config.json` with:

```json
"extensionId": "lkfcdgafdedpmnlhlpemgkfbagbmaagg"
```

`scripts/sync-bridge-config.mjs` verifies that this ID is derived from the SHA-256 digest of the
DER public key in the source manifest, using Chrome's nibble-to-`a` through `p` mapping. It generates
`DEFAULT_BROWSER_PILOT_EXTENSION_ID` in `browserBridgeConfig.ts`; developers do not hand-edit the
generated constant.

- [ ] **Step 4: Implement origin policy and development overrides**

`browserBridgeOriginPolicy()` accepts only the fixed origin by default. Parse
`BROWSER_PILOT_EXTENSION_ID_ALLOWLIST` as comma-separated 32-character IDs and
`BROWSER_PILOT_ALLOW_ORIGINLESS_BRIDGE=1` as an explicit development override. Reject malformed
allowlist entries at server construction with an actionable configuration error.

```ts
export function isAllowedBridgeOrigin(origin: string | undefined, policy = defaultBridgeOriginPolicy()): boolean {
	if (origin === undefined || origin === "null") return policy.allowOriginless;
	try {
		const url = new URL(origin);
		return url.protocol === "chrome-extension:" && policy.extensionIds.has(url.hostname);
	} catch { return false; }
}
```

- [ ] **Step 5: Run protocol, build-config, and origin tests**

Run: `node scripts/sync-bridge-config.mjs --check`

Expected: generated config matches JSON and manifest key.

Run: `node --import tsx --test tests/bootstrap/bridgeReadiness.test.ts tests/governance/securityContract.test.ts`

Expected: fixed ID, malformed IDs, explicit allowlist, originless override, and hostile origins pass.

- [ ] **Step 6: Commit origin hardening**

```bash
git add src/bridge/server/browserBridgeOriginPolicy.ts src/bridge/server/BrowserBridgeHttpServer.ts src/bridge/server/browserBridgeConfig.ts bridge/browser_bridge_config.json scripts/sync-bridge-config.mjs tests/bootstrap/bridgeReadiness.test.ts tests/governance/securityContract.test.ts
git commit -m "fix: restrict bridge to the Browser Pilot extension"
```

### Task 3: Document Page-World Side Effects And Privileges

**Files:**
- Modify: `SECURITY.md`
- Modify: `CODE_WIKI.md`
- Modify: `tests/governance/securityContract.test.ts`

- [ ] **Step 1: Extend failing assertions for exact behavior**

Require operator text to state that dialog suppression changes `confirm()` to true, returns the
provided default from `prompt()`, and renders a temporary page toast. Require the Code Wiki to state
that observe scroll restoration is best-effort and can trigger lazy-load, analytics, and scroll
handlers even when restoration succeeds.

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/governance/securityContract.test.ts`

Expected: exact behavioral claims are absent.

- [ ] **Step 3: Update canonical owners without duplicating implementation rules**

Add a `Local Threat Model` section to `SECURITY.md` covering trusted local user, high-privilege
extension, loopback services, daemon token, pairing/consent, lease, persisted evidence, and page
mutation. Add a `Security And Page Behavior Boundaries` section to `CODE_WIKI.md` with source links
and maintenance gates.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --import tsx --test tests/governance/securityContract.test.ts`

Expected: contract/source correlation passes.

- [ ] **Step 5: Commit page behavior contract**

```bash
git add SECURITY.md CODE_WIKI.md tests/governance/securityContract.test.ts
git commit -m "docs: define extension page side effects"
```

### Task 4: Document Artifact, Redaction, And Ephemeral Handle Boundaries

**Files:**
- Modify: `SECURITY.md`
- Modify: `CODE_WIKI.md`
- Modify: `src/artifacts/artifactPrivacy.ts`
- Modify: `src/commands/evidence/artifactCommand.ts`
- Modify: `tests/artifacts/artifactReader.test.ts`
- Modify: `tests/governance/securityContract.test.ts`

- [ ] **Step 1: Write failing user-visible metadata tests**

Require artifact privacy metadata and command guidance to state `absolutePathAccess:"explicit"`,
`relativeRoot:".browser-pilot/artifacts"`, and `persistedMayContainSensitiveEvidence:true` without
echoing the absolute path contents.

```ts
assert.deepEqual(browserArtifactPrivacyMetadata().pathPolicy, {
	relativeRoot: ".browser-pilot/artifacts",
	absolutePathAccess: "explicit",
});
assert.equal(browserArtifactPrivacyMetadata().persistedMayContainSensitiveEvidence, true);
```

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/artifacts/artifactReader.test.ts tests/governance/securityContract.test.ts`

Expected: metadata and documentation assertions fail.

- [ ] **Step 3: Add bounded policy metadata and accurate documentation**

Keep path behavior unchanged: an absolute path is itself the explicit authorization. Clarify that
default text/search reads redact model-facing output, targeted JSON pointers may return requested raw
values, and locally persisted artifacts can contain secrets. Document process-local one-hour
`browser-result://` and `bp-ref://` handle expiry separately from artifact lifetime.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --import tsx --test tests/artifacts/artifactReader.test.ts tests/governance/securityContract.test.ts`

Expected: path behavior, metadata, and owner docs agree.

- [ ] **Step 5: Commit artifact security contract**

```bash
git add SECURITY.md CODE_WIKI.md src/artifacts/artifactPrivacy.ts src/commands/evidence/artifactCommand.ts tests/artifacts/artifactReader.test.ts tests/governance/securityContract.test.ts
git commit -m "docs: define artifact trust boundaries"
```

### Task 5: Verify Governance And Real Extension Compatibility

**Files:**
- Modify: `REPO_GOVERNANCE.md`
- Modify: `tests/governance/workflow.test.ts`

- [ ] **Step 1: Write failing governance gate assertion**

Require changes to manifest permissions, origin policy, page-world scripts, artifact path policy,
or security contract to run `mise run dev-governance` plus their focused runtime tests.

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/run-tests.mjs governance`

Expected: contributor workflow does not yet name the combined gate.

- [ ] **Step 3: Update governance routing**

Add one concise security-sensitive change rule pointing to canonical tests and `mise` gates. Do not
copy the threat model into governance.

- [ ] **Step 4: Verify Stage 5**

Run: `mise run dev-governance`

Expected: exit code 0.

Run: `npm run audit:architecture`

Expected: exit code 0.

Run: `mise run affected`

Expected: exit code 0.

Run: `mise run browser-smoke -- --browser chrome --json`

Expected: real extension connects under the fixed origin policy and the smoke passes.

Run: `mise run browser-smoke -- --browser edge --json`

Expected: real extension connects under the fixed origin policy and the smoke passes.

- [ ] **Step 5: Commit Stage 5**

```bash
git add REPO_GOVERNANCE.md tests/governance/workflow.test.ts
git commit -m "docs: route security-sensitive validation"
```
