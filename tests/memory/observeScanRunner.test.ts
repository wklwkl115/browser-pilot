import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { BrowserCommandRuntimePort, BrowserTabLike, CommandActiveOperationInfo, CommandObservationSnapshotInfo } from "../../src/ports/BrowserCommandRuntimePort.ts";
import type { BrowserBridgeExecutionResult, BrowserRuntimeCommand } from "../../src/ports/BrowserRuntimeTypes.ts";
import { runScanObservation } from "../../src/commands/observe/scanRunner.ts";
import type { ObserveToolParams } from "../../src/commands/observe/common.ts";

type MockOptions = {
	cwd?: string;
	refreshTabsFails?: boolean;
	tabId?: number;
	tabs?: BrowserTabLike[];
	tabFallback?: BrowserTabLike[];
	tabRefreshError?: unknown;
	tabUrl?: string;
	content?: string;
	tabTitle?: string;
	tabDefault?: number;
	noDefaultTab?: boolean;
	axePayload?: Record<string, unknown>;
	axeThrows?: boolean;
	readabilityPayload?: Record<string, unknown>;
	readabilityThrows?: boolean;
};

const articleFixture = {
	title: "City council approves river restoration plan",
	byline: "Reporter Example",
	excerpt: "The plan removes boilerplate and keeps the article lead while token=secret stays private.",
	textContent: "City council approved a river restoration plan after a long public hearing. The article body explains habitat work, budget milestones, and community oversight. token=secret Authorization: Bearer abc123",
	content: "<article><header><h1>City council approves river restoration plan</h1><script>window.secret='leak'</script><style>.ad{display:none}</style></header><p>City council approved a river restoration plan after a long public hearing.</p><p>Authorization: Bearer abc123 token=secret</p></article>",
	textLength: 186,
	contentLength: 278,
	siteName: "Daily Example",
	lang: "en",
	dir: "ltr",
	publishedTime: "2026-06-30T09:00:00Z",
};

const boilerplateHeavyFallback = "Subscribe now Navigation Advertisement Cookie banner Related links Footer © Example City council approved a river restoration plan after a long public hearing.";

function readabilityPayload(article: Record<string, unknown> | null = articleFixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { ok: true, elapsedMs: 11, article, ...overrides };
}

function payloadText(value: unknown): string {
	return JSON.stringify(value);
}

function assertNotIncludes(value: unknown, needle: string): void {
	assert.equal(payloadText(value).includes(needle), false, `unexpected text leaked: ${needle}`);
}

function assertProviderFailure(diagnostics: Record<string, unknown>, provider: string, code: string): void {
	const failures = diagnostics.providerFailures as Array<Record<string, unknown>>;
	assert.equal(failures.some((failure) => failure.provider === provider && failure.code === code), true);
}

function readabilityArtifact(artifact: Record<string, unknown>): Record<string, unknown> {
	return artifact.readability as Record<string, unknown>;
}

function readabilityArticle(artifact: Record<string, unknown>): Record<string, unknown> {
	return readabilityArtifact(artifact).article as Record<string, unknown>;
}

function scanData(options: MockOptions): Record<string, unknown> {
	const tabId = options.tabId ?? 7;
	return {
		url: options.tabUrl ?? "https://example.test/checkout",
		title: options.tabTitle ?? "Checkout",
		content: options.content ?? "Checkout content",
		actionables: [
			{ kind: "button", label: "Pay now", text: "Pay now", selector: "#pay", rect: { x: 1, y: 2, width: 90, height: 30 } },
		],
		signals: { fingerprint: { changeSeq: 1, url: options.tabUrl ?? "https://example.test/checkout" } },
		tabId,
	};
}

