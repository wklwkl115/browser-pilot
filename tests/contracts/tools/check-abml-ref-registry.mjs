/**
 * ABML ref registry contract (P2).
 *
 * Verifies:
 * - resourceStore exposes pi-ref:// parse/resolve/register APIs while keeping browser-result:// compatibility
 * - browser-result:// resolves as a data-slice pi-ref wrapper
 * - explicit pi-ref:// data-slice registration works with resource-backed snapshot metadata
 * - ingress handle resolver accepts browser-result:// and pi-ref:// handles in declared fields
 * - scope/redaction/etag/TTL checks are enforced through the ref registry path
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

// resourceStore relocated to src/resources/ in the CLI migration; mcp/resourceStore.ts is now a re-export shim.
const storeSrc = read("src/resources/resourceStore.ts");
assert(storeSrc.includes("PI_REF_URI_SCHEME"), "resourceStore.ts must define pi-ref URI scheme");
assert(storeSrc.includes("parsePiRefUri"), "resourceStore.ts must export parsePiRefUri");
assert(storeSrc.includes("registerRefDescriptor"), "resourceStore.ts must export registerRefDescriptor");
assert(storeSrc.includes("resolveRefUriDetailed"), "resourceStore.ts must export resolveRefUriDetailed");
assert(storeSrc.includes("kind: \"data-slice\""), "resourceStore.ts must wrap browser-result resources as data-slice refs");

const resolverSrc = read("mcp/handleResolver.ts");
assert(resolverSrc.includes("PI_REF_URI_SCHEME"), "handleResolver.ts must recognize pi-ref:// handles");
assert(resolverSrc.includes("resolveRefUriDetailed"), "handleResolver.ts must resolve through the ref registry");
assert(resolverSrc.includes("decideRefAccess") && resolverSrc.includes("normalizeAbmlError"), "handleResolver.ts must route ref access through ABML privacy/scope normalization");

const {
	registerBrowserResultResource,
	registerRefDescriptor,
	resolveRefUriDetailed,
	parsePiRefUri,
	clearResourceStore,
} = await import(new URL("../../../src/resources/resourceStore.ts", import.meta.url).href);
const { resolveIngressHandles } = await import(new URL("../../../mcp/handleResolver.ts", import.meta.url).href);

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

// 3. ingress resolver accepts both browser-result:// and pi-ref:// handles.
const viaBrowserResult = await resolveIngressHandles("browser_sqli", { request: browserResultUri, engine: "builtin" });
assert(viaBrowserResult.ok, `browser-result handle must still resolve: ${viaBrowserResult.ok ? "" : viaBrowserResult.error}`);
assert.equal(viaBrowserResult.args.request.url, "https://target.example.test/pay", "browser-result handle must expand request payload");
const viaPiRef = await resolveIngressHandles("browser_sqli", { request: explicitRef, engine: "builtin" });
assert(viaPiRef.ok, `pi-ref handle must resolve: ${viaPiRef.ok ? "" : viaPiRef.error}`);
assert.equal(viaPiRef.args.request.url, "https://target.example.test/pay", "pi-ref handle must expand request payload");

// 4. redaction disabled + default request path is allowed only through redacted output.
const rawArtifactPath = path.join(dir, "raw-sensitive.json");
writeFileSync(rawArtifactPath, JSON.stringify({ data: { url: "https://secret.example.test/", authorization: "Bearer secret" } }), "utf8");
const sensitiveRef = registerRefDescriptor({
	descriptor: {
		kind: "data-slice",
		locators: [],
		owner: { browserSessionId: "session-a", topLevelOrigin: "https://secret.example.test" },
		policy: { redaction: "disabled", shareableAcrossSessions: false, liveActionsAllowed: false },
		snapshot: { observationId: "obs-2", immutable: true },
		observationId: "obs-2",
		createdAt: Date.now(),
		ttlMs: 60_000,
	},
	artifactPath: rawArtifactPath,
	resourceKind: "http-request",
	redaction: "disabled",
	name: "sensitive request ref",
});
const redactedSensitive = await resolveIngressHandles("browser_sqli", { request: sensitiveRef, engine: "builtin" });
assert(redactedSensitive.ok, `default ingress read must redact sensitive data-slice refs instead of exposing raw payloads: ${redactedSensitive.ok ? "" : redactedSensitive.error}`);
assert.equal(redactedSensitive.args.request.authorization, "[redacted]", "sensitive ref default path must redact authorization fields");

// 5. cross-session use of a non-shareable ref is rejected.
const crossSessionRef = registerRefDescriptor({
	descriptor: {
		kind: "data-slice",
		locators: [],
		owner: { browserSessionId: "session-a", topLevelOrigin: "https://target.example.test" },
		policy: { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: false },
		snapshot: { observationId: "obs-3", immutable: true },
		observationId: "obs-3",
		createdAt: Date.now(),
		ttlMs: 60_000,
	},
	artifactPath,
	resourceKind: "http-request",
	browserSessionId: "session-b",
	name: "cross-session request ref",
});
const blockedScope = await resolveIngressHandles("browser_sqli", { request: crossSessionRef, engine: "builtin" });
assert(!blockedScope.ok, "cross-session ref use must be rejected");
assert.equal(blockedScope.code, "REF_SCOPE_VIOLATION", "cross-session ref must fail with REF_SCOPE_VIOLATION");

// 6. TTL expiry on pi-ref path maps to REF_STALE.
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

clearResourceStore();
console.log("abml ref registry ok");
