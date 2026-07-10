import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	allSessionStates,
	createCallbackSession,
	filterEvents,
	loadSessionState,
	loadSessionStateByPath,
	normalizeCallbackSessionId,
	parseIpv4Address,
	refreshSessionState,
	saveJson,
	sessionArtifactRoot,
	sessionInfo,
	sessionStatePath,
	stopSession,
	updateSessionStateByPath,
	waitForState,
	type CallbackSessionState,
} from "../../src/commands/webSecurity/browserNative/oastWorkerManager.ts";

async function temporaryCwd(context: { after: (fn: () => Promise<void>) => void }): Promise<string> {
	const cwd = await mkdtemp(path.join(tmpdir(), "browser-pilot-oast-test-"));
	context.after(() => rm(cwd, { recursive: true, force: true }));
	return cwd;
}

test("OAST state storage preserves scoped paths, atomic updates, stale-lock recovery, enumeration, and dead-worker recovery", async (context) => {
	const cwd = await temporaryCwd(context);
	assert.deepEqual(parseIpv4Address("192.0.2.10"), [192, 0, 2, 10]);
	assert.equal(parseIpv4Address("300.0.0.1"), undefined);
	assert.equal(parseIpv4Address("1.2.3"), undefined);
	assert.equal(parseIpv4Address("1.2.x.4"), undefined);
	assert.equal(normalizeCallbackSessionId("session.one-1"), "session.one-1");
	assert.throws(() => normalizeCallbackSessionId("../escape"), (error: Error & { code?: string }) => error.code === "INVALID_RULE");

	const statePath = sessionStatePath("state-a", cwd);
	assert.equal(statePath, path.join(sessionArtifactRoot("state-a", cwd), "state.json"));
	await saveJson(statePath, { sessionId: "state-a", artifactRoot: "C:\\escaped", statePath: "C:\\escaped\\state.json", startedAt: "2026-01-01T00:00:00.000Z", counter: 0, events: [{ seq: 1 }, { seq: 3 }] });
	const loaded = await loadSessionStateByPath(statePath);
	assert.ok(loaded);
	assert.equal(loaded.artifactRoot, path.dirname(statePath));
	assert.equal(loaded.statePath, statePath);
	assert.deepEqual(filterEvents(loaded, 1).map((event) => event.seq), [3]);

	await Promise.all(Array.from({ length: 8 }, () => updateSessionStateByPath(statePath, (current) => ({ ...current, counter: Number(current.counter || 0) + 1 } as CallbackSessionState))));
	assert.equal((await loadSessionState("state-a", cwd))?.counter, 8);

	const staleStatePath = sessionStatePath("state-b", cwd);
	await mkdir(path.dirname(staleStatePath), { recursive: true });
	await writeFile(`${staleStatePath}.lock`, JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, acquiredAt: new Date().toISOString(), token: "stale" }), "utf8");
	await saveJson(staleStatePath, { sessionId: "state-b", startedAt: "2026-02-01T00:00:00.000Z", listenerActive: false });
	assert.equal(JSON.parse(await readFile(staleStatePath, "utf8")).sessionId, "state-b");
	await assert.rejects(readFile(`${staleStatePath}.lock`, "utf8"), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
	const malformedLockStatePath = sessionStatePath("state-c", cwd);
	await mkdir(path.dirname(malformedLockStatePath), { recursive: true });
	await writeFile(`${malformedLockStatePath}.lock`, "not-json", "utf8");
	const old = new Date(Date.now() - 31_000);
	await utimes(`${malformedLockStatePath}.lock`, old, old);
	await saveJson(malformedLockStatePath, { sessionId: "state-c", startedAt: "2025-01-01T00:00:00.000Z", listenerActive: false });

	const sessions = await allSessionStates(cwd);
	assert.deepEqual(sessions.map((state) => state.sessionId), ["state-b", "state-a", "state-c"]);
	const dead = await updateSessionStateByPath(statePath, (current) => ({ ...current, listenerActive: true, ready: true, workerPid: Number.MAX_SAFE_INTEGER } as CallbackSessionState));
	const recovered = await refreshSessionState(dead);
	assert.equal(recovered?.listenerActive, false);
	assert.equal(recovered?.recovered, true);
	assert.equal(recovered?.stopReason, "worker-exited");
	assert.deepEqual(sessionInfo(recovered!).enabledProtocols, []);
	const alive = { ...recovered!, listenerActive: true, workerPid: process.pid } as CallbackSessionState;
	assert.equal(await refreshSessionState(alive), alive);
	assert.deepEqual(sessionInfo({ ...recovered!, callbackUrl: "http://callback", httpsCallbackUrl: "https://callback", dnsCallbackHost: "dns.callback" } as CallbackSessionState).enabledProtocols, ["http", "https", "dns"]);
	assert.equal(await updateSessionStateByPath(sessionStatePath("missing", cwd), (current) => current), undefined);
	assert.equal(await loadSessionStateByPath(path.join(cwd, "outside.json")), undefined);
	const invalidStatePath = sessionStatePath("invalid-json", cwd);
	await mkdir(path.dirname(invalidStatePath), { recursive: true });
	await writeFile(invalidStatePath, "{", "utf8");
	assert.equal(await loadSessionStateByPath(invalidStatePath), undefined);
});

