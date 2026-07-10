# Hotspot And Integration Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove replacement, lease, reconnect, and degraded-observation behavior over the production WebSocket protocol, then split the six largest handwritten runtime hotspots behind compatibility-preserving facades.

**Architecture:** Add a real-protocol integration tier that starts `BrowserBridgeServer` on an isolated fixed port and drives the same `ext_ready`, `tabs_update`, `ack`, `result`, and `error` messages as the Extension. Lock observable behavior before each extraction; keep existing public import paths as small facades or orchestrators while moving replacement, selection, target resolution, scan, collection, program, capture, AX decoding, and merge responsibilities into focused collaborators.

**Tech Stack:** Node.js 22, TypeScript 6 strict ESM, `ws`, Node test runner, production command registration, mise.

---

### Task 1: Real-Protocol Integration Harness And Gate

**Files:**
- Create: `tests/integration/helpers/bridgeProtocolClient.ts`
- Create: `tests/integration/bridgeProtocolHarness.test.ts`
- Modify: `scripts/run-tests.mjs`
- Modify: `mise.toml`

- [ ] **Step 1: Write the failing fixed-port protocol-harness test**

Use an actual HTTP/WebSocket endpoint and the post-Stage-5 fixed Extension origin:

```ts
test("protocol harness drives the production bridge message service", async () => {
	const harness = await startBridgeProtocolHarness();
	try {
		const client = await harness.connectExtension({
			extensionInstanceId: "integration-instance",
			workerBootId: "worker-1",
			durableRequests: true,
			tabs: [{ id: 7, url: "https://fixture.test/", title: "Fixture", active: true }],
		});
		try {
			assert.equal(harness.server.requestedPort, harness.port);
			assert.equal(harness.server.portRangeEnd, harness.port);
			assert.equal(harness.server.port, harness.port);
			assert.equal(harness.server.snapshot().extension?.extensionInstanceId, "integration-instance");
			const request = harness.server.sendCommand({ cmd: "tabs", method: "list" }, { timeoutMs: 1_000 });
			const wire = await client.nextCommand();
			client.sendAck(wire.id);
			client.sendResult(wire.id, [{ id: 7, url: "https://fixture.test/", title: "Fixture", active: true }]);
			assert.equal((await request).acknowledged, true);
		} finally { await client.close(); }
	} finally { await harness.close(); }
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --import tsx --test tests/integration/bridgeProtocolHarness.test.ts`

Expected: FAIL because `tests/integration/helpers/bridgeProtocolClient.ts` does not exist.

- [ ] **Step 3: Implement the actual-socket helper**

Export this surface; do not expose private bridge registries or call message-service methods directly:

```ts
export const TEST_EXTENSION_ID = "lkfcdgafdedpmnlhlpemgkfbagbmaagg";

export type BridgeWireCommand = {
	id: string;
	code: unknown;
	tabId?: number;
	timeoutMs: number;
	redelivered?: boolean;
	priorAck?: boolean;
};

export type ExtensionReadyInput = {
	extensionInstanceId: string;
	workerBootId: string;
	durableRequests: boolean;
	tabs: Array<Record<string, unknown>>;
};

export function tab(id: number, url = `https://fixture.test/tab-${id}`): Record<string, unknown> {
	return { id, url, title: `Fixture ${id}`, active: true, windowId: 1 };
}

export class BridgeProtocolClient {
	readonly socket: WebSocket;
	sendExtReady(input: ExtensionReadyInput): void;
	sendTabsUpdate(tabs: Array<Record<string, unknown>>, replaced?: Array<Record<string, unknown>>): void;
	nextCommand(timeoutMs?: number): Promise<BridgeWireCommand>;
	sendAck(id: string): void;
	sendResult(id: string, result: unknown, diagnostics?: Record<string, unknown>): void;
	sendError(id: string, error: unknown, result?: unknown, diagnostics?: Record<string, unknown>): void;
	close(): Promise<void>;
}

export async function startBridgeProtocolHarness(options?: ConstructorParameters<typeof BrowserBridgeServer>[0]): Promise<{
	port: number;
	server: BrowserBridgeServer;
	connectExtension(input: ExtensionReadyInput): Promise<BridgeProtocolClient>;
	waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
	close(): Promise<void>;
}>;
```

`startBridgeProtocolHarness()` reserves a free `127.0.0.1` port with `node:net`, closes the reservation, constructs `new BrowserBridgeServer({ port, portRangeEnd: port })`, and starts it. `connectExtension()` connects with `Origin: chrome-extension://${TEST_EXTENSION_ID}`, sends a real `ext_ready`, and waits on `server.waitForExtensionReady(undefined, 1_000)`. All waits reject with the last bounded wire messages after one second.

- [ ] **Step 4: Register the integration scope and run GREEN**

Add the named `integration: ["bootstrap", "integration"]` scope to `scopeDirs`; Stage 1 already
placed the directory in `all`. Add:

```toml
[tasks.test-integration]
description = "Run production bridge protocol integration scenarios"
run = "node scripts/run-tests.mjs integration"
```

Run: `mise run test-integration`

Expected: the harness test passes, the server stops, the socket closes, and the process has no open bridge handles.

- [ ] **Step 5: Commit the integration foundation**

