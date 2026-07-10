# Real Browser Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic real Chrome/Edge smoke that proves daemon startup, extension handshake, tabs, execute, observe, ACK, and service-worker restart recovery.

**Architecture:** Build a dependency-injected orchestration library under `scripts/browser-smoke/` and keep the CLI entry in `scripts/run-browser-smoke.mjs`. Unit tests cover discovery, arguments, report redaction, timeouts, and cleanup; the live driver uses an isolated browser profile, daemon state, bridge range, and local HTTP fixture.

**Tech Stack:** Node.js 22 ESM, `node:child_process`, `node:http`, Chrome/Edge command-line flags, existing daemon control APIs, Node test runner.

---

### Task 1: Browser Discovery And Launch Contract

**Files:**
- Create: `scripts/browser-smoke/browserDiscovery.mjs`
- Create: `scripts/browser-smoke/browserProcess.mjs`
- Test: `tests/cli/browserSmokeHarness.test.ts`

- [ ] **Step 1: Write the failing discovery tests**

Add tests that inject `platform`, `env`, and `exists` instead of reading the developer machine directly:

```ts
test("browser smoke prefers an explicit executable", () => {
	const result = resolveBrowserExecutable({
		platform: "win32",
		env: { BROWSER_PILOT_SMOKE_BROWSER: "D:\\Browser\\chrome.exe" },
		exists: (candidate) => candidate === "D:\\Browser\\chrome.exe",
	});
	assert.deepEqual(result, { family: "custom", executable: "D:\\Browser\\chrome.exe", source: "env" });
});

test("browser smoke discovers Edge after Chrome when family=edge", () => {
	const result = resolveBrowserExecutable({ platform: "win32", family: "edge", env: {}, exists: (candidate) => candidate.endsWith("msedge.exe") });
	assert.equal(result.family, "edge");
	assert.match(result.executable, /msedge\.exe$/);
});

test("browser smoke launch arguments isolate profile and extension", () => {
	const args = browserLaunchArgs({ profileDir: "C:\\tmp\\profile", extensionDir: "C:\\repo\\bridge", fixtureUrl: "http://127.0.0.1:41000/" });
	assert.ok(args.includes("--user-data-dir=C:\\tmp\\profile"));
	assert.ok(args.includes("--disable-extensions-except=C:\\repo\\bridge"));
	assert.ok(args.includes("--load-extension=C:\\repo\\bridge"));
	assert.equal(args.at(-1), "http://127.0.0.1:41000/");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --import tsx --test tests/cli/browserSmokeHarness.test.ts`

Expected: FAIL because `scripts/browser-smoke/browserDiscovery.mjs` and exported helpers do not exist.

- [ ] **Step 3: Implement discovery and launch arguments**

Implement these exact exports:

```js
export function resolveBrowserExecutable({ platform = process.platform, family, env = process.env, exists }) {
	const explicit = env.BROWSER_PILOT_SMOKE_BROWSER;
	if (explicit) {
		if (!exists(explicit)) throw new Error(`Configured smoke browser does not exist: ${explicit}`);
		return { family: "custom", executable: explicit, source: "env" };
	}
	const candidates = browserCandidates(platform).filter((item) => !family || item.family === family);
	const found = candidates.find((item) => exists(item.executable));
	if (!found) throw new Error(`No supported ${family || "Chrome/Edge"} browser executable was found`);
	return { ...found, source: "discovery" };
}

export function browserLaunchArgs({ profileDir, extensionDir, fixtureUrl }) {
	return [
		`--user-data-dir=${profileDir}`,
		`--disable-extensions-except=${extensionDir}`,
		`--load-extension=${extensionDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
		fixtureUrl,
	];
}
```

`browserProcess.mjs` exports `startBrowser()` and `stopBrowser()`. `startBrowser()` calls
`spawn(executable, browserLaunchArgs(options), { stdio: ["ignore", log, log] })` and returns the
owned child plus its log path. `stopBrowser()` first calls `child.kill()`, waits at most five
seconds for `exit`, then force-terminates only that owned process tree and rejects if it remains
alive.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --import tsx --test tests/cli/browserSmokeHarness.test.ts`

Expected: all discovery and argument tests pass with no browser process started.

- [ ] **Step 5: Commit the harness contract**

```bash
git add scripts/browser-smoke/browserDiscovery.mjs scripts/browser-smoke/browserProcess.mjs tests/cli/browserSmokeHarness.test.ts
git commit -m "test: define real browser smoke harness"
```

### Task 2: Local Fixture And Redacted Report

**Files:**
- Create: `scripts/browser-smoke/fixtureServer.mjs`
- Create: `scripts/browser-smoke/smokeReport.mjs`
- Modify: `tests/cli/browserSmokeHarness.test.ts`