test("OAST worker starts, records bounded HTTP events, rejects duplicates, and stops promptly for request-scoped cwd", async (context) => {
	const cwd = await temporaryCwd(context);
	const options = {
		cwd,
		sessionId: "live-session",
		listenHost: "127.0.0.1",
		dnsListenHost: "127.0.0.1",
		port: 0,
		httpsPort: 0,
		dnsPort: 0,
		dnsResponseAddress: "127.0.0.1",
		basePath: "/callback/{{correlationId}}",
		correlationId: "correlation-live",
		responseStatus: 202,
		responseBody: "accepted",
		responseHeaders: { "Content-Type": "text/plain" },
		enableHttps: false,
		enableDns: false,
		maxEvents: 10,
		maxBodyBytes: 8,
		maxRuntimeMs: 60_000,
	};
	let state = await createCallbackSession(options);
	context.after(async () => {
		const current = await loadSessionState("live-session", cwd);
		if (current?.listenerActive) await stopSession(current);
	});
	assert.equal(state.ready, true);
	assert.equal(state.listenerActive, true);
	assert.match(String(state.callbackUrl), /\/callback\/correlation-live$/);
	await assert.rejects(createCallbackSession(options), /session already exists/);

	const response = await fetch(String(state.callbackUrl), { method: "POST", headers: { "Content-Type": "text/plain", "X-Correlation": "correlation-live" }, body: "0123456789abcdef" });
	assert.equal(response.status, 202);
	assert.equal(await response.text(), "accepted");
	state = await waitForState("live-session", (current) => Number(current.eventCount) >= 1, 3_000, cwd);
	const events = filterEvents(state, 0);
	assert.equal(events.length, 1);
	assert.equal(events[0].protocol, "http");
	assert.equal(events[0].matchedCorrelation, true);
	assert.deepEqual(events[0].body, { bytes: 8, truncated: true, text: "01234567" });
	assert.deepEqual(sessionInfo(state).enabledProtocols, ["http"]);

	const started = Date.now();
	state = await stopSession(state);
	assert.ok(Date.now() - started < 3_000, "request-scoped worker stop should observe its own state path without the 10s fallback");
	assert.equal(state.listenerActive, false);
	assert.equal(state.ready, false);
	assert.match(String(state.stopReason), /worker-exited|SIGTERM|signal|shutdown/i);
	await assert.rejects(waitForState("missing-session", () => true, 120, cwd), /timed out waiting for session missing-session/);
});