```bash
git add tests/integration/helpers/bridgeProtocolClient.ts tests/integration/bridgeProtocolHarness.test.ts scripts/run-tests.mjs mise.toml
git commit -m "test: add real bridge protocol harness"
```

### Task 2: Tab Replacement And Lease Lifecycle Integration

**Files:**
- Create: `tests/integration/bridgeTabReplacementLease.test.ts`
- Modify: `src/kernels/session/SessionKernel.ts`
- Modify: `src/bridge/server/BrowserBridgeSessionState.ts`
- Modify: `src/bridge/server/BrowserBridgeClientHeartbeat.ts`
- Modify: `src/bridge/server/BrowserBridgeServer.ts`
- Modify: `tests/integration/helpers/bridgeProtocolClient.ts`

- [ ] **Step 1: Write the failing replacement, conflict, release, expiry, and cleanup scenarios**

Drive replacement through `tabs_update`, never through `applyTabReplacements()`:

```ts
test("replacement migrates stable target and lease through the real protocol", async () => {
	const harness = await startBridgeProtocolHarness({ tabLeaseTtlMs: 40, heartbeatIntervalMs: 10 });
	try {
		const client = await harness.connectExtension({ tabs: [tab(7)], extensionInstanceId: "replace-instance", workerBootId: "worker-1", durableRequests: true });
		try {
			const stableTarget = harness.server.getTabs()[0]!.targetRef;
			const owner = harness.server.createBrowserSession("owner");
			const contender = harness.server.createBrowserSession("contender");
			harness.server.attachTabToBrowserSession(7, { browserSessionId: owner.id });
			harness.server.attachTabToBrowserSession(7, { browserSessionId: contender.id });
			const lease = harness.server.leaseTab(7, { browserSessionId: owner.id });
			client.sendTabsUpdate([tab(9)], [{ from: 7, to: 9, at: Date.now() }]);
			await harness.waitFor(() => harness.server.getTabs().some((item) => item.tabId === 9));
			assert.equal(harness.server.resolveTargetTabId(stableTarget, owner.id), 9);
			assert.equal(harness.server.resolveTargetTabId(7, owner.id), 9);
			assert.equal(harness.server.snapshot({ browserSessionId: owner.id }).leases?.[0]?.id, lease.id);
			assert.equal(harness.server.snapshot({ browserSessionId: owner.id }).leases?.[0]?.tabId, 9);
			assert.throws(() => harness.server.leaseTab(9, { browserSessionId: contender.id }), (error: Error & { code?: string }) => error.code === "TAB_LEASE_CONFLICT");
			assert.equal(harness.server.releaseTab(9, { browserSessionId: owner.id })?.id, lease.id);
		} finally { await client.close(); }
	} finally { await harness.close(); }
});
```

Add separate tests that lease with a 40 ms TTL and observe an empty `snapshot().leases` after a heartbeat tick, and that close the owning socket and observe immediate disconnect cleanup. Each test uses a fresh server and asserts the contender can acquire only after expiry, explicit release, or disconnect cleanup.

Add a real-protocol chain-failure case that sends four replacements in one `tabs_update`
(`10->11->12->13->14`) while only tab 14 is live. Calling `server.leaseTab(10)` must reject with
`TAB_NOT_FOUND`, `details.replacementChainFailure === "max_hops_exceeded"`,
and `details.replacementHops === 3`. This keeps failure
diagnostics in the actual socket tier rather than proving them only through a helper unit test.

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/integration/bridgeTabReplacementLease.test.ts`

Expected: FAIL because fixed-port harness options cannot inject bounded lease and heartbeat timing.

- [ ] **Step 3: Add production-safe lifecycle timing injection**

Extend constructor options without changing defaults:

```ts
export type SessionKernelOptions<TClient> = {
	isOpenClient?: (client: TClient) => boolean;
	leaseOptions?: ConstructorParameters<typeof SessionLeaseRegistry>[0];
};