function createMockServer(options: MockOptions = {}): BrowserCommandRuntimePort & { calls: { refreshTabs: number; getTabs: number; sendCommand: BrowserRuntimeCommand[]; axe: number; readability: number } } {
	const tabId = options.tabId ?? 7;
	const tabs = options.tabs ?? [{ id: tabId, tabId, url: options.tabUrl ?? "https://example.test/checkout", title: options.tabTitle ?? "Checkout", active: true }];
	const fallbackTabs = options.tabFallback ?? tabs;
	let operationSeq = 0;
	let snapshotSeq = 0;
	const operations = new Map<string, CommandActiveOperationInfo>();
	const snapshots = new Map<string, CommandObservationSnapshotInfo>();
	const calls = { refreshTabs: 0, getTabs: 0, sendCommand: [] as BrowserRuntimeCommand[], axe: 0, readability: 0 };
	const server = {
		calls,
		snapshot() {
			return {
				browserSessionId: "session-1",
				host: "127.0.0.1",
				port: 18765,
				running: true,
				connectedClients: 1,
				extensionConnected: true,
				clients: [],
				...(options.noDefaultTab ? {} : { defaultTabId: options.tabDefault ?? tabId }),
				selectionVersion: 1,
				tabs,
				pending: [],
			};
		},
		getTabs() {
			calls.getTabs += 1;
			return fallbackTabs;
		},
		async refreshTabs() {
			calls.refreshTabs += 1;
			if (options.refreshTabsFails) throw options.tabRefreshError ?? new Error("tabs refresh unavailable");
			return tabs;
		},
		async waitForExtensionReconnect() {
			return this.snapshot();
		},
		resolveTargetTabId(value: unknown) {
			return typeof value === "number" ? value : tabId;
		},
		async sendCommand(command: BrowserRuntimeCommand) {
			calls.sendCommand.push(command);
			if (command.cmd === "persistent_cdp" && command.action === "send" && command.cdpMethod === "Runtime.evaluate") {
				const expression = typeof command.params === "object" && command.params !== null && "expression" in command.params ? String((command.params as { expression?: unknown }).expression) : "";
				if (expression.includes("axe-core diagnostics timed out") || expression.includes("axe.run")) {
					calls.axe += 1;
					if (options.axeThrows) throw Object.assign(new Error("axe provider unavailable"), { code: "AXE_PROVIDER_UNAVAILABLE" });
					return { id: "axe", acknowledged: true, tabId, data: { result: { result: { value: options.axePayload ?? { ok: true, elapsedMs: 12, result: { testEngine: { name: "axe-core", version: "test" }, violations: [], incomplete: [], passes: [], inapplicable: [] } } } } } } as BrowserBridgeExecutionResult;
				}
				if (expression.includes("Readability content provider timed out") || expression.includes("globalThis.Readability") || expression.includes("new globalThis.Readability")) {
					calls.readability += 1;
					if (options.readabilityThrows) throw Object.assign(new Error("readability provider unavailable"), { code: "READABILITY_PROVIDER_UNAVAILABLE" });
					return { id: "readability", acknowledged: true, tabId, data: { result: { result: { value: options.readabilityPayload ?? readabilityPayload() } } } } as BrowserBridgeExecutionResult;
				}
				return { id: "eval", acknowledged: true, tabId, data: { result: { result: { value: scanData(options) } } } } as BrowserBridgeExecutionResult;
			}
			if (command.cmd === "network.list") return { id: "network", acknowledged: true, tabId, data: { items: [], active: false, lastSeq: 0 } } as BrowserBridgeExecutionResult;
			if (command.cmd === "hook.collect") return { id: "hook", acknowledged: true, tabId, data: { events: [], active: false, lastSeq: 0 } } as BrowserBridgeExecutionResult;
			return { id: "command", acknowledged: true, tabId, data: {} } as BrowserBridgeExecutionResult;
		},
		async executeJavaScript() {
			return { id: "js", acknowledged: true, tabId, data: {} } as BrowserBridgeExecutionResult;
		},
		async switchTab() {
			return { id: "switch", acknowledged: true, tabId, data: {} } as BrowserBridgeExecutionResult;
		},
		async createTab() {
			return { id: "create", acknowledged: true, tabId, data: {} } as BrowserBridgeExecutionResult;
		},
		async closeTab() {
			return { id: "close", acknowledged: true, tabId, data: {} } as BrowserBridgeExecutionResult;
		},
		listBrowserSessions() { return []; },
		createBrowserSession() { return {}; },
		selectBrowserSession() { return {}; },
		closeBrowserSession() { return {}; },
		attachTabToBrowserSession() { return tabs[0] ?? { tabId }; },
		detachTabFromBrowserSession() { return {}; },
		selectBrowser() { return {}; },
		leaseTab() { return { id: "lease-1", browserSessionId: "session-1", tabSessionId: "tab-session-1", browserId: "browser-1", tabId, explicit: true, createdAt: Date.now(), lastSeenAt: Date.now() }; },
		releaseTab() { return undefined; },
		acquireUiLock() { return { browserSessionId: "session-1", commandName: "browser_observe", createdAt: Date.now(), lastSeenAt: Date.now(), count: 1 }; },
		releaseUiLock() { return undefined; },
		queueDepth() { return 0; },
		leaseOwnerHash() { return undefined; },
		createObservationSnapshot(snapshot: Omit<CommandObservationSnapshotInfo, "snapshotId" | "expired" | "ttlMs"> & { snapshotId?: string; ttlMs?: number }) {
			const created: CommandObservationSnapshotInfo = { snapshotId: snapshot.snapshotId ?? `snap-${++snapshotSeq}`, ttlMs: snapshot.ttlMs ?? 60_000, expired: false, ...snapshot };
			snapshots.set(created.snapshotId, created);
			return created;
		},
		getObservationSnapshot(snapshotId: string) { return snapshots.get(snapshotId); },
		listObservationSnapshots() { return [...snapshots.values()]; },
		beginOperation(meta: Omit<CommandActiveOperationInfo, "operationId" | "startedAt" | "updatedAt"> & { operationId?: string }) {
			const now = Date.now();
			const operation: CommandActiveOperationInfo = { operationId: meta.operationId ?? `op-${++operationSeq}`, startedAt: now, updatedAt: now, ...meta };
			operations.set(operation.operationId, operation);
			return operation;
		},
		updateOperation(operationId: string, patch: Partial<Omit<CommandActiveOperationInfo, "operationId" | "startedAt">>) {
			const prior = operations.get(operationId);
			if (!prior) return undefined;
			const next = { ...prior, ...patch, updatedAt: Date.now() };
			operations.set(operationId, next);
			return next;
		},
		finishOperation(operationId: string) {
			const operation = operations.get(operationId);
			operations.delete(operationId);
			return operation;
		},
	} satisfies BrowserCommandRuntimePort & { calls: { refreshTabs: number; getTabs: number; sendCommand: BrowserRuntimeCommand[]; axe: number; readability: number } };
	return server;
}

