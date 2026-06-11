import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PerceptionLedgerFrame, PerceptionTraceSnapshot } from "../../../src/abml/perceptionLedger.ts";
import { emptyMemoryOriginProfile } from "../../../src/memory-core/profile.ts";
import { memoryTermKey } from "../../../src/memory-core/profile.ts";
import { drainMemoryProfileFlushes, recordMemoryProfileFrame, recordMemoryProfileStrike, __resetMemoryProfileServiceForTests } from "../../../src/memory/profileService.ts";
import { memoryProfileFilePath, readMemoryProfile, writeMemoryProfile } from "../../../src/memory/profileStore.ts";

async function tempCwd(): Promise<string> {
	return await mkdtemp(path.join(os.tmpdir(), "pi-memory-profile-service-"));
}

async function cleanup(cwd: string): Promise<void> {
	__resetMemoryProfileServiceForTests();
	await rm(cwd, { recursive: true, force: true });
}

function frame(sessionId: string, capturedAt: number, url = "https://shop.example/checkout?token=abc"): PerceptionLedgerFrame {
	return {
		key: { browserSessionId: sessionId, tabId: 1, navigationEpoch: `nav-${sessionId}` },
		snapshotId: `snap-${sessionId}`,
		capturedAt,
		facts: {
			"button:pay": {
				versionStamp: `{"name":"Alice alice@example.com","token":"secret-${sessionId}"}`,
				stableStamp: `{"name":"张三","value":"alice@example.com"}`,
				lastShownGranularity: "compact",
			},
		},
		pageFingerprint: { changeSeq: capturedAt, url, title: "Alice private checkout", readyState: "complete", visibleCount: 7, interactiveCount: 3 },
	};
}

function trace(term: string): PerceptionTraceSnapshot {
	return {
		latestSeq: 1,
		terms: [
			{ term, kind: "urlPathToken", at: 1, seq: 1 },
			{ term: "token=abc", kind: "urlQueryToken", at: 1, seq: 2 },
			{ term: "alice@example.com", kind: "selectorLiteral", at: 1, seq: 3 },
		],
	};
}

test("profile service merges concurrent frame and verification strike mutations", async () => {
	const cwd = await tempCwd();
	try {
		await recordMemoryProfileFrame({ cwd, browserSessionId: "s1", frame: frame("s1", 10), trace: trace("checkout") });
		await recordMemoryProfileStrike({ cwd, origin: "https://shop.example", entryId: "mem-1", status: "stale" });
		await recordMemoryProfileFrame({ cwd, browserSessionId: "s2", frame: frame("s2", 20), trace: trace("checkout") });
		await drainMemoryProfileFlushes();
		const loaded = await readMemoryProfile(cwd, "https://shop.example");
		assert.equal(loaded.profile?.strikes["mem-1"], 1);
		assert.equal(loaded.profile?.sessions.length, 2);
		assert.equal(loaded.profile?.termStats[memoryTermKey({ kind: "urlPathToken", term: "checkout" })]?.sessionCount, 2);
		assert.equal(loaded.profile?.urls[0]?.canonicalUrl, "https://shop.example/checkout");
	} finally {
		await cleanup(cwd);
	}
});

test("profile flush re-reads disk so external deltas survive the merge window", async () => {
	const cwd = await tempCwd();
	try {
		await recordMemoryProfileFrame({ cwd, browserSessionId: "s1", frame: frame("s1", 10), trace: trace("checkout") });
		const external = emptyMemoryOriginProfile("https://shop.example");
		external.strikes["external"] = 5;
		await writeMemoryProfile(cwd, external);
		await drainMemoryProfileFlushes();
		const loaded = await readMemoryProfile(cwd, "https://shop.example");
		assert.equal(loaded.profile?.strikes.external, 5);
		assert.equal(loaded.profile?.sessions.length, 1);
	} finally {
		await cleanup(cwd);
	}
});

test("profile persistence HMACs stamps and never writes raw trace/query/title/page text", async () => {
	const cwd = await tempCwd();
	try {
		await recordMemoryProfileFrame({ cwd, browserSessionId: "s1", frame: frame("s1", 10), trace: trace("checkout") });
		await drainMemoryProfileFlushes();
		const file = memoryProfileFilePath(cwd, "https://shop.example");
		const text = await readFile(file, "utf8");
		for (const forbidden of ["alice@example.com", "张三", "secret-s1", "token=abc", "Alice private checkout", "?token"]) {
			assert(!text.includes(forbidden), `profile file must not contain ${forbidden}`);
		}
		assert.match(text, /[a-f0-9]{32}/, "hashed fact stamps should remain comparable as truncated HMACs");
		const profileFiles = await readdir(path.dirname(file));
		assert(profileFiles.some((name) => name.endsWith(".json")));
	} finally {
		await cleanup(cwd);
	}
});
