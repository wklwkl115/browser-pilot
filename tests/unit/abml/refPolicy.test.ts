import test from "node:test";
import assert from "node:assert/strict";
import { decideRefAccess, defaultRefPolicyForKind } from "../../../src/abml/refPolicy.ts";
import type { RefDescriptor, ResolveContext } from "../../../src/abml/types.ts";

function makeContext(overrides: Partial<ResolveContext> = {}): ResolveContext {
	return {
		browserSessionId: "session-a",
		tabId: 7,
		topLevelOrigin: "https://shop.test",
		now: 2_000,
		requestedRedaction: "default",
		explicitSensitiveAccess: false,
		...overrides,
	};
}

function makeRef(overrides: Partial<RefDescriptor> = {}): RefDescriptor {
	return {
		refId: "pi-ref://fixture",
		kind: "element",
		locators: [{ by: "css", value: "button[data-testid='buy']" }],
		owner: { browserSessionId: "session-a", tabId: 7, topLevelOrigin: "https://shop.test" },
		policy: defaultRefPolicyForKind("element"),
		observationId: "obs-1",
		createdAt: 1_000,
		ttlMs: 5_000,
		...overrides,
	};
}

test("refPolicy default policies follow kind matrix", () => {
	assert.deepEqual(defaultRefPolicyForKind("element"), { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: true });
	assert.deepEqual(defaultRefPolicyForKind("control"), { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: true });
	assert.deepEqual(defaultRefPolicyForKind("frame"), { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: true });
	assert.deepEqual(defaultRefPolicyForKind("region"), { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: true });
	assert.deepEqual(defaultRefPolicyForKind("text"), { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: false });
	assert.deepEqual(defaultRefPolicyForKind("network-entry"), { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: false });
	assert.deepEqual(defaultRefPolicyForKind("data-slice"), { redaction: "default", shareableAcrossSessions: true, liveActionsAllowed: false });
	assert.deepEqual(defaultRefPolicyForKind("data-slice", { hasOwnerBinding: true }), { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: false });
	assert.deepEqual(defaultRefPolicyForKind("data-slice", { sensitive: true }), { redaction: "disabled", shareableAcrossSessions: false, liveActionsAllowed: false });
});

test("refPolicy same-session default access returns redacted mode", () => {
	const decision = decideRefAccess(makeRef(), makeContext());
	assert.deepEqual(decision, { ok: true, mode: "redacted", sameSession: true });
});

test("refPolicy raw sensitive access requires same-session explicit opt-in", () => {
	const ref = makeRef({ kind: "data-slice", locators: [], policy: defaultRefPolicyForKind("data-slice", { sensitive: true }), owner: { browserSessionId: "session-a", topLevelOrigin: "https://shop.test" } });
	const blocked = decideRefAccess(ref, makeContext({ requestedRedaction: "disabled", explicitSensitiveAccess: false }));
	assert.equal(blocked.ok, false);
	assert.equal(blocked.code, "PRIVACY_BLOCKED");
	const allowed = decideRefAccess(ref, makeContext({ requestedRedaction: "disabled", explicitSensitiveAccess: true }));
	assert.deepEqual(allowed, { ok: true, mode: "raw", sameSession: true });
});

test("refPolicy non-sensitive default policy can allow same-session raw when explicitly requested", () => {
	const ref = makeRef({ kind: "data-slice", locators: [], policy: defaultRefPolicyForKind("data-slice", { hasOwnerBinding: true, sensitive: false }), owner: { browserSessionId: "session-a", topLevelOrigin: "https://shop.test" } });
	const allowed = decideRefAccess(ref, makeContext({ requestedRedaction: "disabled", explicitSensitiveAccess: true }), { sensitive: false });
	assert.deepEqual(allowed, { ok: true, mode: "raw", sameSession: true });
});

test("refPolicy rejects cross-session live refs with scope violation", () => {
	const decision = decideRefAccess(makeRef(), makeContext({ browserSessionId: "session-b" }));
	assert.equal(decision.ok, false);
	assert.equal(decision.code, "REF_SCOPE_VIOLATION");
});

test("refPolicy enforces ttl, resource existence, expiration, and etag freshness", () => {
	const baseRef = makeRef();
	assert.equal(decideRefAccess(baseRef, makeContext({ now: 7_000 })).code, "REF_STALE");
	assert.equal(decideRefAccess(baseRef, makeContext(), { resourceFound: false }).code, "HANDLE_NOT_FOUND");
	assert.equal(decideRefAccess(baseRef, makeContext(), { resourceExpired: true }).code, "HANDLE_EXPIRED");
	assert.equal(decideRefAccess(baseRef, makeContext(), { etagMatches: false }).code, "HANDLE_ETAG_MISMATCH");
});