async function runObserve(options: MockOptions = {}, params: Partial<ObserveToolParams> = {}) {
	const cwd = options.cwd ?? await mkdtemp(path.join(tmpdir(), "browser-pilot-observe-runner-"));
	const server = createMockServer(options);
	const result = await runScanObservation(server, { maxChars: 80_000, fresh: true, ...params }, { cwd }, "scan");
	const envelope = JSON.parse(result.content[0]?.text || "{}") as Record<string, unknown>;
	const summary = envelope.summary as Record<string, unknown>;
	const saved = result.details?.saved as Record<string, unknown> | undefined;
	return { server, envelope, summary, pageObservation: summary.pageObservation as Record<string, unknown>, cwd, saved };
}

test("observe/action/extract boundary oracle keeps observe as structural entry-point map", async () => {
	const businessValue = "invoice INV-2026-0001 total $9,876.54 token=secret";
	const { pageObservation, saved } = await runObserve({ content: businessValue, tabTitle: "Invoices" });
	const providers = (pageObservation.diagnostics as Record<string, unknown>).providers as Record<string, unknown>;
	const artifactHints = pageObservation.artifact_hints as Record<string, unknown>;
	const preferredReads = artifactHints.preferredReads as Array<Record<string, unknown>>;
	assert.equal(pageObservation.model, "PageObservation");
	assert.equal(Array.isArray(pageObservation.refs), true);
	assert.equal((pageObservation.refs as unknown[]).length > 0, true);
	assert.equal((pageObservation.refs as string[]).every((ref) => ref.startsWith("bp-ref://")), true);
	assert.equal(JSON.stringify(pageObservation.entities).includes("Pay now"), true);
	assert.equal("content" in pageObservation, true);
	assert.equal("evidence" in pageObservation, true);
	assert.equal("diagnostics" in pageObservation, true);
	assert.equal(providers.structure, "executed");
	assert.equal(providers.evidence, "scan-backed");
	assert.equal(saved?.path && typeof saved.path === "string", true);
	assert.equal(preferredReads.some((read) => read.label === "saved observation artifact" && read.jsonPath === "pageObservation" && read.kind === "abml-page-observation"), true);
	assert.equal(preferredReads.some((read) => read.label === "raw scan evidence" && read.jsonPath === "data" && read.kind === "scan-evidence"), true);
	assert.equal(JSON.stringify(pageObservation.actionables).includes("INV-2026-0001"), false);
	assert.equal(JSON.stringify(pageObservation.refs).includes("9876"), false);
	assert.equal(JSON.stringify(pageObservation.entities).includes("token=secret"), false);
	assert.equal(String((pageObservation.content as Record<string, unknown>).preview).includes("INV-2026-0001"), true);
	const artifact = JSON.parse(await readFile(saved!.path as string, "utf8")) as Record<string, unknown>;
	assert.equal(JSON.stringify(artifact).includes("INV-2026-0001"), true);
	assert.equal(preferredReads.some((read) => read.jsonPath === "pageObservation.content" && read.kind === "content-digest"), true);
	assert.equal(preferredReads.some((read) => read.jsonPath === "pageObservation.text" && read.kind === "text-index"), true);
});

