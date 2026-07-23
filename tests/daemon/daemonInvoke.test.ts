import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { handleInvokeRoute, startDaemon } from "../../src/apps/daemon/server.ts";
import { controlRequest, lockfilePath, readLockfile, removeLockfile, writeLockfile, type DaemonInfo } from "../../src/apps/daemon/daemonControl.ts";
import { AUTH_ERROR_CODES, AUTH_STORE_VERSION, ENV_AUTH_STATE_DIR, PAIRING_TOKEN_HEADER } from "../../src/apps/daemon/authTypes.ts";
import * as authStore from "../../src/apps/daemon/authStore.ts";
import { strictCommandParameters } from "../../src/commands/commandShared.ts";
import type { CommandDefinition } from "../../src/commands/commandManifestIndex.ts";
import { errorResult } from "../../src/utils/toolResult.ts";

const originalAuthStateDir = process.env[ENV_AUTH_STATE_DIR];
const originalDaemonStateDir = process.env.BROWSER_PILOT_DAEMON_STATE_DIR;

function isolateAuthStore() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-invoke-auth-"));
	process.env[ENV_AUTH_STATE_DIR] = dir;
	return dir;
}

function isolateDaemonState() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-daemon-state-"));
	process.env.BROWSER_PILOT_DAEMON_STATE_DIR = dir;
	return dir;
}

function restoreEnv() {
	if (originalAuthStateDir === undefined) delete process.env[ENV_AUTH_STATE_DIR];
	else process.env[ENV_AUTH_STATE_DIR] = originalAuthStateDir;
	if (originalDaemonStateDir === undefined) delete process.env.BROWSER_PILOT_DAEMON_STATE_DIR;
	else process.env.BROWSER_PILOT_DAEMON_STATE_DIR = originalDaemonStateDir;
}

function request(headers: Record<string, string> = {}) {
	return { headers } as any;
}

async function invoke(options: {
	body: Record<string, unknown>;
	toolByName: Map<string, CommandDefinition>;
	headers?: Record<string, string>;
}) {
	let response: { status: number; json: Record<string, unknown> } | undefined;
	await handleInvokeRoute({
		req: request(options.headers),
		send(status, obj) {
			response = { status, json: JSON.parse(JSON.stringify(obj)) as Record<string, unknown> };
		},
		body: options.body,
		toolByName: options.toolByName,
	});
	assert.ok(response);
	return response;
}

function tools() {
	const success: CommandDefinition = {
		name: "browser_success",
		parameters: strictCommandParameters({ message: Type.String() }),
		async execute(params, _signal, ctx) {
			return {
				content: [{ type: "text", text: String(params.message) }],
				details: { cwd: ctx?.cwd, omitTransportDetails: ctx?.omitTransportDetails },
			};
		},
	};
	const throwing: CommandDefinition = {
		name: "browser_throw",
		parameters: strictCommandParameters({}),
		execute() {
			throw new Error("boom from command");
		},
	};
	const failing: CommandDefinition = {
		name: "browser_error",
		parameters: strictCommandParameters({}),
		execute() {
			return errorResult(new Error("reported command error"));
		},
	};
	return new Map<string, CommandDefinition>([[success.name, success], [throwing.name, throwing], [failing.name, failing]]);
}

async function activePairing(label: string) {
	const pending = authStore.mintPending(label);
	const approved = await authStore.approve(pending.pairingId);
	assert.ok(approved);
	return { pairingId: pending.pairingId, token: approved.token };
}

function daemonInfo(overrides: Partial<DaemonInfo> = {}): DaemonInfo {
	return {
		pid: process.pid,
		controlHost: "127.0.0.1",
		controlPort: 9,
		token: "daemon-token",
		startedAt: new Date(0).toISOString(),
		version: "0.0.0+daemon.1",
		...overrides,
	};
}

async function startDaemonForRouteTest() {
	return startDaemon({ writeLock: false, startBridgeEagerly: false });
}

async function rawControlRequest(handle: Awaited<ReturnType<typeof startDaemonForRouteTest>>, route: string, body: string) {
	return await new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
		const req = http.request({
			host: handle.controlHost,
			port: handle.controlPort,
			path: route,
			method: "POST",
			headers: { "x-browser-pilot-daemon-token": handle.token, "content-type": "application/json" },
		}, (res) => {
			let response = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => { response += chunk; });
			res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(response) as Record<string, unknown> }));
		});
		req.on("error", reject);
		req.end(body);
	});
}

test.afterEach(() => {
	authStore.listAgents().splice(0);
	restoreEnv();
});