- [ ] **Step 1: Write failing fixture and redaction tests**

```ts
test("fixture exposes deterministic mutation and lazy-scroll signals", async () => {
	const fixture = await startFixtureServer();
	try {
		const html = await fetch(fixture.url).then((response) => response.text());
		assert.match(html, /id="bp-smoke-marker"/);
		assert.match(html, /globalThis\.browserPilotSmokeMutate/);
		assert.match(html, /id="bp-smoke-scroll"/);
	} finally { await fixture.close(); }
});

test("smoke report removes tokens and cookie values", () => {
	const report = sanitizeSmokeReport({ token: "daemon-secret", headers: { cookie: "sid=secret" }, phase: "execute" });
	assert.equal(JSON.stringify(report).includes("daemon-secret"), false);
	assert.equal(JSON.stringify(report).includes("sid=secret"), false);
	assert.equal(report.phase, "execute");
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/cli/browserSmokeHarness.test.ts`

Expected: FAIL because the fixture and report modules are missing.

- [ ] **Step 3: Implement the fixture and report owners**

`startFixtureServer()` binds `127.0.0.1` on port 0 and returns `{ url, close }`. The HTML must define the marker, a button, the scroll region, and this deterministic mutation API:

```html
<script>
globalThis.browserPilotSmokeMutate = () => {
  const marker = document.getElementById("bp-smoke-marker");
  marker.textContent = "browser-pilot smoke mutated";
  marker.dataset.mutated = "true";
  return { text: marker.textContent, mutated: marker.dataset.mutated };
};
</script>
```

`sanitizeSmokeReport()` recursively replaces values for token, authorization, cookie, set-cookie, body, and postData keys with bounded redaction metadata.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --import tsx --test tests/cli/browserSmokeHarness.test.ts`

Expected: fixture and redaction tests pass.

- [ ] **Step 5: Commit fixture/report support**

```bash
git add scripts/browser-smoke/fixtureServer.mjs scripts/browser-smoke/smokeReport.mjs tests/cli/browserSmokeHarness.test.ts
git commit -m "test: add deterministic browser smoke fixture"
```

### Task 3: Daemon Invocation And Readiness Driver

**Files:**
- Create: `scripts/browser-smoke/daemonDriver.mjs`
- Modify: `src/apps/daemon/server.ts`
- Modify: `tests/cli/daemonInvoke.test.ts`
- Modify: `tests/cli/browserSmokeHarness.test.ts`

- [ ] **Step 1: Write failing daemon-handle and invoke tests**

Extend the in-process daemon characterization so an isolated daemon exposes enough information to invoke without a lockfile and reports bridge status without leaking its token:

```ts
test("isolated daemon handle can invoke a command without a user lockfile", async () => {
	const handle = await startDaemon({ writeLock: false, startBridgeEagerly: true });
	try {
		assert.equal(typeof handle.controlPort, "number");
		assert.equal(typeof handle.token, "string");
		assert.equal(readLockfile(), undefined);
	} finally { await handle.close(); }
});

test("daemon status exposes restart correlation without exposing its token", async () => {
	const status = await controlRequest(handle, "GET", "/status");
	assert.equal(status.status, 200);
	const extension = status.json?.extension as Record<string, unknown>;
	const connectionMetrics = status.json?.connectionMetrics as Record<string, unknown>;
	assert.equal(extension.extensionInstanceId, "instance-1");
	assert.equal(extension.workerBootId, "worker-1");
	assert.equal(typeof connectionMetrics.connects, "number");
	assert.equal(JSON.stringify(status.json).includes(handle.token), false);
});
```

Add harness tests for `waitForExtensionReady()` timeout and `invokeDaemonTool()` response parsing with injected `controlRequest`.

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/cli/daemonInvoke.test.ts tests/cli/browserSmokeHarness.test.ts`

Expected: the new smoke driver imports fail and any missing daemon status fields are exposed by assertions.

- [ ] **Step 3: Implement the daemon driver**

Export:

```js
export async function waitForExtensionReady(handle, { timeoutMs, pollMs = 250, request = controlRequest }) {
	const deadline = Date.now() + timeoutMs;
	let status;
	do {
		status = await request(handle, "GET", "/status", undefined, Math.max(1_000, pollMs * 2));
		if (status.status === 200 && status.json?.extensionConnected === true) return status.json;
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	} while (Date.now() < deadline);
	throw new Error(`Extension readiness timed out after ${timeoutMs}ms: ${JSON.stringify(sanitizeSmokeReport(status?.json))}`);
}

export async function invokeDaemonTool(handle, tool, params, cwd, { request = controlRequest } = {}) {
	const response = await request(handle, "POST", "/invoke", { tool, params, cwd });
	return parseToolEnvelope(response, tool);
}

export function parseToolEnvelope(response, phase) {
	if (response.status !== 200 || !response.json) throw new Error(`${phase} returned HTTP ${response.status}`);
	const content = Array.isArray(response.json.content) ? response.json.content : [];
	const text = content.find((item) => item?.type === "text")?.text;
	if (typeof text !== "string") throw new Error(`${phase} returned no text envelope`);
	const envelope = JSON.parse(text);
	if (envelope.ok === false) throw new Error(`${phase} failed: ${String(envelope.error?.message || envelope.error || "unknown error")}`);
	return { response: response.json, envelope };
}
```