test("observe scan runner diagnostics: ABML read failure binds structure failure while scan-backed providers remain truthful", async () => {
	const { pageObservation } = await runObserve({ noDefaultTab: true });
	const diagnostics = pageObservation.diagnostics as Record<string, unknown>;
	assert.deepEqual(diagnostics.providers, {
		structure: "failed",
		content: "scan-backed",
		text: "scan-backed",
		html: "scan-backed",
		evidence: "scan-backed",
		tabs: "executed",
	});
	const failures = diagnostics.providerFailures as Array<Record<string, unknown>>;
	assert.equal(failures.some((failure) => failure.provider === "abml-read"), true);
	assert.equal(diagnostics.abmlIntegrated, false);
});

test("observe scan runner diagnostics: tabs refresh fallback is degraded with structured reason", async () => {
	const { server, pageObservation } = await runObserve({ refreshTabsFails: true, tabRefreshError: Object.assign(new Error("tabs timeout"), { code: "TABS_TIMEOUT" }) });
	const diagnostics = pageObservation.diagnostics as Record<string, unknown>;
	assert.equal(server.calls.refreshTabs, 1);
	assert.equal(server.calls.getTabs, 1);
	assert.equal((diagnostics.providers as Record<string, unknown>).tabs, "degraded");
	const failures = diagnostics.providerFailures as Array<Record<string, unknown>>;
	assert.equal(failures.some((failure) => failure.provider === "tabs-refresh" && failure.code === "TABS_TIMEOUT"), true);
});

test("observe scan runner diagnostics: unavailable artifact marks html and evidence providers failed", async () => {
	const { pageObservation } = await runObserve({ cwd: undefined }, { outputPath: "" });
	const diagnostics = pageObservation.diagnostics as Record<string, unknown>;
	assert.equal((diagnostics.providers as Record<string, unknown>).html, "failed");
	assert.equal((diagnostics.providers as Record<string, unknown>).evidence, "failed");
	assert.equal(((pageObservation.content as Record<string, unknown>).artifact), undefined);
	const failures = diagnostics.providerFailures as Array<Record<string, unknown>>;
	assert.equal(failures.some((failure) => failure.provider === "artifact" && failure.code === "ARTIFACT_UNAVAILABLE"), true);
});

test("observe readability content provider: default canonical observe does not run or imply readability", async () => {
	const { server, pageObservation } = await runObserve();
	const diagnostics = pageObservation.diagnostics as Record<string, unknown>;
	assert.equal(server.calls.readability, 0);
	assert.equal(diagnostics.readability, undefined);
	assert.equal((diagnostics.providers as Record<string, unknown>).readability, undefined);
	assert.equal((diagnostics.providerBudgetTelemetry as Array<Record<string, unknown>>).some((item) => item.provider === "readability"), false);
});

