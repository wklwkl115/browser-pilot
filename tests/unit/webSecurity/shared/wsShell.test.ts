import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { cleanupWsSessionsForTests } from "../../../../src/tools/webSecurity/shared/wsSession.ts";
import { parseBrowserWsArgs, runWsShell } from "../../../../src/tools/webSecurity/shared/wsShell.ts";

const HOST = "127.0.0.1";

async function createFixtureServer(): Promise<{ url: string; close: () => Promise<void> }> {
	const server = new WebSocketServer({ host: HOST, port: 0 });
	server.on("connection", (socket) => {
		socket.on("message", (data) => socket.send(`echo:${data.toString()}`));
	});
	await new Promise<void>((resolve) => server.once("listening", () => resolve()));
	const address = server.address();
	assert(address && typeof address === "object");
	return {
		url: `ws://${HOST}:${address.port}`,
		close: async () => {
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		},
	};
}

test("parseBrowserWsArgs parses explicit action/flags", () => {
	const parsed = parseBrowserWsArgs('open ws://127.0.0.1:9001 --session test --header Authorization:Bearer --protocol chat');
	assert.equal(parsed.action, "open");
	assert.equal(parsed.url, "ws://127.0.0.1:9001");
	assert.equal(parsed.sessionId, "test");
	assert.equal(parsed.headers?.Authorization, "Bearer");
	assert.deepEqual(parsed.protocols, ["chat"]);
});

test("ws shell parses replay steps from flags and JSON", () => {
	const parsed = parseBrowserWsArgs(`replay --step alpha --steps-json '[{"text":"gamma","contains":"echo:gamma"}]'`);
	assert.equal(parsed.action, "replay");
	assert.equal(parsed.steps?.length, 1, "--steps-json overrides explicit step accumulation when used later");
	assert.equal(parsed.steps?.[0].text, "gamma");
	assert.equal(parsed.steps?.[0].contains, "echo:gamma");
});

test("ws shell saves replay failure transcript artifact automatically", async () => {
	const fixture = await createFixtureServer();
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-ws-shell-fail-"));
	try {
		await runWsShell({ action: "open", sessionId: "shell-fail", url: fixture.url, timeoutMs: 2_000 }, { cwd });
		const replay = await runWsShell({ action: "replay", sessionId: "shell-fail", steps: [{ text: "hello", contains: "never-match", timeoutMs: 50 }] }, { cwd });
		assert.equal(typeof replay.saved?.path, "string");
		assert.equal(typeof replay.summary.partialTranscriptArtifact, "object");
		const text = await readFile(String(replay.saved?.path), "utf8");
		assert.match(text, /stepIndex/);
		assert.match(text, /partialTranscript/);
	} finally {
		await cleanupWsSessionsForTests();
		await rm(cwd, { recursive: true, force: true });
		await fixture.close();
	}
});

test("ws shell saves collect transcript to artifact when outputPath is explicit", async () => {
	const fixture = await createFixtureServer();
	const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-ws-shell-"));
	try {
		await runWsShell({ action: "open", sessionId: "shell", url: fixture.url, timeoutMs: 2_000 }, { cwd });
		await runWsShell({ action: "replay", sessionId: "shell", steps: [{ text: "hello", contains: "echo:hello", timeoutMs: 2_000 }] }, { cwd });
		const collected = await runWsShell({ action: "collect", sessionId: "shell", outputPath: path.join(cwd, "ws-transcript.json") }, { cwd });
		assert.equal(typeof collected.saved?.path, "string");
		const text = await readFile(String(collected.saved?.path), "utf8");
		assert.match(text, /echo:hello/);
	} finally {
		await cleanupWsSessionsForTests();
		await rm(cwd, { recursive: true, force: true });
		await fixture.close();
	}
});
