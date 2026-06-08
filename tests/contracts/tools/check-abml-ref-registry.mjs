/**
 * ABML ref registry contract (P2).
 *
 * Verifies the reusable pi-ref:// registry that lives in src/resources/resourceStore:
 * - resourceStore exposes pi-ref:// parse/resolve/register APIs while keeping browser-result:// compatibility
 * - browser-result:// resolves as a data-slice pi-ref wrapper
 * - explicit pi-ref:// data-slice registration works with resource-backed snapshot metadata
 * - TTL expiry maps to REF_STALE through the ref registry path
 *
 * NOTE: the MCP ingress-handle resolver (mcp/handleResolver.ts, resolveIngressHandles)
 * was an MCP-frontend-only feature (it ran in the MCP tools/call wrapper, never in the
 * Pi-native path) and is removed with the MCP shell. Its redaction/scope behavior is
 * covered at the ref-policy layer (refPolicy unit tests).
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

const storeSrc = read("src/resources/resourceStore.ts");
assert(storeSrc.includes("PI_REF_URI_SCHEME"), "resourceStore.ts must define pi-ref URI scheme");
assert(storeSrc.includes("parsePiRefUri"), "resourceStore.ts must export parsePiRefUri");
assert(storeSrc.includes("registerRefDescriptor"), "resourceStore.ts must export registerRefDescriptor");
assert(storeSrc.includes("resolveRefUriDetailed"), "resourceStore.ts must export resolveRefUriDetailed");
assert(storeSrc.includes("kind: \"data-slice\""), "resourceStore.ts must wrap browser-result resources as data-slice refs");

const {
	registerBrowserResultResource,
	registerRefDescriptor,
	resolveRefUriDetailed,
	parsePiRefUri,
	clearResourceStore,
	REF_STORE_MAX_ENTRIES,
} = await import(new URL("../../../src/resources/resourceStore.ts", import.meta.url).href);

const dir = mkdtempSync(path.join(tmpdir(), "abml-ref-registry-"));
const artifactPath = path.join(dir, "request.json");
writeFileSync(artifactPath, JSON.stringify({ data: { url: "https://target.example.test/pay", method: "POST", body: "x=1" } }), "utf8");

// 1. browser-result:// still registers, and also resolves as a data-slice pi-ref wrapper.
const browserResultUri = registerBrowserResultResource({
	kind: "http-request",
	artifactPath,
	name: "captured request",
	mime: "application/json",
	browserSessionId: "session-a",
});
const wrappedPiRef = `pi-ref://data-slice/${browserResultUri.split("://")[1]}`;
const wrappedResolved = resolveRefUriDetailed(wrappedPiRef);
assert(wrappedResolved.ok, `wrapped browser-result resource must resolve as pi-ref data-slice: ${wrappedResolved.ok ? "" : wrappedResolved.error}`);
assert.equal(wrappedResolved.ref.descriptor.kind, "data-slice", "wrapped browser-result resource must become data-slice ref");
assert.equal(wrappedResolved.ref.descriptor.snapshot?.resourceUri, browserResultUri, "wrapped resource must point back to browser-result URI");
assert.equal(wrappedResolved.ref.resourceKind, "http-request", "wrapped ref must preserve underlying resource kind");
assert.equal(wrappedResolved.ref.descriptor.policy.shareableAcrossSessions, false, "session-bound browser-result wrapper must not be cross-session shareable");

// 2. explicit pi-ref:// registration keeps descriptor metadata and can point at browser-result snapshot.
const explicitRef = registerRefDescriptor({
	descriptor: {
		kind: "data-slice",
		locators: [],
		owner: { browserSessionId: "session-a", topLevelOrigin: "https://target.example.test" },
		policy: { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: false },
		snapshot: {
			observationId: "obs-1",
			resourceUri: browserResultUri,
			jsonPath: "data",
			etag: wrappedResolved.ref.etag,
			immutable: true,
		},
		observationId: "obs-1",
		createdAt: Date.now(),
		ttlMs: 60_000,
	},
	artifactPath,
	resourceKind: "http-request",
	name: "explicit request ref",
});
const explicitParsed = parsePiRefUri(explicitRef);
assert(explicitParsed?.kind === "data-slice", "explicit ref must use pi-ref://data-slice/* URI shape");
const explicitResolved = resolveRefUriDetailed(explicitRef);
assert(explicitResolved.ok, `explicit pi-ref must resolve: ${explicitResolved.ok ? "" : explicitResolved.error}`);
assert.equal(explicitResolved.ref.descriptor.snapshot?.resourceUri, browserResultUri, "explicit ref must retain backing resource URI");
assert.equal(explicitResolved.ref.resourceKind, "http-request", "explicit ref must preserve declared resource kind");

// 3. TTL expiry on the pi-ref path maps to REF_STALE.
const staleRef = registerRefDescriptor({
	descriptor: {
		kind: "data-slice",
		locators: [],
		owner: {},
		policy: { redaction: "default", shareableAcrossSessions: true, liveActionsAllowed: false },
		snapshot: { observationId: "obs-4", immutable: true },
		observationId: "obs-4",
		createdAt: Date.now() - 5_000,
		ttlMs: 1,
	},
	artifactPath,
	resourceKind: "http-request",
	name: "stale ref",
});
const staleResolved = resolveRefUriDetailed(staleRef);
assert(!staleResolved.ok, "expired pi-ref must not resolve");
assert.equal(staleResolved.code, "REF_STALE", "expired pi-ref must fail with REF_STALE");

// 4. Burst registration is bounded by a size cap; oldest live refs are evicted first.
clearResourceStore();
const capNow = Date.now();
const oldLiveRef = registerRefDescriptor({
	descriptor: {
		kind: "data-slice",
		locators: [],
		owner: {},
		policy: { redaction: "default", shareableAcrossSessions: true, liveActionsAllowed: false },
		snapshot: { observationId: "obs-old", immutable: true },
		observationId: "obs-old",
		createdAt: capNow,
		ttlMs: 60_000_000,
	},
	artifactPath,
	resourceKind: "http-request",
	name: "old live ref",
});
let newestRef = "";
for (let i = 0; i < REF_STORE_MAX_ENTRIES; i += 1) {
	newestRef = registerRefDescriptor({
		descriptor: {
			kind: "data-slice",
			locators: [],
			owner: {},
			policy: { redaction: "default", shareableAcrossSessions: true, liveActionsAllowed: false },
			snapshot: { observationId: `obs-cap-${i}`, immutable: true },
			observationId: `obs-cap-${i}`,
			createdAt: capNow + 1 + i,
			ttlMs: 60_000_000,
		},
		artifactPath,
		resourceKind: "http-request",
		name: `cap ref ${i}`,
	});
}
const oldLiveResolved = resolveRefUriDetailed(oldLiveRef);
assert(!oldLiveResolved.ok, "oldest live pi-ref must be evicted when the ref store exceeds its cap");
assert.equal(oldLiveResolved.code, "HANDLE_NOT_FOUND", "capacity-evicted live pi-ref must use the documented not-found recovery path");
const newestResolved = resolveRefUriDetailed(newestRef);
assert(newestResolved.ok, "newest pi-ref must remain resolvable after capacity enforcement");

clearResourceStore();
console.log("abml ref registry ok");
