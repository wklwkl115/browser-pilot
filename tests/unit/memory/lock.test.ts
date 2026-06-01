import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { withMemoryLock, readMemoryIndex } from "../../../src/tools/memory/indexStore.ts";
import { recordMemoryEntry } from "../../../src/tools/memory/store.ts";

function freshCwd(): string {
	return mkdtempSync(path.join(tmpdir(), "memory-lock-"));
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("withMemoryLock serializes concurrent critical sections", async () => {
	const cwd = freshCwd();
	let active = 0;
	let maxActive = 0;
	await Promise.all(Array.from({ length: 5 }, () => withMemoryLock(cwd, async () => {
		active += 1;
		maxActive = Math.max(maxActive, active);
		await delay(15);
		active -= 1;
	})));
	assert.equal(maxActive, 1, "the lock must admit only one holder at a time");
	assert.equal(active, 0, "every holder must release the lock");
});

test("concurrent records all persist without lost writes", async () => {
	const cwd = freshCwd();
	const artifactPath = path.join(cwd, ".pi", "browser-artifacts", "e.json");
	mkdirSync(path.dirname(artifactPath), { recursive: true });
	writeFileSync(artifactPath, "{}");
	await Promise.all(Array.from({ length: 5 }, (_, i) => recordMemoryEntry({
		cwd,
		payload: { kind: "sop", url: "https://www.site.com/x", title: `distinct title ${i}`, triggers: ["t"], body: "step\n", evidenceRefs: [artifactPath] },
	})));
	const index = await readMemoryIndex(cwd);
	const active = index.entries.filter((e) => e.status === "active");
	assert.equal(active.length, 5, "all five concurrent records must survive the serialized index rebuilds");
	assert.equal(new Set(active.map((e) => e.id)).size, 5, "record ids must be unique");
});
