import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserRuntimeRecoveryArtifacts } from "../../src/bridge/server/BrowserRuntimeRecoveryArtifacts.ts";

test("runtime recovery artifacts rotate and omit oversized payloads", async () => {
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-pilot-recovery-"));
	try {
		const artifacts = new BrowserRuntimeRecoveryArtifacts(cwd);
		const options = { snapshot: {} } as never;
		for (let index = 0; index < 7; index += 1) artifacts.recordCommandResult({ cmd: "network.list" }, { tabId: 1, data: { payload: "x".repeat(900_000) } } as never, options);
		artifacts.recordCommandResult({ cmd: "network.list" }, { tabId: 1, data: { payload: "x".repeat(1_100_000) } } as never, options);
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		assert.doesNotThrow(() => artifacts.recordCommandResult({ cmd: "network.list" }, { tabId: 1, data: circular } as never, options));
		await artifacts.flush();

		const dir = path.join(cwd, ".browser-pilot", "artifacts", "runtime-recovery");
		const files = (await readdir(dir)).filter((name) => name.startsWith("network-events.jsonl"));
		assert.deepEqual(files.sort(), ["network-events.jsonl", "network-events.jsonl.1"]);
		for (const file of files) assert.ok((await stat(path.join(dir, file))).size <= 5 * 1024 * 1024);
		const activeLines = (await readFile(path.join(dir, "network-events.jsonl"), "utf8")).trim().split("\n");
		assert.equal((JSON.parse(activeLines.at(-1)!) as { omitted?: boolean }).omitted, true);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
