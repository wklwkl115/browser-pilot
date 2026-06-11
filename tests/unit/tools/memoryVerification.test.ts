import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptyMemoryOriginProfile } from "../../../src/memory-core/profile.ts";
import { recordMemoryEntry, verifyMemoryEntryAgainstProfile } from "../../../src/tools/memory/store.ts";
import { writeMemoryProfile } from "../../../src/memory/profileStore.ts";
import { __resetMemoryProfileServiceForTests } from "../../../src/memory/profileService.ts";

async function tempCwd(): Promise<string> {
	return await mkdtemp(path.join(os.tmpdir(), "pi-memory-verification-"));
}

async function cleanup(cwd: string): Promise<void> {
	__resetMemoryProfileServiceForTests();
	await rm(cwd, { recursive: true, force: true });
}

test("memory record derives structural anchors from the current origin profile", async () => {
	const cwd = await tempCwd();
	try {
		const profile = emptyMemoryOriginProfile("https://shop.example");
		profile.urls = [{
			canonicalUrl: "https://shop.example/checkout",
			capturedAt: 10,
			factStamps: { "button:pay": "abc123" },
			fingerprintSummary: { changeSeq: 4, readyState: "complete" },
		}];
		await writeMemoryProfile(cwd, profile);
		const recorded = await recordMemoryEntry({
			cwd,
			payload: {
				kind: "sop",
				url: "https://shop.example/checkout?token=redacted",
				title: "Checkout flow",
				triggers: ["checkout"],
				body: "Use the checkout button after reviewing the cart.",
				evidenceRefs: [],
			},
		});
		assert.equal(recorded.entry.anchors?.canonicalUrl, "https://shop.example/checkout");
		assert.equal(recorded.entry.anchors?.fingerprintSummary?.changeSeq, 4);
		assert.match(recorded.entry.anchors?.stampSetId ?? "", /button:pay:abc123/);
		assert.equal(verifyMemoryEntryAgainstProfile(recorded.entry, profile, "https://shop.example/checkout").status, "fresh");
	} finally {
		await cleanup(cwd);
	}
});

test("memory verification is structural: stale on anchor drift and unverified without anchors", () => {
	const profile = emptyMemoryOriginProfile("https://shop.example");
	profile.urls = [{ canonicalUrl: "https://shop.example/checkout", capturedAt: 20, factStamps: { "button:pay": "new" }, fingerprintSummary: { changeSeq: 9 } }];
	const anchored = {
		anchors: {
			canonicalUrl: "https://shop.example/checkout",
			stampSetId: "button:pay:old",
			fingerprintSummary: { changeSeq: 4 },
		},
	};
	assert.equal(verifyMemoryEntryAgainstProfile(anchored, profile, "https://shop.example/checkout").status, "stale");
	assert.deepEqual(verifyMemoryEntryAgainstProfile({}, profile, "https://shop.example/checkout"), { status: "unverified", reasons: ["no-anchors"] });
});