test("daemon invoke requires pairing by default", async () => {
	isolateAuthStore();
	const res = await invoke({ body: { tool: "browser_success", params: { message: "ok" }, cwd: "project" }, toolByName: tools() });
	assert.equal(res.status, 401);
	assert.equal(res.json.code, AUTH_ERROR_CODES.pairingInvalid);
});

test("daemon invoke accepts an active pairing token", async () => {
	isolateAuthStore();
	const pair = await activePairing("agent-a");
	const res = await invoke({ body: { tool: "browser_success", params: { message: "ok" }, cwd: "project" }, toolByName: tools(), headers: { [PAIRING_TOKEN_HEADER]: pair.token } });
	assert.equal(res.status, 200);
	assert.deepEqual(res.json.content, [{ type: "text", text: "ok" }]);
	assert.deepEqual(res.json.details, { cwd: "project" });
});

test("daemon invoke rejects invalid pairing token", async () => {
	isolateAuthStore();
	const res = await invoke({ body: { tool: "browser_success", params: { message: "ok" } }, toolByName: tools(), headers: { [PAIRING_TOKEN_HEADER]: "not-a-token" } });
	assert.equal(res.status, 401);
	assert.equal(res.json.code, AUTH_ERROR_CODES.pairingInvalid);
});

test("daemon invoke rejects revoked pairing token", async () => {
	isolateAuthStore();
	const pair = await activePairing("agent-a");
	await authStore.revoke(pair.pairingId);
	const res = await invoke({ body: { tool: "browser_success", params: { message: "ok" } }, toolByName: tools(), headers: { [PAIRING_TOKEN_HEADER]: pair.token } });
	assert.equal(res.status, 403);
	assert.equal(res.json.code, AUTH_ERROR_CODES.pairingRevoked);
});

test("daemon invoke authenticates before resolving tools", async () => {
	isolateAuthStore();
	const pair = await activePairing("agent-a");
	const res = await invoke({ body: { tool: "browser_missing", params: {} }, toolByName: tools() });
	assert.equal(res.status, 401);
	assert.equal(res.json.code, AUTH_ERROR_CODES.pairingInvalid);
	const authorized = await invoke({ body: { tool: "browser_missing", params: {} }, toolByName: tools(), headers: { [PAIRING_TOKEN_HEADER]: pair.token } });
	assert.equal(authorized.status, 404);
	assert.equal(authorized.json.error, "unknown tool: browser_missing");
});

test("daemon invoke does not echo pairing tokens in controlled error responses", async () => {
	isolateAuthStore();
	const secret = "not-a-token-secret-value";
	const res = await invoke({ body: { tool: "browser_success", params: { message: "ok" } }, toolByName: tools(), headers: { [PAIRING_TOKEN_HEADER]: secret } });
	const raw = JSON.stringify(res.json);
	assert.equal(res.status, 401);
	assert.equal(raw.includes(secret), false);
	assert.deepEqual(res.json, { ok: false, code: AUTH_ERROR_CODES.pairingInvalid, error: "Browser pairing required; call browser_pair with action=start." });
});

test("daemon invoke authenticates before validating parameters", async () => {
	isolateAuthStore();
	const pair = await activePairing("agent-a");
	const res = await invoke({ body: { tool: "browser_success", params: {} }, toolByName: tools() });
	assert.equal(res.status, 401);
	assert.equal(res.json.code, AUTH_ERROR_CODES.pairingInvalid);
	const authorized = await invoke({ body: { tool: "browser_success", params: {} }, toolByName: tools(), headers: { [PAIRING_TOKEN_HEADER]: pair.token } });
	assert.equal(authorized.status, 400);
	assert.equal(authorized.json.code, "COMMAND_VALIDATION_FAILED");
	assert.match(String(authorized.json.error), /Invalid parameters/);
	assert.ok(Array.isArray(authorized.json.issues));
});

test("daemon invoke wraps command throws as terminating success envelope", async () => {
	isolateAuthStore();
	const pair = await activePairing("agent-a");
	const res = await invoke({ body: { tool: "browser_throw", params: {} }, toolByName: tools(), headers: { [PAIRING_TOKEN_HEADER]: pair.token } });
	assert.equal(res.status, 200);
	assert.equal(res.json.ok, true);
	assert.deepEqual(res.json.content, [{ type: "text", text: "boom from command" }]);
	assert.equal(res.json.terminate, true);
	assert.equal(res.json.isError, true);
});

test("daemon invoke preserves non-terminating command error semantics", async () => {
	isolateAuthStore();
	const pair = await activePairing("agent-a");
	const res = await invoke({ body: { tool: "browser_error", params: {} }, toolByName: tools(), headers: { [PAIRING_TOKEN_HEADER]: pair.token } });
	assert.equal(res.status, 200);
	assert.equal(res.json.isError, true);
	assert.equal(res.json.terminate, false);
});

