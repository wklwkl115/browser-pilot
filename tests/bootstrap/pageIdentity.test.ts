import test from "node:test";
import assert from "node:assert/strict";
import { pageReanchorReason, samePageIdentity, type PageIdentity } from "../../src/kernels/session/pageIdentity.ts";
import { PerceptionLedger } from "../../src/kernels/session/perceptionLedger.ts";
import { SessionObservationSnapshotRegistry } from "../../src/kernels/session/observationSnapshotRegistry.ts";
import { currentPageIdentity } from "../../src/commands/observe/pageIdentity.ts";
import {
	ensureBrowserPilotPageIdentity,
	recordBrowserPilotDocumentCommit,
	recordBrowserPilotSameDocumentUpdate,
	replaceBrowserPilotPageIdentity,
	resetBrowserPilotPageIdentitiesForTest,
} from "../../src/bridge/extension/service_worker/page_identity.ts";

function identity(overrides: Partial<PageIdentity> = {}): PageIdentity {
	return {
		browserSessionId: "session-1",
		tabId: 7,
		targetGeneration: 1,
		pageEpoch: "page-1",
		documentId: "document-1",
		url: "https://example.test/one",
		...overrides,
	};
}

test("page identity equality ignores URL facts and classifies every re-anchor boundary", () => {
	assert.equal(samePageIdentity(identity(), identity({ url: "https://example.test/spa", documentId: "diagnostic-only" })), true);
	assert.equal(pageReanchorReason(undefined, identity()), "baseline_missing");
	assert.equal(pageReanchorReason(identity(), undefined), "identity_unproven");
	assert.equal(pageReanchorReason(identity(), identity({ browserSessionId: "session-2" })), "session_changed");
	assert.equal(pageReanchorReason(identity(), identity({ targetGeneration: 2 })), "target_replaced");
	assert.equal(pageReanchorReason(identity(), identity({ pageEpoch: "page-2" })), "document_changed");
	assert.equal(pageReanchorReason(identity(), identity({ url: "https://example.test/spa" })), undefined);
});

test("extension epochs advance on document commits and replacement, preserve SPA, and reuse proven BFCache lineage", () => {
	resetBrowserPilotPageIdentitiesForTest();
	const initial = ensureBrowserPilotPageIdentity(7, "https://example.test/a");
	assert.ok(initial?.pageEpoch);
	const spa = recordBrowserPilotSameDocumentUpdate({ tabId: 7, frameId: 0, url: "https://example.test/a?route=2" });
	assert.equal(spa?.pageEpoch, initial?.pageEpoch);

	const documentA = recordBrowserPilotDocumentCommit({ tabId: 7, frameId: 0, documentId: "doc-a", url: "https://example.test/a" });
	const documentB = recordBrowserPilotDocumentCommit({ tabId: 7, frameId: 0, documentId: "doc-b", url: "https://example.test/b" });
	assert.notEqual(documentA?.pageEpoch, initial?.pageEpoch);
	assert.notEqual(documentB?.pageEpoch, documentA?.pageEpoch);
	const restoredA = recordBrowserPilotDocumentCommit({ tabId: 7, frameId: 0, documentId: "doc-a", url: "https://example.test/a" });
	assert.equal(restoredA?.pageEpoch, documentA?.pageEpoch);
	assert.equal(recordBrowserPilotDocumentCommit({ tabId: 7, frameId: 2, documentId: "child" }), undefined);

	const replacement = replaceBrowserPilotPageIdentity(7, 9, "https://example.test/a");
	assert.ok(replacement?.pageEpoch);
	assert.notEqual(replacement?.pageEpoch, restoredA?.pageEpoch);
});

test("perception ledger isolates session, target generation, and document epoch while URL is not a key", () => {
	const ledger = new PerceptionLedger();
	const key = { browserSessionId: "session-1", tabId: 7, targetGeneration: 1, pageEpoch: "page-1" };
	ledger.record({ key, snapshotId: "snap-1", capturedAt: 1, facts: {} });
	assert.equal(ledger.get({ ...key })?.snapshotId, "snap-1");
	assert.equal(ledger.get({ ...key, browserSessionId: "session-2" }), undefined);
	assert.equal(ledger.get({ ...key, targetGeneration: 2 }), undefined);
	assert.equal(ledger.get({ ...key, pageEpoch: "page-2" }), undefined);
	ledger.record({ key: { ...key, pageEpoch: "page-2" }, snapshotId: "snap-2", capturedAt: 2, facts: {} });
	assert.equal(ledger.get(key), undefined);
	assert.equal(ledger.get({ ...key, pageEpoch: "page-2" })?.snapshotId, "snap-2");
});

test("observation snapshot registry keeps a bounded recent window", () => {
	const registry = new SessionObservationSnapshotRegistry();
	for (let index = 0; index < 300; index += 1) registry.create({ snapshotId: `snapshot-${index}`, sourceMode: "scan", capturedAt: Date.now(), ttlMs: 300_000 });
	assert.equal(registry.list().length, 256);
	assert.equal(registry.get("snapshot-0"), undefined);
	assert.equal(registry.get("snapshot-299")?.snapshotId, "snapshot-299");
});

test("a live fingerprint that disagrees with the tab epoch makes identity unproven", () => {
	const server = {
		snapshot: () => ({
			browserSessionId: "session-1",
			defaultTabId: 7,
			tabs: [{ tabId: 7, targetGeneration: 2, pageEpoch: "page-new", url: "https://example.test/new" }],
		}),
	};
	assert.equal(currentPageIdentity(server as never, { tabId: 7 }, { pageEpoch: "page-old", url: "https://example.test/old" }), undefined);
	assert.deepEqual(currentPageIdentity(server as never, { tabId: 7 }, { pageEpoch: "page-new", url: "https://example.test/spa" }), {
		browserSessionId: "session-1",
		tabId: 7,
		targetGeneration: 2,
		pageEpoch: "page-new",
		url: "https://example.test/spa",
	});
});
