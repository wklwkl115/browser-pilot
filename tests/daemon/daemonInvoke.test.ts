import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { handleInvokeRoute, startDaemon } from "../../src/apps/daemon/server.ts";
import { controlRequest, lockfilePath, readLockfile, removeLockfile, writeLockfile, type DaemonInfo } from "../../src/apps/daemon/daemonControl.ts";
import { TenantLeaseRegistry } from "../../src/apps/daemon/tenantLease.ts";
import { AUTH_ERROR_CODES, AUTH_STORE_VERSION, ENV_AUTH_STATE_DIR, PAIRING_TOKEN_HEADER } from "../../src/apps/daemon/authTypes.ts";
import * as authStore from "../../src/apps/daemon/authStore.ts";
import { strictCommandParameters } from "../../src/commands/commandShared.ts";
import type { CommandDefinition } from "../../src/commands/commandManifestIndex.ts";
import { errorResult } from "../../src/utils/toolResult.ts";

const originalAuthStateDir = process.env[ENV_AUTH_STATE_DIR];
const originalDaemonStateDir = process.env.BROWSER_PILOT_DAEMON_STATE_DIR;
const originalRequirePairing = process.env.BROWSER_PILOT_REQUIRE_PAIRING;

function isolateAuthStore() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-invoke-auth-"));
	process.env[ENV_AUTH_STATE_DIR] = dir;
	delete process.env.BROWSER_PILOT_REQUIRE_PAIRING;
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
	if (originalRequirePairing === undefined) delete process.env.BROWSER_PILOT_REQUIRE_PAIRING;
	else process.env.BROWSER_PILOT_REQUIRE_PAIRING = originalRequirePairing;
}

function request(headers: Record<string, string> = {}) {
	return { headers } as any;
}

async function invoke(options: {
	body: Record<string, unknown>;
	toolByName: Map<string, CommandDefinition>;
	tenantLease?: TenantLeaseRegistry;
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
		tenantLease: options.tenantLease ?? new TenantLeaseRegistry(),
		usageEnabled: false,
	});
	assert.ok(response);
	return response;
}