test("daemon aborts an active invocation when the control client disconnects", async () => {
	isolateAuthStore();
	const pair = await activePairing("agent-a");
	let markStarted!: () => void;
	let markAborted!: () => void;
	const started = new Promise<void>((resolve) => { markStarted = resolve; });
	const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
	const slow: CommandDefinition = {
		name: "browser_slow",
		parameters: strictCommandParameters({}),
		async execute(_params, signal) {
			assert.ok(signal);
			markStarted();
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => { markAborted(); resolve(); }, { once: true }));
			return { content: [{ type: "text", text: "aborted" }] };
		},
	};
	const handle = await startDaemon({ writeLock: false, startBridgeEagerly: false, commandDefinitions: [slow] });
	try {
		const req = http.request({
			host: handle.controlHost,
			port: handle.controlPort,
			path: "/invoke",
			method: "POST",
			headers: { "x-browser-pilot-daemon-token": handle.token, [PAIRING_TOKEN_HEADER]: pair.token, "content-type": "application/json" },
		});
		req.on("error", () => undefined);
		req.end(JSON.stringify({ tool: "browser_slow", params: {} }));
		await started;
		req.destroy();
		await Promise.race([aborted, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("invoke signal was not aborted")), 1_000))]);
	} finally {
		await handle.close();
	}
});

test("daemon auth store sweeps expired pending pairings before pairing summaries", () => {
	isolateAuthStore();
	const { pairingId } = authStore.mintPending("expired-agent");
	const record = authStore.listAgents().find((agent) => agent.pairingId === pairingId);
	assert.ok(record);
	record.pendingExpiresAt = new Date(Date.now() - 1_000).toISOString();
	authStore.sweepExpiredPending();
	assert.equal(authStore.listAgents().some((agent) => agent.pairingId === pairingId), false);
});

test("daemon auth store replaces the previous agent when pairing restarts", async () => {
	isolateAuthStore();
	const first = authStore.mintPending("first-agent");
	const approved = await authStore.approve(first.pairingId);
	assert.ok(approved);
	const second = authStore.mintPending("second-agent");
	assert.deepEqual(authStore.listAgents().map(({ pairingId, status }) => ({ pairingId, status })), [{ pairingId: second.pairingId, status: "pending" }]);
	assert.equal(authStore.findByToken(approved.token), null);
	assert.equal(await authStore.approve(first.pairingId), null);
});

test("daemon auth store collapses legacy multi-agent state on load", () => {
	isolateAuthStore();
	const record = {
		label: "agent",
		tokenHash: "a".repeat(64),
		status: "active",
		createdAt: new Date(0).toISOString(),
		approvedAt: new Date(0).toISOString(),
		revokedAt: null,
		lastSeenAt: null,
	};
	writeFileSync(authStore.authStorePath(), JSON.stringify({ version: AUTH_STORE_VERSION, agents: [{ ...record, pairingId: "old" }, { ...record, pairingId: "current" }] }), "utf8");
	assert.deepEqual(authStore.listAgents().map((agent) => agent.pairingId), ["current"]);
});

test("daemon auth store denies approval for revoked or missing pending pairing", async () => {
	isolateAuthStore();
	const { pairingId } = authStore.mintPending("revoked-before-approve");
	await authStore.revoke(pairingId);
	assert.equal(await authStore.approve(pairingId), null);
	assert.equal(await authStore.approve("missing-pairing"), null);
});

test("daemon auth store fails closed on damage and recovers after operator reset", () => {
	const dir = isolateAuthStore();
	writeFileSync(authStore.authStorePath(), JSON.stringify({ version: AUTH_STORE_VERSION, agents: "damaged" }), "utf8");
	assert.throws(() => authStore.listAgents(), /auth store is malformed/);
	rmSync(authStore.authStorePath());
	assert.equal(authStore.mintPending("recovery").code.length, 6);
	assert.equal(authStore.authStorePath().startsWith(dir), true);
});

test("daemon control lockfile treats missing and malformed state as absent", () => {
	isolateDaemonState();
	assert.equal(readLockfile(), undefined);
	writeFileSync(lockfilePath(), "{not-json", "utf8");
	assert.equal(readLockfile(), undefined);
	writeFileSync(lockfilePath(), JSON.stringify({ pid: process.pid, controlPort: 1, controlHost: "127.0.0.1" }), "utf8");
	assert.equal(readLockfile(), undefined);
});