Use the existing daemon token only inside requests. Returned smoke step objects contain control host/port and bridge diagnostics but never the token.
Extend `bridgeStatusPayload()` with only the restart-correlation fields already present in
`BrowserBridgeServer.snapshot()`: `extension.extensionInstanceId`, `extension.workerBootId`,
`extension.workerStartedAt`, `extension.connectKind`, `connectionMetrics`, and `requestMetrics`.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --import tsx --test tests/cli/daemonInvoke.test.ts tests/cli/browserSmokeHarness.test.ts`

Expected: daemon lifecycle and injected driver tests pass.

- [ ] **Step 5: Commit daemon smoke support**

```bash
git add scripts/browser-smoke/daemonDriver.mjs src/apps/daemon/server.ts tests/cli/daemonInvoke.test.ts tests/cli/browserSmokeHarness.test.ts
git commit -m "test: expose isolated daemon smoke driver"
```

### Task 4: End-To-End Smoke Orchestrator

**Files:**
- Create: `scripts/browser-smoke/runSmoke.mjs`
- Create: `scripts/run-browser-smoke.mjs`
- Create: `tests/integration/browserSmoke.test.ts`
- Modify: `tests/cli/browserSmokeHarness.test.ts`

- [ ] **Step 1: Write failing orchestration-order and cleanup tests**

Inject adapters and assert the order `fixture -> daemon -> browser -> ready -> tabs -> execute -> observe -> reload -> reconnect -> execute -> observe -> cleanup`. Add a failure test that throws during observe and proves browser, daemon, fixture, and temporary directories are still cleaned in reverse order.

```ts
assert.deepEqual(events, [
	"fixture:start", "daemon:start", "browser:start", "extension:ready", "tabs:list",
	"execute:before", "observe:before", "worker:reload", "extension:reconnected",
	"execute:after", "observe:after", "browser:stop", "daemon:stop", "fixture:stop", "temp:remove",
]);
```

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/cli/browserSmokeHarness.test.ts`

Expected: FAIL because `runBrowserSmoke()` is not implemented.

- [ ] **Step 3: Implement the complete smoke flow**

`runBrowserSmoke(options, adapters)` performs the approved ten-step flow. It captures the pre-reload `extensionInstanceId`, `workerBootId`, target reference, and connection metrics. The post-reload predicate requires:

```js
const recovered = after.extension?.extensionInstanceId === before.extension?.extensionInstanceId
	&& after.extension?.workerBootId !== before.extension?.workerBootId
	&& Number(after.connectionMetrics?.swRestarts || 0) > Number(before.connectionMetrics?.swRestarts || 0);
```

The execute step requires either `diagnostics.latency.acked === true` or the raw bridge result's `acknowledged === true`. The canonical observe step rejects any explicit `mode` argument and asserts `model:"PageObservation"` plus the fixture marker.

`scripts/run-browser-smoke.mjs` parses `--browser chrome|edge`, `--browser-path`, `--timeout-ms`, and `--json`, prints one sanitized final report, and exits nonzero on any failed phase.
The report includes `requiredPhases:["handshake","tabs","execute","observe","reload","reconnect","post-restart"]`;
the handshake phase requires `extensionConnected:true`, non-empty instance/worker IDs, and at least
one recorded handshake/connect metric.

Build the Extension first through `node scripts/build-bridge.mjs --quiet`; use the resulting
`bridge/browser_pilot_bridge/` directory as a read-only launch artifact. Trigger the worker restart
through `invokeDaemonTool(handle, "browser_command", { command: { cmd:"management", method:"reload" } }, cwd)`;
do not emulate the metrics or mutate the built extension.

- [ ] **Step 4: Run harness tests and a live Chrome smoke**

Run: `node --import tsx --test tests/cli/browserSmokeHarness.test.ts`

Expected: all orchestration and cleanup tests pass.

Add an opt-in live wrapper that never starts a browser during normal deterministic tests:

```ts
test("live browser smoke returns the complete structured report", {
	skip: process.env.BROWSER_PILOT_LIVE_SMOKE !== "1",
}, async () => {
	const report = await runBrowserSmoke({
		family: process.env.BROWSER_PILOT_SMOKE_FAMILY === "edge" ? "edge" : "chrome",
		executable: process.env.BROWSER_PILOT_SMOKE_BROWSER,
	});
	assert.equal(report.ok, true);
	assert.deepEqual(report.requiredPhases, ["handshake", "tabs", "execute", "observe", "reload", "reconnect", "post-restart"]);
});
```

Run: `node scripts/run-browser-smoke.mjs --browser chrome --json`

Expected: final JSON has `ok:true`; handshake, tabs, execute, observe, reload, reconnect, and post-restart steps are all true.

- [ ] **Step 5: Run a live Edge smoke**

Run: `node scripts/run-browser-smoke.mjs --browser edge --json`

Expected: the same structured assertions pass with `browser.family:"edge"`.

- [ ] **Step 6: Commit the live orchestrator**

```bash
git add scripts/browser-smoke/runSmoke.mjs scripts/run-browser-smoke.mjs tests/integration/browserSmoke.test.ts tests/cli/browserSmokeHarness.test.ts
git commit -m "test: add real Chrome and Edge smoke"
```

### Task 5: Canonical Gate And Nightly Workflow

**Files:**
- Modify: `mise.toml`
- Modify: `scripts/run-tests.mjs`
- Create: `scripts/check-markdown-links.mjs`
- Create: `.github/workflows/browser-smoke.yml`
- Modify: `REPO_GOVERNANCE.md`
- Modify: `CODE_WIKI.md`
- Test: `tests/governance/markdownLinks.test.ts`
- Test: `tests/governance/workflow.test.ts`

- [ ] **Step 1: Write failing governance tests**

Assert that `mise.toml` owns a `browser-smoke` task, the nightly workflow has `schedule` and `workflow_dispatch`, PR `verify.yml` does not run live smoke, and canonical docs distinguish deterministic verify from nightly browser validation.
Also require `scripts/run-tests.mjs` to discover `tests/integration/` in the `all` scope; the live
wrapper remains a normal skip unless `BROWSER_PILOT_LIVE_SMOKE=1`.

Add a focused checker test with one valid relative link, one valid `path.md#fragment` link, ignored
HTTP/mail/anchor links, and one missing local target:

```ts
const result = checkMarkdownLinks([fixture("index.md")]);
assert.deepEqual(result.checkedFiles, [fixture("index.md")]);
assert.deepEqual(result.failures, [{ source: fixture("index.md"), target: "missing.md", reason: "missing-target" }]);
```

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/governance/markdownLinks.test.ts tests/governance/workflow.test.ts`

Expected: FAIL because the checker, task, workflow, and canonical documentation are absent.

- [ ] **Step 3: Add the task, workflow, and owner documentation**

Add:

```toml
[tasks.browser-smoke]
description = "Run the opt-in real Chrome/Edge daemon-extension smoke"
run = "node scripts/run-browser-smoke.mjs"
```

Append `"integration"` to `scopeDirs.all` so type/import regressions in the opt-in wrapper are
seen by deterministic tests without launching a browser.

`scripts/check-markdown-links.mjs` exports `extractLocalMarkdownLinks(markdown)` and
`checkMarkdownLinks(files)`, accepts Markdown files as CLI arguments, resolves relative paths from
each source file, strips query/fragment suffixes before `existsSync()`, decodes URI components,
ignores absolute URLs/mail links/in-document anchors, and prints one `source -> target` failure per
missing local target. It exits 0 with `ok: markdown-links files=<n> links=<n>` or exits 1 after all
failures; no link is fetched from the network.

The workflow contains separate Windows Edge and Linux Chrome-for-Testing jobs, builds the extension before smoke, uploads sanitized logs on failure, and treats a missing browser as setup failure. The Linux job runs the non-headless extension process under `xvfb-run -a`; the Windows job starts Edge directly. Neither job reaches an external test page.

- [ ] **Step 4: Verify governance and affected gates**

Run: `mise run dev-governance`

Expected: governance tests pass.

Run: `mise run affected`

Expected: exit code 0.

Run: `node scripts/check-markdown-links.mjs CODE_WIKI.md REPO_GOVERNANCE.md`

Expected: exit code 0 with no broken local links.

- [ ] **Step 5: Commit Stage 1**

```bash
git add mise.toml scripts/run-tests.mjs scripts/check-markdown-links.mjs .github/workflows/browser-smoke.yml REPO_GOVERNANCE.md CODE_WIKI.md tests/governance/markdownLinks.test.ts tests/governance/workflow.test.ts
git commit -m "ci: schedule real browser smoke"
```