export type BrowserBridgeServerOptions = {
	host?: string;
	port?: number;
	portRangeEnd?: number;
	tabLeaseTtlMs?: number;
	uiLockTtlMs?: number;
	heartbeatIntervalMs?: number;
	staleTimeoutMs?: number;
};
```

`SessionKernel` constructs `new SessionLeaseRegistry(options.leaseOptions)`. `BrowserBridgeSessionState` forwards lease options. `BrowserBridgeClientHeartbeat` accepts optional `intervalMs` and `staleTimeoutMs`, uses injected positive values when present, and otherwise uses the existing environment/default functions. `BrowserBridgeServer` wires these values once in its constructor. No test-only public sweep method is added.

- [ ] **Step 4: Run replacement and lifecycle tests GREEN**

Run: `node --import tsx --test tests/integration/bridgeTabReplacementLease.test.ts tests/bootstrap/bridgeServerPorts.test.ts`

Expected: stable target migration, numeric replacement resolution, max-hop diagnostics, lease migration, conflict, release, TTL expiry, and disconnect cleanup all pass over the actual socket.

- [ ] **Step 5: Commit replacement and lease coverage**

```bash
git add tests/integration/bridgeTabReplacementLease.test.ts tests/integration/helpers/bridgeProtocolClient.ts src/kernels/session/SessionKernel.ts src/bridge/server/BrowserBridgeSessionState.ts src/bridge/server/BrowserBridgeClientHeartbeat.ts src/bridge/server/BrowserBridgeServer.ts
git commit -m "test: integrate replacement and lease lifecycle"
```

### Task 3: Durable And Non-Durable Reconnect Integration

**Files:**
- Create: `tests/integration/bridgeReconnect.test.ts`
- Modify: `tests/integration/helpers/bridgeProtocolClient.ts`

- [ ] **Step 1: Write the failing durable redelivery scenario**

```ts
test("same-instance durable reconnect redelivers the stable request id", async () => {
	const harness = await startBridgeProtocolHarness();
	const first = await harness.connectExtension({ tabs: [tab(7)], extensionInstanceId: "durable-instance", workerBootId: "worker-1", durableRequests: true });
	const resultPromise = harness.server.sendCommand({ cmd: "tabs", method: "list" }, { timeoutMs: 2_000 });
	const original = await first.nextCommand();
	await first.close();

	const second = await harness.connectExtension({ tabs: [tab(7)], extensionInstanceId: "durable-instance", workerBootId: "worker-2", durableRequests: true });
	try {
		const replay = await second.nextCommand();
		assert.equal(replay.id, original.id);
		assert.equal(replay.redelivered, true);
		assert.equal(replay.priorAck, false);
		second.sendAck(replay.id);
		second.sendResult(replay.id, [tab(7)]);
		assert.equal((await resultPromise).acknowledged, true);
		assert.equal(harness.server.snapshot().requestMetrics?.redelivered, 1);
	} finally {
		await second.close();
		await harness.close();
	}
});
```

- [ ] **Step 2: Add failing non-durable outcome scenarios and verify RED**

Create two requests on the first socket, ACK only the second, close it, and reconnect with the same `extensionInstanceId` and `durableRequests:false`. Assert the first rejects with `details.outcome === "not-delivered"`, the second rejects with `details.outcome === "inflight-unknown"`, the new socket receives neither request, and the corresponding request metrics each increment once.

Run: `node --import tsx --test tests/integration/bridgeReconnect.test.ts`

Expected: FAIL until the helper can close one client while preserving the running harness and can assert that no command arrives during a bounded interval.

- [ ] **Step 3: Complete reconnect helper operations**

Add:

```ts
async expectNoCommand(timeoutMs = 100): Promise<void> {
	await assert.rejects(this.nextCommand(timeoutMs), /Timed out waiting for bridge command/);
}
```

Make `close()` idempotent and wait for the socket `close` event. Preserve queued messages so commands received during `ext_ready` reconciliation are available to `nextCommand()`.

- [ ] **Step 4: Run reconnect tests GREEN**

Run: `node --import tsx --test tests/integration/bridgeReconnect.test.ts tests/bootstrap/bridgePendingRequests.test.ts`

Expected: durable replay retains the request ID; non-durable requests fail with distinct truthful outcomes; all promises settle before server cleanup.

- [ ] **Step 5: Commit reconnect integration**

```bash
git add tests/integration/bridgeReconnect.test.ts tests/integration/helpers/bridgeProtocolClient.ts
git commit -m "test: integrate bridge reconnect outcomes"
```

### Task 4: Protocol-Driven Observe Degradation Matrix

**Files:**
- Create: `tests/integration/helpers/observeProtocolResponder.ts`
- Create: `tests/integration/observeDegradation.test.ts`

- [ ] **Step 1: Write the failing production-registration matrix**

Register the real catalog and execute its `browser_observe` definition:

```ts
const definitions = new Map<string, BrowserCommandDefinition>();
defineBrowserCommands({ define(definition) { definitions.set(definition.name, definition); } }, server, async () => server);
const observe = definitions.get("browser_observe");
assert.ok(observe);
const result = await observe.execute("integration-observe", params, undefined, undefined, { cwd });
const envelope = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
const pageObservation = (envelope.summary as Record<string, unknown>).pageObservation as Record<string, unknown>;
assert.equal(pageObservation.model, "PageObservation");
```

Run one fresh harness for each fault: `structure`, `ax`, `readability`, `axe`, `tabs-refresh`, and `artifact`. Assert that only the requested provider is failed/degraded and that canonical scan-backed content and the fixture marker remain present. Structure, readability, axe, tabs, and artifact cases must name their stable code in `diagnostics.providerFailures`; AX must report `providers.ax:"degraded"` plus bounded AX diagnostics with `snapshotGeometryUnavailable:true` and zero nodes.

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/integration/observeDegradation.test.ts`

Expected: FAIL because the protocol responder and production-registration fixture do not exist.

- [ ] **Step 3: Implement deterministic protocol responses**

Export:

```ts
export type ObserveFault = "none" | "structure" | "ax" | "readability" | "axe" | "tabs-refresh";

export function startObserveProtocolResponder(client: BridgeProtocolClient, options: {
	fault: ObserveFault;
	tabId?: number;
}): { stop(): Promise<void>; commands: Array<Record<string, unknown>> };
```

For every command, send a real ACK first. Decode object or JSON-string `wire.code`, then respond as follows:

| Command | Result |
| --- | --- |
| `tabs/list` | one fixture tab; send a real `error` with known code `BRIDGE_TIMEOUT` only for `tabs-refresh` |
| `content.fingerprint` | `{ changeSeq: 1, url: "https://fixture.test/" }` |
| scan `persistent_cdp/Runtime.evaluate` | `{ result: { result: { value: fixtureScanData } } }` |
| `Accessibility.getFullAXTree` | empty nodes, or a real `error` with known code `BROWSER_EXECUTION_ERROR` for `ax` |
| `DOMSnapshot.captureSnapshot` | empty documents and strings |
| axe `Runtime.evaluate` | bounded axe result, or a successful Runtime.evaluate envelope whose page-side value is `{ ok:false, error:{ code:"AXE_PROVIDER_UNAVAILABLE", message:"axe unavailable" } }` |
| readability `Runtime.evaluate` | bounded article result, or a successful Runtime.evaluate envelope whose page-side value is `{ ok:false, error:{ code:"READABILITY_PROVIDER_UNAVAILABLE", message:"readability unavailable" } }` |
| `network.status` | `{ active: false, lastSeq: 0 }` |
| `hook.status` | `{ active: false, last_seq: 0 }` |

For `structure`, send the successful primary scan result, immediately send `tabs_update` with an empty tab list, and then allow ABML target resolution to return its production `NO_TAB` failure. For `artifact`, use `outputPath:""`; it is a local artifact-boundary degradation and must not be mislabeled as a wire failure.

- [ ] **Step 4: Run the matrix and full integration scope GREEN**

Run: `node --import tsx --test tests/integration/observeDegradation.test.ts tests/memory/observeScanRunner.test.ts tests/memory/observeScanProjection.test.ts`

Expected: every independent degradation returns a truthful canonical `PageObservation`; default providers remain `executed` or `scan-backed`; all responder loops stop in `finally`.

Run: `mise run test-integration`

Expected: all real-protocol scenarios pass serially.

- [ ] **Step 5: Commit observation integration**

```bash
git add tests/integration/helpers/observeProtocolResponder.ts tests/integration/observeDegradation.test.ts
git commit -m "test: integrate observe provider degradation"
```

### Task 5: Extract Observe Cache Reuse

**Files:**
- Create: `src/commands/observation/observe/scanCache.ts`
- Create: `tests/memory/observeScanCache.test.ts`
- Modify: `src/commands/observation/observe/scanRunner.ts`
- Modify: `tests/memory/observeScanRunner.test.ts`

- [ ] **Step 1: Write a failing cache collaborator test**

Characterize a cache hit, unreadable artifact fallback, and fingerprint mismatch. The hit must return `fromCache:true`, mint a new snapshot ID, preserve the prior PageObservation, and read only recorder high-water marks.

```ts
const result = await tryReuseObserveCache(input);
assert.equal(result?.details?.fromCache, true);
assert.notEqual(result?.details?.snapshotId, input.ledgerFrame.snapshotId);
assert.deepEqual(calls, ["network.status", "hook.status"]);
```

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/memory/observeScanCache.test.ts`

Expected: FAIL because `tryReuseObserveCache` is not exported from a focused owner.

- [ ] **Step 3: Move cache reuse behind one typed boundary**

Create:

```ts
export type ObserveCacheReuseInput = {
	server: BrowserCommandRuntimePort;
	params: ObserveToolParams;
	ctx: CommandResultContext;
	mode: Extract<ObserveMode, "scan" | "text">;
	ledgerKey?: CommandPerceptionLedgerKey;
	ledgerFrame?: CommandPerceptionLedgerFrame;
	pageFingerprint?: PageFingerprint;
	detailLevel: string;
	maxChars: number;
	paramsSignature: string;
	outputPath?: string;
	onUpdate?: CommandOnUpdate;
};

export async function tryReuseObserveCache(input: ObserveCacheReuseInput): Promise<BrowserTextCommandResult | undefined>;
```

Move artifact parsing, `cachedEnvelopeFromArtifact`, recorder-sequence reads, cache metadata, snapshot renewal, and ledger refresh into `scanCache.ts`. Keep `cachedObserveResultFromEnvelope` exported from `scanRunner.ts` for compatibility by re-exporting it from `scanCache.ts`.

- [ ] **Step 4: Run cache and runner parity GREEN**

Run: `node --import tsx --test tests/memory/observeScanCache.test.ts tests/memory/observeScanRunner.test.ts tests/memory/observeScanProjection.test.ts`

Expected: cache hit and miss behavior is byte-for-byte compatible after removing the original inline block.

- [ ] **Step 5: Commit cache extraction**

```bash
git add src/commands/observation/observe/scanCache.ts src/commands/observation/observe/scanRunner.ts tests/memory/observeScanCache.test.ts tests/memory/observeScanRunner.test.ts
git commit -m "refactor: extract observe cache reuse"
```

### Task 6: Extract Observe Provider Execution

**Files:**
- Create: `src/commands/observation/observe/scanProviders.ts`
- Create: `tests/memory/observeScanProviders.test.ts`
- Modify: `src/commands/observation/observe/scanRunner.ts`

- [ ] **Step 1: Write failing provider-bundle tests**

Use the existing mock runtime to lock tabs fallback, primary scan, ABML, AX status, axe, readability, and recorder behavior. Assert that provider failures remain structured and one optional provider failure does not reject the bundle.

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/memory/observeScanProviders.test.ts`

Expected: FAIL because `collectScanProviders()` is missing.

- [ ] **Step 3: Extract provider I/O and status normalization**

Create these exact contracts:

```ts
export type ObservationProviderFailure = {
	provider: string;
	code: string;
	message?: string;
	details?: Record<string, unknown>;
};

export type ScanProviderBundle = {
	tabs: BrowserTabLike[];
	tabsRefreshDegraded: boolean;
	primary: BrowserBridgeExecutionResult;
	abmlRead: (AbmlVerbResult & { diff?: EntityDiff }) | undefined;
	axe: AxeDiagnosticsResult;
	readability: ReadabilityRunResult;
	recorderState: RecorderSeq;
	hookState: RecorderSeq;
	providerFailures: ObservationProviderFailure[];
	timings: ObserveTimingMetrics;
};

export async function collectScanProviders(input: ScanProviderInput): Promise<ScanProviderBundle>;
```

Move tabs refresh/fallback, scan script execution, ABML read, recorder status, axe, readability, and provider failure normalization. The function accepts already-resolved target, timeout, baseline, and request flags; it does not build summaries or envelopes.

- [ ] **Step 4: Run provider, protocol, and runner tests GREEN**

Run: `node --import tsx --test tests/memory/observeScanProviders.test.ts tests/memory/observeScanRunner.test.ts tests/integration/observeDegradation.test.ts`

Expected: unit and actual-socket degradation matrices retain the same provider statuses and failure codes.

- [ ] **Step 5: Commit provider extraction**

```bash
git add src/commands/observation/observe/scanProviders.ts src/commands/observation/observe/scanRunner.ts tests/memory/observeScanProviders.test.ts
git commit -m "refactor: extract observe provider execution"
```

### Task 7: Extract Observe Assembly And Envelope Projection

**Files:**
- Create: `src/commands/observation/observe/scanAssembly.ts`
- Create: `src/commands/observation/observe/scanEnvelope.ts`
- Create: `tests/memory/observeScanAssembly.test.ts`
- Modify: `src/commands/observation/observe/scanRunner.ts`
- Modify: `src/commands/observation/observe/scanProjection.ts`

- [ ] **Step 1: Write failing causal/diff and envelope parity tests**

Capture canonical no-mode output with and without a baseline. Assert equality for `summary.diff`, `summary.treeDiff`, `causal`, provider diagnostics, entities, collections, artifact projection, result details, and saved artifact contents before extraction.

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/memory/observeScanAssembly.test.ts`

Expected: FAIL because assembly and rendering have no independent entry points.

- [ ] **Step 3: Extract pure assembly from final rendering**

Create:

```ts
export function assembleScanObservation(input: ScanAssemblyInput): ScanAssemblyResult;

export async function renderScanObservation(input: ScanEnvelopeInput): Promise<BrowserTextCommandResult>;
```

`assembleScanObservation()` owns entity registration, baseline entity/tree diffs, causal relations, relevance, collection models, identity/relation graphs, artifact projection, and ledger facts. It performs no filesystem or bridge I/O. `renderScanObservation()` owns PageObservation status projection, result details, artifact value, `textCommandResult()`, allocation callback, and final ledger/profile recording. `scanRunner.ts` remains the public orchestration entry and `observeErrorResult` owner.
All imports crossing from observation into the Stage-4 runtime or evidence subdomains target their
`index.ts`/`contracts/` surfaces; the extraction must not reintroduce private cross-subdomain edges.

- [ ] **Step 4: Run all observe parity evidence GREEN**

Run: `node --import tsx --test tests/memory/observeScanAssembly.test.ts tests/memory/observeScanRunner.test.ts tests/memory/observeScanProjection.test.ts tests/memory/observeRegressionBenchmark.test.ts tests/integration/observeDegradation.test.ts`

Expected: canonical envelopes and saved artifacts remain compatible; `scanRunner.ts` contains orchestration rather than provider, assembly, or rendering implementations.

- [ ] **Step 5: Commit observe orchestration split**

```bash
git add src/commands/observation/observe/scanAssembly.ts src/commands/observation/observe/scanEnvelope.ts src/commands/observation/observe/scanRunner.ts src/commands/observation/observe/scanProjection.ts tests/memory/observeScanAssembly.test.ts
git commit -m "refactor: split observe scan orchestration"
```

### Task 8: Split Tab Replacement, Selection, And Target Resolution

**Files:**
- Create: `src/bridge/server/BrowserTabReplacementHistory.ts`
- Create: `src/bridge/server/BrowserTabSessionSelection.ts`
- Create: `src/bridge/server/BrowserTabTargetResolver.ts`
- Create: `tests/bootstrap/bridgeTabRouterModules.test.ts`
- Modify: `src/bridge/server/BrowserTabSessionRouter.ts`
- Modify: `tests/integration/bridgeTabReplacementLease.test.ts`

- [ ] **Step 1: Write failing focused module and facade-parity tests**

Characterize multi-hop replacement, expired replacement evidence, handle/session-id/numeric targets, ambiguous numeric tab IDs, active/default/latest selection, attach/detach, and reconnect identity. Keep the actual-socket replacement test as the end-to-end oracle.

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/bootstrap/bridgeTabRouterModules.test.ts tests/integration/bridgeTabReplacementLease.test.ts`

Expected: focused imports fail because the three owners do not exist.

- [ ] **Step 3: Introduce the focused owners**

Use these boundaries:

```ts
export class BrowserTabReplacementHistory {
	clear(): void;
	apply(raw: unknown[], context: ReplacementApplyContext, now?: number): ReplacementRecord[];
	consumeIdentity(browserId: string, tabId: number): ReplacementIdentity | undefined;
	resolve(tabId: number, context: ReplacementResolveContext, now?: number): ReplacementResolution;
	prune(now?: number): void;
}

export class BrowserTabSessionSelection {
	describe(session: BrowserAutomationSession, selectedBrowser?: BrowserBridgeClientInfo): BrowserAutomationSessionInfo;
	selectBrowser(client: WebSocket, browserSessionId?: string): string | undefined;
	selectTab(tabId: number, browserSessionId?: string): void;
	attach(tabId: number, browserSessionId?: string, browserId?: string): BrowserTabSession | undefined;
	detach(tabId: number, browserSessionId?: string): void;
	refresh(now?: number, browserSessionId?: string): void;
}

export class BrowserTabTargetResolver {
	resolve(value: unknown, browserSessionId?: string, source?: BrowserBridgeTargetSource): BrowserBridgeTargetInfo | undefined;
	fallback(browserSessionId?: string): BrowserBridgeTargetInfo | undefined;
	resolvedTarget(target: BrowserBridgeTargetInfo | undefined): BrowserBridgeTargetInfo | undefined;
}
```

The collaborators receive maps/accessors through constructors; none creates a second session registry. `BrowserTabSessionRouter` continues to own live tab synchronization and delegates the three responsibilities without changing its public API.

- [ ] **Step 4: Run router and protocol parity GREEN**

Run: `node --import tsx --test tests/bootstrap/bridgeTabRouterModules.test.ts tests/bootstrap/bridgeServerPorts.test.ts tests/integration/bridgeTabReplacementLease.test.ts tests/integration/bridgeReconnect.test.ts`

Expected: target diagnostics, stable handles, selection versions, lease migration, and reconnect identity are unchanged.

- [ ] **Step 5: Commit tab router split**

```bash
git add src/bridge/server/BrowserTabReplacementHistory.ts src/bridge/server/BrowserTabSessionSelection.ts src/bridge/server/BrowserTabTargetResolver.ts src/bridge/server/BrowserTabSessionRouter.ts tests/bootstrap/bridgeTabRouterModules.test.ts tests/integration/bridgeTabReplacementLease.test.ts
git commit -m "refactor: split bridge tab routing owners"
```

### Task 9: Split ABML Collection Evidence, Completeness, And Continuation

**Files:**
- Create: `src/kernels/abml/collectionTypes.ts`
- Create: `src/kernels/abml/collectionEvidence.ts`
- Create: `src/kernels/abml/collectionCompleteness.ts`
- Create: `src/kernels/abml/collectionContinuation.ts`
- Create: `tests/bootstrap/abmlCollectionModules.test.ts`
- Modify: `src/kernels/abml/collections.ts`
- Modify: `tests/bootstrap/kernelRuntimeHelpers.test.ts`
- Modify: `tests/memory/observeRegressionBenchmark.test.ts`

- [ ] **Step 1: Write failing focused pure-kernel tests**

Lock template/entity/list-hint normalization, declared totals, skeleton/lazy evidence, growth probes, pagination controls, continuation handles, page size, scroll direction, duplicate safe names, and the empty input. Assert `buildCollectionModels()` still returns the same models.

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/bootstrap/abmlCollectionModules.test.ts`

Expected: FAIL because the focused pure modules do not exist.

- [ ] **Step 3: Extract types and three pure responsibilities**

Create:

```ts
export function normalizeCollectionEvidence(input: BuildCollectionModelsInput): DraftCollection[];

export function inferCollectionCompleteness(input: {
	draft: DraftCollection;
	pagination?: PaginationEdge;
	growth?: GrowthEvidence;
}): CollectionClassification;

export function projectCollectionContinuation(input: {
	collectionId: string;
	draft: DraftCollection;
	classification: CollectionClassification;
	pagination?: PaginationEdge;
	growthProbe?: Record<string, unknown>;
}): Pick<CollectionModel, "continuation" | "pageSize" | "paginationControl" | "scrollDirection">;
```

Move public/internal collection types to `collectionTypes.ts` and re-export every existing public type from `collections.ts`. `collectionEvidence.ts` owns draft merging and safe naming. `collectionCompleteness.ts` owns boundary classification. `collectionContinuation.ts` is the only collection module allowed to mint continuation refs. `collections.ts` sorts, caps, disambiguates, assembles models, and preserves `buildCollectionModels()` plus `summarizeCollectionCompleteness()`.

- [ ] **Step 4: Run kernel purity and benchmark parity GREEN**

Run: `node --import tsx --test tests/bootstrap/abmlCollectionModules.test.ts tests/bootstrap/kernelRuntimeHelpers.test.ts tests/memory/observeRegressionBenchmark.test.ts`

Expected: all collection snapshots are equal and the Stage-3 architecture audit reports no non-pure dependency path.

- [ ] **Step 5: Commit collection split**

```bash
git add src/kernels/abml/collectionTypes.ts src/kernels/abml/collectionEvidence.ts src/kernels/abml/collectionCompleteness.ts src/kernels/abml/collectionContinuation.ts src/kernels/abml/collections.ts tests/bootstrap/abmlCollectionModules.test.ts tests/bootstrap/kernelRuntimeHelpers.test.ts tests/memory/observeRegressionBenchmark.test.ts
git commit -m "refactor: split ABML collection inference"
```

### Task 10: Split Program Validation, Execution, And Results

**Files:**
- Create: `src/browser-command-runtime/programTypes.ts`
- Create: `src/browser-command-runtime/programValidation.ts`
- Create: `src/browser-command-runtime/programExecution.ts`
- Create: `src/browser-command-runtime/programResults.ts`
- Create: `tests/bootstrap/programEngineModules.test.ts`
- Modify: `src/browser-command-runtime/programEngine.ts`
- Modify: `tests/bootstrap/coreCommandsDispatch.test.ts`

- [ ] **Step 1: Write failing module and public-facade parity tests**

Cover dead refs, stale relocatable refs, malformed frames, eval expansion, mouse/key/text/wait dispatch, abort-before-frame, navigation detection, result variable collection, and target-ref collection. Compare `executeProgram()` output for success, failure, timeout, and malformed expansion to the pre-split snapshots.

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/bootstrap/programEngineModules.test.ts tests/bootstrap/coreCommandsDispatch.test.ts`