test("daemon control lockfile writes and removes token-bearing singleton state", () => {
	isolateDaemonState();
	const info = daemonInfo({ token: "lock-token", controlPort: 12345 });
	writeLockfile(info);
	assert.deepEqual(readLockfile(), info);
	const raw = readFileSync(lockfilePath(), "utf8");
	assert.equal(raw.includes("lock-token"), true);
	if (process.platform !== "win32") assert.equal(statSync(lockfilePath()).mode & 0o777, 0o600);
	removeLockfile();
	assert.equal(existsSync(lockfilePath()), false);
	removeLockfile();
});

test("daemon status, connect, and unknown routes preserve control contracts", async () => {
	isolateAuthStore();
	const handle = await startDaemonForRouteTest();
	try {
		const unauthorized = await controlRequest({ ...handle, token: "wrong-token" }, "GET", "/status", undefined, 1_000);
		assert.deepEqual(unauthorized, { status: 401, json: { ok: false, error: "unauthorized" } });

		const initial = await controlRequest(handle, "GET", "/status?tabs=1", undefined, 1_000);
		assert.equal(initial.status, 200);
		assert.equal(initial.json?.running, false);
		assert.deepEqual(initial.json?.tabs, []);
		const malformed = await rawControlRequest(handle, "/connect", "{");
		assert.equal(malformed.status, 500);
		assert.equal(malformed.json.ok, false);
		assert.equal(typeof malformed.json.error, "string");

		const connected = await controlRequest(handle, "POST", "/connect", { wait: false, tabs: true }, 2_000);
		assert.equal(connected.status, 200);
		assert.equal(connected.json?.startedBridge, true);
		assert.equal((connected.json?.status as Record<string, unknown>)?.running, true);

		const missing = await controlRequest(handle, "GET", "/missing", undefined, 1_000);
		assert.deepEqual(missing, { status: 404, json: { ok: false, error: "not found: GET /missing" } });
	} finally {
		await handle.close();
	}
});

test("daemon pairing routes preserve pending, listing, and revoke contracts", async () => {
	isolateAuthStore();
	const pair = await activePairing("route-agent");
	const handle = await startDaemonForRouteTest();
	try {
		const unavailable = await controlRequest(handle, "POST", "/pair/start", { label: "new-agent" }, 1_000);
		assert.equal(unavailable.status, 409);
		assert.equal(unavailable.json?.code, AUTH_ERROR_CODES.pairNoExtension);

		const pending = await controlRequest(handle, "POST", "/pair/wait", { pairingId: "missing" }, 1_000);
		assert.equal(pending.status, 408);
		assert.equal(pending.json?.code, AUTH_ERROR_CODES.pairTimeout);

		const before = await controlRequest(handle, "GET", "/pairings", undefined, 1_000);
		assert.equal(before.status, 200);
		assert.deepEqual((before.json?.agents as Array<Record<string, unknown>>).map(({ pairingId, status }) => ({ pairingId, status })), [{ pairingId: pair.pairingId, status: "active" }]);

		const missing = await controlRequest(handle, "POST", "/revoke", { pairingId: "missing" }, 1_000);
		assert.equal(missing.status, 404);
		assert.equal(missing.json?.code, AUTH_ERROR_CODES.pairingNotFound);

		const revoked = await controlRequest(handle, "POST", "/revoke", { pairingId: pair.pairingId }, 1_000);
		assert.deepEqual(revoked, { status: 200, json: { ok: true, revoked: pair.pairingId } });
		assert.equal(authStore.listAgents().find((agent) => agent.pairingId === pair.pairingId)?.status, "revoked");
	} finally {
		await handle.close();
	}
});

test("daemon control request sends pairing token header", async () => {
	const seen = await new Promise<string | undefined>((resolve, reject) => {
		const server = http.createServer((req, res) => {
			resolve(req.headers[PAIRING_TOKEN_HEADER] as string | undefined);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
		server.listen(0, "127.0.0.1", async () => {
			try {
				const address = server.address();
				if (!address || typeof address === "string") throw new Error("expected TCP listener address");
				await controlRequest({ controlHost: "127.0.0.1", controlPort: address.port, token: "daemon-token" }, "POST", "/invoke", {}, 1_000, { pairingToken: "pair-token" });
			} catch (error) {
				reject(error);
			} finally {
				server.close();
			}
		});
	});
	assert.equal(seen, "pair-token");
});

test("daemon control request does not send a pre-aborted invocation", async () => {
	let hits = 0;
	const server = http.createServer((_req, res) => {
		hits += 1;
		res.end("{}");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected TCP listener address");
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(controlRequest({ controlHost: "127.0.0.1", controlPort: address.port, token: "daemon-token" }, "POST", "/invoke", {}, 1_000, { signal: controller.signal }), { name: "AbortError" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(hits, 0);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