test("observe readability content provider: explicit request adds bounded content artifact without changing structural model", async () => {
	const baseline = await runObserve({ content: boilerplateHeavyFallback });
	const { server, envelope, pageObservation, saved } = await runObserve({ content: boilerplateHeavyFallback }, { content: "readability", params: { readabilityMaxInlineChars: 40 } });
	const diagnostics = pageObservation.diagnostics as Record<string, unknown>;
	const providers = diagnostics.providers as Record<string, unknown>;
	const readability = diagnostics.readability as Record<string, unknown>;
	assert.equal(server.calls.readability, 1);
	assert.equal(providers.readability, "executed");
	assert.equal(readability.status, "executed");
	const readabilityTelemetry = (diagnostics.providerBudgetTelemetry as Array<Record<string, unknown>>).find((item) => item.provider === "readability") as Record<string, unknown>;
	assert.deepEqual(readabilityTelemetry, {
		provider: "readability",
		status: "executed",
		requested: true,
		durationMs: 11,
		counts: { textLength: 186, contentLength: 278 },
		budget: { maxInlineChars: 120 },
		truncated: false,
		degraded: false,
		artifact: { path: saved?.path, jsonPath: "readability", kind: "readability-content" },
	});
	assert.equal(JSON.stringify(readabilityTelemetry).includes("City council approved"), false);
	assert.equal(JSON.stringify(readabilityTelemetry).includes("token=secret"), false);
	assert.equal(readability.title, articleFixture.title);
	assert.equal(readability.byline, articleFixture.byline);
	assert.equal(readability.siteName, articleFixture.siteName);
	assert.equal(String(readability.textPreview).includes("City council approved"), true);
	assert.equal(String(readability.textPreview).includes("Subscribe now"), false);
	assertNotIncludes(readability, "token=secret");
	assertNotIncludes(readability, "Bearer abc123");
	assert.deepEqual(JSON.parse(JSON.stringify(pageObservation.actionables)), JSON.parse(JSON.stringify(baseline.pageObservation.actionables)));
	assert.deepEqual(JSON.parse(JSON.stringify(pageObservation.refs)), JSON.parse(JSON.stringify(baseline.pageObservation.refs)));
	assert.deepEqual((pageObservation.entities as Array<Record<string, unknown>>).map((entity) => ({ ref: entity.ref, name: entity.name, role: entity.role, source: entity.source })), (baseline.pageObservation.entities as Array<Record<string, unknown>>).map((entity) => ({ ref: entity.ref, name: entity.name, role: entity.role, source: entity.source })), "readability must not alter structural entity identity");
	assert.equal(saved?.path && typeof saved.path === "string", true);
	const artifact = JSON.parse(await readFile(saved!.path as string, "utf8")) as Record<string, unknown>;
	const readabilityArtifactValue = readabilityArtifact(artifact);
	const article = readabilityArticle(artifact);
	assert.equal((readabilityArtifactValue.summary as Record<string, unknown>).status, "executed");
	assert.deepEqual(readabilityArtifactValue.bounded, { maxInlineChars: 120 });
	assert.equal(typeof article.content, "string");
	assert.equal(String(article.textContent).includes("City council approved"), true);
	assert.equal(String(article.textContent).includes("Subscribe now"), false);
	assertNotIncludes(article, "token=secret");
	assertNotIncludes(article, "Bearer abc123");
	assertNotIncludes(envelope, "token=secret");
	assertNotIncludes(envelope, "Bearer abc123");
	assertNotIncludes(pageObservation.actionables ?? [], "City council approved");
	assertNotIncludes(pageObservation.refs ?? [], "City council approved");
	assertNotIncludes(pageObservation.entities ?? [], "City council approved");
});