Expected: focused imports fail while the existing monolith characterization remains green.

- [ ] **Step 3: Extract contracts and responsibilities**

Use:

```ts
export type { ProgramContext, ProgramFrameResult, ProgramResult } from "./programTypes.js";
export function validateProgram(program: unknown[], ctx: ProgramContext): ProgramValidationResult;
export async function executeProgramFrames(input: ProgramExecutionInput): Promise<ProgramExecutionResult>;
export function collectProgramResult(input: ProgramResultInput): ProgramResult;
export function collectProgramTargetRefs(program: unknown[]): ProgramTargetRef[];
```

`programValidation.ts` owns frame shape checks, ref precheck, and stale relocation. `programExecution.ts` owns frame dispatch and browser I/O. `programResults.ts` owns frame/result folding, context variable/ref collection, abort projection, and `collectProgramTargetRefs`. `programEngine.ts` remains the public orchestrator and re-exports the original types and target-ref function.

- [ ] **Step 4: Run program and execute-command parity GREEN**

Run: `node --import tsx --test tests/bootstrap/programEngineModules.test.ts tests/bootstrap/coreCommandsDispatch.test.ts tests/cli/commandExecution.test.ts`

Expected: dispatch order, bridge payloads, frame results, abort reasons, and exported API remain unchanged.

- [ ] **Step 5: Commit program-engine split**

```bash
git add src/browser-command-runtime/programTypes.ts src/browser-command-runtime/programValidation.ts src/browser-command-runtime/programExecution.ts src/browser-command-runtime/programResults.ts src/browser-command-runtime/programEngine.ts tests/bootstrap/programEngineModules.test.ts tests/bootstrap/coreCommandsDispatch.test.ts
git commit -m "refactor: split browser program engine"
```

### Task 11: Split Browser Capture, AX Snapshot Decoding, And Merge Orchestration

**Files:**
- Create: `src/browser-runtime/abml/captureProviders.ts`
- Create: `src/browser-runtime/abml/readRuntime.ts`
- Create: `src/browser-runtime/abml/axSnapshotDecoder.ts`
- Create: `src/browser-runtime/abml/axCaptureProvider.ts`
- Create: `src/browser-runtime/abml/axMergeOrchestrator.ts`
- Create: `tests/bootstrap/abmlRuntimeModules.test.ts`
- Modify: `src/browser-runtime/abml/runtime.ts`
- Modify: `src/browser-runtime/abml/axRuntime.ts`
- Modify: `tests/bootstrap/kernelRuntimeHelpers.test.ts`
- Modify: `tests/integration/observeDegradation.test.ts`

- [ ] **Step 1: Write failing capture, decoder, merge, and facade tests**

Use recorded CDP-shaped fixtures to cover full and partial AX trees, DOMSnapshot geometry, paint order, bounded box-model fallback, cache hits, AX-only and enriched entities, relation anchors, scan capture, stream planes, and the existing `createBrowserAbmlRuntime()` result shape.

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/bootstrap/abmlRuntimeModules.test.ts tests/bootstrap/kernelRuntimeHelpers.test.ts`

Expected: focused runtime imports fail; existing partial-AX tests remain green.

- [ ] **Step 3: Extract AX snapshot decoding and capture I/O**

Create:

```ts
export function decodeAxSnapshot(value: unknown): {
	geometryEntries: SnapshotGeometryEntry[];
	paintOrderEntries: PaintOrderEntry[];
	geometryByBackend: Map<number, AxGeometry>;
};

export async function captureAxTree(server: AbmlAxRuntimeServer, options: AxReadRuntimeOptions): Promise<AxCaptureResult>;