function tools() {
	const success: CommandDefinition = {
		name: "browser_success",
		parameters: strictCommandParameters({ message: Type.String() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
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
	authStore.loadStore().agents.splice(0);
	restoreEnv();
});

test("daemon invoke allows unpaired requests when pairing is disabled", async () => {
	isolateAuthStore();
	const res = await invoke({ body: { tool: "browser_success", params: { message: "ok" }, cwd: "project" }, toolByName: tools() });
	assert.equal(res.status, 200);
	assert.deepEqual(res.json.content, [{ type: "text", text: "ok" }]);
	assert.equal(res.json.terminate, false);
	assert.deepEqual(res.json.details, { cwd: "project" });
});

test("daemon invoke requires pairing when active agents exist", async () => {
	isolateAuthStore();
	await activePairing("agent-a");
	const res = await invoke({ body: { tool: "browser_success", params: { message: "ok" } }, toolByName: tools() });
	assert.equal(res.status, 401);
	assert.equal(res.json.code, AUTH_ERROR_CODES.pairingInvalid);
});

test("daemon invoke rejects invalid pairing token", async () => {
	isolateAuthStore();
	process.env.BROWSER_PILOT_REQUIRE_PAIRING = "1";
	const res = await invoke({ body: { tool: "browser_success", params: { message: "ok" } }, toolByName: tools(), headers: { [PAIRING_TOKEN_HEADER]: "not-a-token" } });
	assert.equal(res.status, 401);
	assert.equal(res.json.code, AUTH_ERROR_CODES.pairingInvalid);
});

test("daemon invoke rejects revoked pairing token", async () => {
	isolateAuthStore();
	process.env.BROWSER_PILOT_REQUIRE_PAIRING = "1";
	const pair = await activePairing("agent-a");
	authStore.revoke(pair.pairingId);
	const res = await invoke({ body: { tool: "browser_success", params: { message: "ok" } }, toolByName: tools(), headers: { [PAIRING_TOKEN_HEADER]: pair.token } });
	assert.equal(res.status, 403);
	assert.equal(res.json.code, AUTH_ERROR_CODES.pairingRevoked);
});

test("daemon invoke reports lease busy for another active agent", async () => {
	isolateAuthStore();
	const holder = await activePairing("holder");
	const contender = await activePairing("contender");
	const tenantLease = new TenantLeaseRegistry();
	const acquired = tenantLease.acquire(holder.pairingId, "holder", 30_000);
	assert.equal(acquired.ok, true);
	const res = await invoke({ body: { tool: "browser_success", params: { message: "ok" } }, toolByName: tools(), tenantLease, headers: { [PAIRING_TOKEN_HEADER]: contender.token } });
	assert.equal(res.status, 409);
	assert.equal(res.json.code, AUTH_ERROR_CODES.leaseBusy);
	assert.deepEqual((res.json.heldBy as Record<string, unknown>).label, "holder");
	tenantLease.stop();
});

test("daemon invoke returns unknown tool response before authorization", async () => {
	isolateAuthStore();
	await activePairing("agent-a");
	const res = await invoke({ body: { tool: "browser_missing", params: {} }, toolByName: tools() });
	assert.equal(res.status, 404);
	assert.equal(res.json.error, "unknown tool: browser_missing");
});

test("daemon invoke does not echo pairing tokens in controlled error responses", async () => {
	isolateAuthStore();
	process.env.BROWSER_PILOT_REQUIRE_PAIRING = "1";
	const secret = "not-a-token-secret-value";
	const res = await invoke({ body: { tool: "browser_success", params: { message: "ok" } }, toolByName: tools(), headers: { [PAIRING_TOKEN_HEADER]: secret } });
	const raw = JSON.stringify(res.json);
	assert.equal(res.status, 401);
	assert.equal(raw.includes(secret), false);
	assert.deepEqual(res.json, { ok: false, code: AUTH_ERROR_CODES.pairingInvalid });
});

test("daemon invoke returns validation errors before authorization", async () => {
	isolateAuthStore();
	await activePairing("agent-a");
	const res = await invoke({ body: { tool: "browser_success", params: {} }, toolByName: tools() });
	assert.equal(res.status, 400);
	assert.equal(res.json.code, "COMMAND_VALIDATION_FAILED");
	assert.match(String(res.json.error), /Invalid parameters/);
	assert.match(String(res.json.error), /message/);
	assert.ok(Array.isArray(res.json.issues));
	assert.ok((res.json.issues as Array<Record<string, unknown>>).every((issue) => typeof issue.code === "string" && typeof issue.path === "string" && typeof issue.message === "string"));
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
	const res = await invoke({ body: { tool: "browser_error", params: {} }, toolByName: tools() });
	assert.equal(res.status, 200);
	assert.equal(res.json.isError, true);
	assert.equal(res.json.terminate, false);
});

test("daemon aborts an active invocation when the control client disconnects", async () => {
	isolateAuthStore();
	let markStarted!: () => void;
	let markAborted!: () => void;
	const started = new Promise<void>((resolve) => { markStarted = resolve; });
	const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
	const slow: CommandDefinition = {
		name: "browser_slow",
		parameters: strictCommandParameters({}),
		async execute(_id, _params, signal) {
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
			headers: { "x-browser-pilot-daemon-token": handle.token, "content-type": "application/json" },
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
	const record = authStore.loadStore().agents.find((agent) => agent.pairingId === pairingId);
	assert.ok(record);
	record.pendingExpiresAt = new Date(Date.now() - 1_000).toISOString();
	authStore.sweepExpiredPending();
	assert.equal(authStore.listAgents().some((agent) => agent.pairingId === pairingId), false);
});

test("daemon auth store denies approval for revoked or missing pending pairing", async () => {
	isolateAuthStore();
	const { pairingId } = authStore.mintPending("revoked-before-approve");
	authStore.revoke(pairingId);
	assert.equal(await authStore.approve(pairingId), null);
	assert.equal(await authStore.approve("missing-pairing"), null);
});

test("daemon auth store treats damaged persisted agent lists as fresh state", () => {
	const dir = isolateAuthStore();
	authStore.loadStore().agents.splice(0);
	writeFileSync(authStore.authStorePath(), JSON.stringify({ version: AUTH_STORE_VERSION, agents: "damaged" }), "utf8");
	assert.deepEqual(authStore.loadStore(), { version: AUTH_STORE_VERSION, agents: [] });
	assert.equal(authStore.authStorePath().startsWith(dir), true);
});

test("tenant lease expires, transfers, and ignores non-holder release", () => {
	const tenantLease = new TenantLeaseRegistry();
	try {
		const first = tenantLease.acquire("pair-a", "agent-a", -1);
		assert.equal(first.ok, true);
		assert.equal(tenantLease.status(), null);
		const second = tenantLease.acquire("pair-b", "agent-b", 30_000);
		assert.equal(second.ok, true);
		tenantLease.release("pair-a");
		assert.equal(tenantLease.status()?.pairingId, "pair-b");
		tenantLease.release("pair-b");
		assert.equal(tenantLease.status(), null);
	} finally {
		tenantLease.stop();
	}
});

test("tenant lease refresh preserves holder lease id and blocks contenders", () => {
	const tenantLease = new TenantLeaseRegistry();
	try {
		const first = tenantLease.acquire("pair-a", "agent-a", 30_000);
		assert.equal(first.ok, true);
		const refreshed = tenantLease.acquire("pair-a", "agent-a", 60_000);
		assert.equal(refreshed.ok, true);
		assert.equal(refreshed.lease.leaseId, first.lease.leaseId);
		assert.equal(refreshed.lease.since, first.lease.since);
		const contender = tenantLease.acquire("pair-b", "agent-b", 30_000);
		assert.equal(contender.ok, false);
		assert.equal(contender.heldBy.pairingId, "pair-a");
	} finally {
		tenantLease.stop();
	}
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
	removeLockfile();
	assert.equal(existsSync(lockfilePath()), false);
	removeLockfile();
});

test("daemon lease route validates actions and avoids echoing pairing tokens or local paths", async () => {
	isolateAuthStore();
	const pair = await activePairing("route-agent");
	const handle = await startDaemonForRouteTest();
	try {
		const secret = `${pair.token}-secret-suffix`;
		const invalid = await controlRequest(handle, "POST", "/lease", { action: "invalid", stateDir: authStore.authStateDir() }, 1_000, { pairingToken: secret });
		const rawInvalid = JSON.stringify(invalid.json);
		assert.equal(invalid.status, 401);
		assert.equal(rawInvalid.includes(secret), false);
		assert.equal(rawInvalid.includes(authStore.authStateDir()), false);
		const unknown = await controlRequest(handle, "POST", "/lease", { action: "invalid" }, 1_000, { pairingToken: pair.token });
		assert.equal(unknown.status, 400);
		assert.deepEqual(unknown.json, { ok: false, error: "unknown lease action: invalid" });
	} finally {
		await handle.close();
	}
});

test("daemon lease route transfers lease after release", async () => {
	isolateAuthStore();
	const holder = await activePairing("holder");
	const contender = await activePairing("contender");
	const handle = await startDaemonForRouteTest();
	try {
		const acquired = await controlRequest(handle, "POST", "/lease", { action: "acquire", ttlMs: 30_000 }, 1_000, { pairingToken: holder.token });
		assert.equal(acquired.status, 200);
		const busy = await controlRequest(handle, "POST", "/lease", { action: "acquire", ttlMs: 30_000 }, 1_000, { pairingToken: contender.token });
		assert.equal(busy.status, 409);
		assert.equal(busy.json?.code, AUTH_ERROR_CODES.leaseBusy);
		const released = await controlRequest(handle, "POST", "/lease", { action: "release" }, 1_000, { pairingToken: holder.token });
		assert.equal(released.status, 200);
		const transferred = await controlRequest(handle, "POST", "/lease", { action: "acquire", ttlMs: 30_000 }, 1_000, { pairingToken: contender.token });
		assert.equal(transferred.status, 200);
		assert.equal(((transferred.json?.lease as Record<string, unknown>)?.pairingId), contender.pairingId);
	} finally {
		await handle.close();
	}
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
		assert.deepEqual((before.json?.agents as Array<Record<string, unknown>>).map(({ pairingId, status, leaseHeld }) => ({ pairingId, status, leaseHeld })), [{ pairingId: pair.pairingId, status: "active", leaseHeld: false }]);

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