test("observe readability content provider: null result degrades provider and keeps scan-backed content fallback", async () => {
	const { server, pageObservation } = await runObserve({ readabilityPayload: readabilityPayload(null) }, { readability: true });
	const diagnostics = pageObservation.diagnostics as Record<string, unknown>;
	assert.equal(server.calls.readability, 1);
	assert.equal((diagnostics.providers as Record<string, unknown>).readability, "degraded");
	assert.equal((diagnostics.providers as Record<string, unknown>).content, "scan-backed");
	assert.equal((diagnostics.readability as Record<string, unknown>).status, "degraded");
	const readabilityTelemetry = (diagnostics.providerBudgetTelemetry as Array<Record<string, unknown>>).find((item) => item.provider === "readability") as Record<string, unknown>;
	assert.equal(readabilityTelemetry.status, "degraded");
	assert.equal(readabilityTelemetry.reason, "READABILITY_NULL");
	assert.equal(readabilityTelemetry.errorCode, "READABILITY_NULL");
	assert.equal(readabilityTelemetry.degraded, true);
	assertProviderFailure(diagnostics, "readability", "READABILITY_NULL");
	assert.equal(String((pageObservation.content as Record<string, unknown>).preview).includes("Checkout content"), true);
});

test("observe readability content provider: failure is content-plane-only and preserves canonical structure", async () => {
	const { server, pageObservation } = await runObserve({ readabilityThrows: true }, { params: { readability: true } });
	const diagnostics = pageObservation.diagnostics as Record<string, unknown>;
	assert.equal(server.calls.readability, 1);
	assert.equal((diagnostics.providers as Record<string, unknown>).readability, "failed");
	assert.equal((diagnostics.readability as Record<string, unknown>).status, "failed");
	assertProviderFailure(diagnostics, "readability", "READABILITY_PROVIDER_UNAVAILABLE");
	assert.equal((diagnostics.providers as Record<string, unknown>).content, "scan-backed");
	assert.equal((diagnostics.providers as Record<string, unknown>).text, "scan-backed");
	assert.equal(Array.isArray(pageObservation.refs), true);
	assert.equal(Array.isArray(pageObservation.entities), true);
});

test("observe readability content provider: timeout degrades honestly without failing observe", async () => {
	const { server, pageObservation, saved } = await runObserve({ readabilityPayload: { ok: false, timedOut: true, elapsedMs: 250, error: { code: "READABILITY_TIMEOUT", message: "slow article parse" } } }, { readability: true });
	const diagnostics = pageObservation.diagnostics as Record<string, unknown>;
	const readability = diagnostics.readability as Record<string, unknown>;
	assert.equal(server.calls.readability, 1);
	assert.equal((diagnostics.providers as Record<string, unknown>).readability, "degraded");
	assert.equal(readability.status, "degraded");
	assert.equal(readability.timedOut, true);
	assert.equal(readability.degraded, true);
	assert.equal(saved?.path && typeof saved.path === "string", true);
	const artifact = JSON.parse(await readFile(saved!.path as string, "utf8")) as Record<string, unknown>;
	assert.equal("readability" in artifact, false);
	assertProviderFailure(diagnostics, "readability", "READABILITY_TIMEOUT");
	assert.equal((diagnostics.providers as Record<string, unknown>).content, "scan-backed");
});

test("observe readability content provider: summary bounding strips unsafe artifact html and redacts sensitive values", async () => {
	const longText = `${"Article sentence ".repeat(80)}token=secret Authorization: Bearer abc123`;
	const { envelope, pageObservation, saved } = await runObserve({ readabilityPayload: readabilityPayload({ ...articleFixture, excerpt: longText, textContent: longText, content: `<article><script>token=secret</script><style>.secret{color:red}</style><p>${longText}</p></article>`, textLength: longText.length, contentLength: longText.length + 92 }) }, { content: "readability", params: { readabilityMaxInlineChars: 140 } });
	const diagnostics = pageObservation.diagnostics as Record<string, unknown>;
	const readability = diagnostics.readability as Record<string, unknown>;
	assert.equal((diagnostics.providers as Record<string, unknown>).readability, "executed");
	assert.ok(String(readability.excerpt).length < longText.length);
	assert.ok(String(readability.textPreview).length < longText.length);
	assertNotIncludes(readability, "token=secret");
	assertNotIncludes(readability, "Bearer abc123");
	const artifact = JSON.parse(await readFile(saved!.path as string, "utf8")) as Record<string, unknown>;
	const article = readabilityArticle(artifact);
	assertNotIncludes(article, "<script");
	assertNotIncludes(article, "<style");
	assertNotIncludes(article, "token=secret");
	assertNotIncludes(article, "Bearer abc123");
	assertNotIncludes(envelope, "token=secret");
	assertNotIncludes(envelope, "Bearer abc123");
});

