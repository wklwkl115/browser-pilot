import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptyMemoryOriginProfile } from "../../../src/memory-core/profile.ts";
import { memoryProfileFilePath, readMemoryProfile, writeMemoryProfile } from "../../../src/memory/profileStore.ts";
import { readOrCreateMemorySecret } from "../../../src/memory/secret.ts";

async function tempCwd(): Promise<string> {
	return await mkdtemp(path.join(os.tmpdir(), "pi-memory-profile-store-"));
}

async function cleanup(cwd: string): Promise<void> {
	await rm(cwd, { recursive: true, force: true });
}

test("profile automatic paths do not materialize storage when disabled", async () => {
	const cwd = await tempCwd();
	const old = process.env.PI_BROWSER_MEMORY;
	process.env.PI_BROWSER_MEMORY = "0";
	try {
		assert.deepEqual(await readMemoryProfile(cwd, "https://disabled.example"), {});
		assert.equal(await writeMemoryProfile(cwd, emptyMemoryOriginProfile("https://disabled.example")), undefined);
		assert.equal(await readOrCreateMemorySecret(cwd), undefined);
		await assert.rejects(readFile(path.join(cwd, ".pi", "browser-memory", ".secret"), "utf8"));
		await assert.rejects(readdir(path.join(cwd, ".pi")));
	} finally {
		if (old === undefined) delete process.env.PI_BROWSER_MEMORY;
		else process.env.PI_BROWSER_MEMORY = old;
		await cleanup(cwd);
	}
});

test("profile store treats corrupt and oversized profiles as absent with low-noise warnings", async () => {
	const cwd = await tempCwd();
	try {
		const origin = "https://corrupt.example";
		const file = memoryProfileFilePath(cwd, origin);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, "{not-json", "utf8");
		assert.deepEqual(await readMemoryProfile(cwd, origin), { warning: "memory_profile_unreadable" });
		await writeFile(file, `${"x".repeat(70 * 1024)}`, "utf8");
		assert.deepEqual(await readMemoryProfile(cwd, origin), { warning: "memory_profile_oversized" });
	} finally {
		await cleanup(cwd);
	}
});

test("profile filenames keep truncated slugs distinct and prune to the global origin cap", async () => {
	const cwd = await tempCwd();
	try {
		const longA = `https://${"a".repeat(100)}.example`;
		const longB = `https://${"a".repeat(100)}.example:8443`;
		assert.notEqual(memoryProfileFilePath(cwd, longA), memoryProfileFilePath(cwd, longB));
		for (let index = 0; index < 66; index += 1) {
			const origin = `https://site-${index}.example`;
			await writeMemoryProfile(cwd, { ...emptyMemoryOriginProfile(origin), sessions: [{ sessionId: `s${index}`, capturedAt: index, termKeys: [] }] });
		}
		const files = (await readdir(path.join(cwd, ".pi", "browser-memory", "profiles"))).filter((name) => name.endsWith(".json"));
		assert(files.length <= 64, "profile store must enforce the 64-origin cap");
	} finally {
		await cleanup(cwd);
	}
});

test("profile store round-trips capped profile JSON", async () => {
	const cwd = await tempCwd();
	try {
		const origin = "https://roundtrip.example";
		const profile = emptyMemoryOriginProfile(origin);
		profile.strikes.entry = 2;
		await writeMemoryProfile(cwd, profile);
		const loaded = await readMemoryProfile(cwd, origin);
		assert.equal(loaded.warning, undefined);
		assert.equal(loaded.profile?.origin, origin);
		assert.equal(loaded.profile?.strikes.entry, 2);
	} finally {
		await cleanup(cwd);
	}
});
