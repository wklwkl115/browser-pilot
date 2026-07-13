import assert from "node:assert/strict";
import test from "node:test";
import {
	actionRequiresConfirmation,
	redactedSemanticActionForDigest,
	verifyActionConfirmation,
} from "../../src/kernels/agent/actionConfirmation.js";
import {
	ActionConfirmationService,
	semanticActionDigest,
} from "../../src/apps/daemon/ActionConfirmationService.js";

test("fill value is never included in digest material", () => {
	const redacted = redactedSemanticActionForDigest({
		kind: "fill",
		ref: "a_01",
		value: "super-secret-password",
	});
	assert.equal(Object.prototype.hasOwnProperty.call(redacted, "value"), false);
	assert.equal(redacted.valueLength, "super-secret-password".length);
	const dig = semanticActionDigest({ kind: "fill", ref: "a_01", value: "super-secret-password" });
	const dig2 = semanticActionDigest({ kind: "fill", ref: "a_01", value: "different-secret-!!!" });
	// lengths differ → digests differ; plaintext never appears
	assert.notEqual(dig, dig2);
	assert.doesNotMatch(JSON.stringify(redacted), /super-secret|password/);
});

test("submit and navigate require confirmation", () => {
	assert.equal(actionRequiresConfirmation({ action: { kind: "submit", ref: "a_01" } }).required, true);
	assert.equal(actionRequiresConfirmation({ action: { kind: "navigate", url: "https://x.test/" } }).required, true);
	assert.equal(actionRequiresConfirmation({ action: { kind: "fill", ref: "a_01", value: "x" } }).required, false);
	assert.equal(actionRequiresConfirmation({
		action: { kind: "activate", ref: "a_01" },
		candidateRisk: "irreversible",
	}).required, true);
});

test("one-shot confirmation: mismatch expired consumed", () => {
	let now = 1_000;
	const svc = new ActionConfirmationService({ now: () => now });
	const action = { kind: "submit" as const, ref: "a_01" };
	const minted = svc.mint({
		owner: "owner-a",
		contextRef: "ctx1",
		contextRevision: 2,
		pageIdentity: {
			browserSessionId: "s",
			tabId: 1,
			targetGeneration: 1,
			pageEpoch: "e",
			url: "https://x.test/",
		},
		action,
		reason: "form_submit",
		ttlMs: 5_000,
	});

	const ok = svc.consume({
		confirmationRef: minted.confirmationRef,
		owner: "owner-a",
		contextRef: "ctx1",
		contextRevision: 2,
		pageIdentity: {
			browserSessionId: "s",
			tabId: 1,
			targetGeneration: 1,
			pageEpoch: "e",
			url: "https://x.test/",
		},
		action,
	});
	assert.equal(ok.kind, "authorized");

	const consumed = svc.consume({
		confirmationRef: minted.confirmationRef,
		owner: "owner-a",
		contextRef: "ctx1",
		contextRevision: 2,
		pageIdentity: {
			browserSessionId: "s",
			tabId: 1,
			targetGeneration: 1,
			pageEpoch: "e",
			url: "https://x.test/",
		},
		action,
	});
	assert.equal(consumed.kind, "mismatch"); // deleted after consume → not found

	const minted2 = svc.mint({
		owner: "owner-a",
		contextRef: "ctx1",
		contextRevision: 2,
		action: { kind: "navigate", url: "https://x.test/pay" },
		reason: "navigation",
		ttlMs: 1_000,
	});
	now = 10_000;
	const expired = svc.consume({
		confirmationRef: minted2.confirmationRef,
		owner: "owner-a",
		contextRef: "ctx1",
		contextRevision: 2,
		action: { kind: "navigate", url: "https://x.test/pay" },
	});
	assert.equal(expired.kind, "expired");

	const minted3 = svc.mint({
		owner: "owner-a",
		contextRef: "ctx1",
		contextRevision: 2,
		action: { kind: "submit", ref: "a_01" },
		reason: "form_submit",
	});
	const wrongOwner = svc.consume({
		confirmationRef: minted3.confirmationRef,
		owner: "owner-b",
		contextRef: "ctx1",
		contextRevision: 2,
		action: { kind: "submit", ref: "a_01" },
	});
	assert.equal(wrongOwner.kind, "mismatch");

	// pure verify consumed state
	const decision = verifyActionConfirmation({
		record: { ...minted, consumedAt: 5_000 },
		now: 6_000,
		ownerPairingDigest: minted.ownerPairingDigest,
		contextRefDigest: minted.contextRefDigest,
		contextRevision: minted.contextRevision,
		pageIdentityDigest: minted.pageIdentityDigest,
		semanticActionDigest: minted.semanticActionDigest,
	});
	assert.equal(decision.kind, "consumed");
});