test("observe axe diagnostics: default canonical observe does not run or imply axe", async () => {
	const { server, pageObservation } = await runObserve();
	const diagnostics = pageObservation.diagnostics as Record<string, unknown>;
	assert.equal(server.calls.axe, 0);
	assert.equal(diagnostics.axe, undefined);
	assert.equal((diagnostics.providers as Record<string, unknown>).axe, undefined);
	assert.equal((diagnostics.providerBudgetTelemetry as Array<Record<string, unknown>>).some((item) => item.provider === "axe"), false);
});

test("observe axe diagnostics: explicit request adds bounded summary and artifact without changing structural model", async () => {
	const axePayload = {
		ok: true,
		elapsedMs: 18,
		result: {
			testEngine: { name: "axe-core", version: "4.test" },
			violations: [
				{ id: "color-contrast", impact: "serious", description: "Password token=secret should redact", help: "Improve contrast", helpUrl: "https://deque.example/rules/color-contrast", nodes: [{ html: "<input value=secret>", target: ["#password"], any: [{}], all: [], none: [] }] },
				{ id: "label", impact: "critical", description: "Needs label", help: "Add labels", helpUrl: "https://deque.example/rules/label", nodes: [{ target: ["#name"] }] },
				{ id: "aria-valid-attr", impact: "minor", description: "ARIA token=secret should redact", help: "Fix ARIA", helpUrl: "https://deque.example/rules/aria-valid-attr", nodes: [{ target: ["#aria"] }] },
			],
			incomplete: [],
			passes: [{}],
			inapplicable: [{}, {}],
		},
	};
	const baseline = await runObserve();
	const { server, envelope, pageObservation, saved } = await runObserve({ axePayload }, { axeDiagnostics: true, params: { axeMaxResults: 2 } });
	const diagnostics = pageObservation.diagnostics as Record<string, unknown>;
	const providers = diagnostics.providers as Record<string, unknown>;
	const axe = diagnostics.axe as Record<string, unknown>;
	const samples = axe.samples as Array<Record<string, unknown>>;
	assert.equal(server.calls.axe, 1);
	assert.equal(providers.axe, "executed");
	assert.equal(axe.status, "executed");
	assert.deepEqual(axe.counts, { violations: 3, incomplete: 0, passes: 1, inapplicable: 2 });
	const telemetry = diagnostics.providerBudgetTelemetry as Array<Record<string, unknown>>;
	const axeTelemetry = telemetry.find((item) => item.provider === "axe") as Record<string, unknown>;
	assert.deepEqual(axeTelemetry, {
		provider: "axe",
		status: "executed",
		requested: true,
		durationMs: 18,
		counts: { violations: 3, incomplete: 0, passes: 1, inapplicable: 2 },
		budget: { maxInlineResults: 2 },
		degraded: false,
		artifact: { path: saved?.path, jsonPath: "axe", kind: "axe-core-diagnostics" },
	});
	assert.equal(JSON.stringify(axeTelemetry).includes("<input value=secret>"), false);
	assert.equal(JSON.stringify(axeTelemetry).includes("samples"), false);
	assert.equal(JSON.stringify(axeTelemetry).includes("color-contrast"), false);
	assert.deepEqual(axe.impactCounts, { critical: 1, minor: 1, serious: 1 });
	assert.deepEqual(axe.ruleCounts, { "aria-valid-attr": 1, "color-contrast": 1, label: 1 });
	assert.equal(samples.length, 2);
	assert.equal("html" in samples[0], false);
	assert.equal(JSON.stringify(samples).includes("secret"), false);
	assert.deepEqual(JSON.parse(JSON.stringify(pageObservation.actionables)), JSON.parse(JSON.stringify(baseline.pageObservation.actionables)));
	assert.deepEqual(JSON.parse(JSON.stringify(pageObservation.refs)), JSON.parse(JSON.stringify(baseline.pageObservation.refs)));
	assert.deepEqual((pageObservation.entities as Array<Record<string, unknown>>).map((entity) => ({ ref: entity.ref, name: entity.name, role: entity.role, source: entity.source })), (baseline.pageObservation.entities as Array<Record<string, unknown>>).map((entity) => ({ ref: entity.ref, name: entity.name, role: entity.role, source: entity.source })), "axe must not alter structural entity identity");
	assert.equal(saved?.path && typeof saved.path === "string", true);
	const artifact = JSON.parse(await readFile(saved!.path as string, "utf8")) as Record<string, unknown>;
	assert.equal(((artifact.axe as Record<string, unknown>).summary as Record<string, unknown>).status, "executed");
	assert.equal(Array.isArray(((artifact.axe as Record<string, unknown>).result as Record<string, unknown>).violations), true);
	assert.deepEqual((artifact.axe as Record<string, unknown>).bounded, { maxInlineResults: 2 });
	assert.equal(JSON.stringify(envelope).includes("<input value=secret>"), false);
});