export function mergeCapturedAx(input: AxMergeInput): AxReadResult;
```

`axSnapshotDecoder.ts` has no bridge I/O. `axCaptureProvider.ts` owns CDP calls, raw cache, partial/full tree capture, snapshot capture, and bounded geometry fallback. `axMergeOrchestrator.ts` owns entity creation, DOM/AX fusion, current-container hints, property/table/paint anchors, and diagnostics. `axRuntime.ts` retains `readPartialAxTree`, `readAxEntities`, `nearestContainer`, and `mergeAxIntoDomEntities` as compatibility exports that delegate to the new owners.

- [ ] **Step 4: Extract ABML page/stream capture from verb orchestration**

Create:

```ts
export async function captureAbmlPage(server: AbmlBrowserRuntimeServer, input: AbmlReadInput, options: BrowserAbmlRuntimeOptions): Promise<AbmlPageCapture>;
export async function captureStreamPlane(server: AbmlBrowserRuntimeServer, input: AbmlReadInput, options: BrowserAbmlRuntimeOptions, plane: StreamPlane): Promise<AbmlStreamCapture>;
export async function executeBrowserAbmlRead(server: AbmlBrowserRuntimeServer, input: AbmlReadInput, options?: BrowserAbmlRuntimeOptions): Promise<AbmlVerbResult>;
```

`captureProviders.ts` owns browser commands, scan capture, AX capture, listener probes, stream reads, and frame/vision capture adapters. `readRuntime.ts` owns target/ref access checks and page/stream merge orchestration. `runtime.ts` keeps `createBrowserAbmlRuntime`, `executeBrowserAbmlRead`, `executeBrowserAbmlPierce`, `executeBrowserAbmlFrame`, `inspectVisionRegion`, and verb-level error projection at their original import path.

- [ ] **Step 5: Run runtime and protocol degradation parity GREEN**

Run: `node --import tsx --test tests/bootstrap/abmlRuntimeModules.test.ts tests/bootstrap/kernelRuntimeHelpers.test.ts tests/memory/observeScanRunner.test.ts tests/integration/observeDegradation.test.ts`

Expected: AX failure remains degraded rather than fatal, PageObservation provider statuses are unchanged, and all browser-runtime public exports compile from their original paths.

- [ ] **Step 6: Commit browser-runtime split**

```bash
git add src/browser-runtime/abml/captureProviders.ts src/browser-runtime/abml/readRuntime.ts src/browser-runtime/abml/axSnapshotDecoder.ts src/browser-runtime/abml/axCaptureProvider.ts src/browser-runtime/abml/axMergeOrchestrator.ts src/browser-runtime/abml/runtime.ts src/browser-runtime/abml/axRuntime.ts tests/bootstrap/abmlRuntimeModules.test.ts tests/bootstrap/kernelRuntimeHelpers.test.ts tests/integration/observeDegradation.test.ts
git commit -m "refactor: split browser ABML capture runtime"
```

### Task 12: Ownership Guardrails, Canonical Documentation, And Final Audit

**Files:**
- Create: `tests/governance/hotspotOwnership.test.ts`
- Modify: `CODE_WIKI.md`
- Modify: `REPO_GOVERNANCE.md`
- Modify: `scripts/run-validation.mjs`

- [ ] **Step 1: Write failing secondary hotspot guardrails**

Assert that each original hotspot imports its focused owners and remains below a generous orchestration/facade ceiling: `scanRunner.ts`, `BrowserTabSessionRouter.ts`, `collections.ts`, and `programEngine.ts` at 360 lines; `runtime.ts` at 320; `axRuntime.ts` at 260. Also assert the real-protocol integration scope is included in deterministic verify and the real-browser smoke remains outside deterministic PR verification.

- [ ] **Step 2: Run and verify RED**

Run: `node --import tsx --test tests/governance/hotspotOwnership.test.ts`

Expected: FAIL until the ownership map and validation routing are synchronized.

- [ ] **Step 3: Update canonical owners and affected-file routing**

Document the protocol integration tier and new module ownership in `CODE_WIKI.md` Sections 5, 6, 8, 9, 11, and 12. Keep `REPO_GOVERNANCE.md` as the gate owner: `mise run test-integration` is deterministic and part of `verify`; `mise run browser-smoke` and `mise run coverage` retain their separate nightly policies. Extend affected-file routing so changes under the new bridge/runtime/observe modules run their focused tests plus integration scenarios.

- [ ] **Step 4: Run focused and repository gates**

Run: `mise run test-integration`

Expected: replacement, leases, reconnects, and all six degradation cases pass.

Run: `mise run affected`

Expected: exit code 0.

Run: `mise run verify`

Expected: exit code 0, including typecheck, lint, reachability, architecture audit, protocol sync, deterministic tests, and integration tests.

- [ ] **Step 5: Run cross-program completion evidence**

Run: `mise run coverage`

Expected: every measured domain meets the checked-in non-regression ratchet and the measured-file manifest is current.

Run: `mise run browser-smoke -- --browser chrome --json`

Expected: daemon, handshake, tabs, execute, observe, ACK, worker reload, reconnect, and target reuse pass.

Run: `mise run browser-smoke -- --browser edge --json`

Expected: the same structured report passes on Edge.

Run: `node scripts/check-markdown-links.mjs CODE_WIKI.md SECURITY.md REPO_GOVERNANCE.md src/kernels/abml/README.md`

Expected: exit code 0 with no broken local links.

Run: `node scripts/sync-native-protocol.mjs --check`

Expected: generated protocol and metadata outputs are current without manual edits.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 6: Confirm user changes and commit Stage 6**

Compare `git status --short` with the recorded pre-implementation state. Confirm no pre-existing user file or `.trae/specs/improve-exploration-ux-benchmark/` content was removed, reverted, or accidentally staged.

```bash
git add tests/governance/hotspotOwnership.test.ts CODE_WIKI.md REPO_GOVERNANCE.md scripts/run-validation.mjs
git commit -m "docs: record hotspot and integration ownership"
```