test("observe axe diagnostics: timeout degrades provider without failing observe", async () => {
	const { pageObservation } = await runObserve({ axePayload: { ok: false, timedOut: true, error: { code: "AXE_TIMEOUT", message: "slow axe" } } }, { diagnostics: "axe" });
	const diagnostics = pageObservation.diagnostics as Record<string, unknown>;
	assert.equal((diagnostics.providers as Record<string, unknown>).axe, "degraded");
	assert.equal((diagnostics.axe as Record<string, unknown>).timedOut, true);
	const axeTelemetry = (diagnostics.providerBudgetTelemetry as Array<Record<string, unknown>>).find((item) => item.provider === "axe") as Record<string, unknown>;
	assert.equal(axeTelemetry.status, "degraded");
	assert.equal(axeTelemetry.requested, true);
	assert.equal(axeTelemetry.reason, "AXE_TIMEOUT");
	assert.equal(axeTelemetry.errorCode, "AXE_TIMEOUT");
	assert.equal(axeTelemetry.degraded, true);
	const failures = diagnostics.providerFailures as Array<Record<string, unknown>>;
	assert.equal(failures.some((failure) => failure.provider === "axe" && failure.code === "AXE_TIMEOUT"), true);
	assert.equal(Array.isArray(pageObservation.refs), true);
});

test("observe axe diagnostics: failed provider stays honest and preserves core observe", async () => {
	const { server, pageObservation } = await runObserve({ axeThrows: true }, { debug: "axe" });
	const diagnostics = pageObservation.diagnostics as Record<string, unknown>;
	const axe = diagnostics.axe as Record<string, unknown>;
	const failures = diagnostics.providerFailures as Array<Record<string, unknown>>;
	assert.equal(server.calls.axe, 1);
	assert.equal((diagnostics.providers as Record<string, unknown>).axe, "failed");
	assert.equal(axe.status, "failed");
	assert.equal((axe.error as Record<string, unknown>).code, "AXE_PROVIDER_UNAVAILABLE");
	assert.equal((axe.error as Record<string, unknown>).message, "axe provider unavailable");
	assert.equal(failures.some((failure) => failure.provider === "axe" && failure.code === "AXE_PROVIDER_UNAVAILABLE"), true);
	assert.equal(Array.isArray(pageObservation.refs), true);
});

test("observe axe diagnostics: incomplete axe results degrade provider honestly", async () => {
	const axePayload = {
		ok: true,
		elapsedMs: 9,
		result: {
			testEngine: { name: "axe-core", version: "4.test" },
			violations: [],
			incomplete: [{ id: "aria-hidden-focus", impact: "serious" }],
			passes: [],
			inapplicable: [],
		},
	};
	const { pageObservation } = await runObserve({ axePayload }, { diagnostics: "accessibility" });
	const diagnostics = pageObservation.diagnostics as Record<string, unknown>;
	const axe = diagnostics.axe as Record<string, unknown>;
	assert.equal((diagnostics.providers as Record<string, unknown>).axe, "degraded");
	assert.equal(axe.status, "degraded");
	assert.equal(axe.degraded, true);
	assert.deepEqual(axe.counts, { violations: 0, incomplete: 1, passes: 0, inapplicable: 0 });
});
