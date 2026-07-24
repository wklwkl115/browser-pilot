import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { handleInvokeRoute, startDaemon } from "../../src/apps/daemon/server.ts";
import { invokeDaemonTool } from "../../src/apps/mcp/client.ts";
import { controlRequest, lockfilePath, readLockfile, removeLockfile, writeLockfile, type DaemonInfo } from "../../src/apps/daemon/daemonControl.ts";
import { createDaemonContractIdentity, localDaemonContractIdentity } from "../../src/apps/daemon/contractIdentity.ts";
import { strictCommandParameters } from "../../src/commands/commandShared.ts";
import type { CommandDefinition } from "../../src/commands/commandManifestIndex.ts";
import { errorResult } from "../../src/utils/toolResult.ts";

const originalDaemonStateDir = process.env.BROWSER_PILOT_DAEMON_STATE_DIR;

function isolateDaemonState() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-daemon-state-"));
	process.env.BROWSER_PILOT_DAEMON_STATE_DIR = dir;
	return dir;
}

function restoreEnv() {
	if (originalDaemonStateDir === undefined) delete process.env.BROWSER_PILOT_DAEMON_STATE_DIR;
	else process.env.BROWSER_PILOT_DAEMON_STATE_DIR = originalDaemonStateDir;
}

async function invoke(options: {
	body: Record<string, unknown>;
	toolByName: Map<string, CommandDefinition>;
}) {
	let response: { status: number; json: Record<string, unknown> } | undefined;
	const contractIdentity = createDaemonContractIdentity([...options.toolByName.values()]);
	await handleInvokeRoute({
		send(status, obj) {
			response = { status, json: JSON.parse(JSON.stringify(obj)) as Record<string, unknown> };
		},
		body: { contractIdentity, ...options.body },
		toolByName: options.toolByName,
		contractIdentity,
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
	restoreEnv();
});

test("daemon invoke executes directly without browser approval", async () => {
	const res = await invoke({ body: { tool: "browser_success", params: { message: "ok" }, cwd: "project" }, toolByName: tools() });
	assert.equal(res.status, 200);
	assert.deepEqual(res.json.content, [{ type: "text", text: "ok" }]);
	assert.deepEqual(res.json.details, { cwd: "project" });
});

test("daemon invoke rejects unknown tools", async () => {
	const res = await invoke({ body: { tool: "browser_missing", params: {} }, toolByName: tools() });
	assert.equal(res.status, 404);
	assert.equal(res.json.error, "unknown tool: browser_missing");
});

test("daemon invoke validates parameters", async () => {
	const res = await invoke({ body: { tool: "browser_success", params: {} }, toolByName: tools() });
	assert.equal(res.status, 400);
	assert.equal(res.json.code, "COMMAND_VALIDATION_FAILED");
	assert.match(String(res.json.error), /Invalid parameters/);
	assert.ok(Array.isArray(res.json.issues));
});

test("daemon invoke rejects a mismatched contract before command dispatch", async () => {
	let dispatched = false;
	const command: CommandDefinition = {
		name: "browser_never",
		parameters: strictCommandParameters({}),
		execute() { dispatched = true; return { content: [] }; },
	};
	const res = await invoke({ body: { tool: command.name, params: {}, contractIdentity: {} }, toolByName: new Map([[command.name, command]]) });
	assert.equal(res.status, 409);
	assert.equal(res.json.code, "DAEMON_CONTRACT_MISMATCH");
	assert.equal(dispatched, false);
});

test("daemon invoke wraps command throws as terminating success envelope", async () => {
	const res = await invoke({ body: { tool: "browser_throw", params: {} }, toolByName: tools() });
	assert.equal(res.status, 200);
	assert.equal(res.json.ok, true);
	assert.deepEqual(res.json.content, [{ type: "text", text: "boom from command" }]);
	assert.equal(res.json.terminate, true);
	assert.equal(res.json.isError, true);
});

test("daemon invoke preserves non-terminating command error semantics", async () => {
	const res = await invoke({ body: { tool: "browser_error", params: {} }, toolByName: tools() });
	assert.equal(res.status, 200);
	assert.equal(res.json.isError, true);
	assert.equal(res.json.terminate, false);
});

test("daemon aborts an active invocation when the control client disconnects", async () => {
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
				headers: { "x-browser-pilot-daemon-token": handle.token, "content-type": "application/json" },
		});
		req.on("error", () => undefined);
		req.end(JSON.stringify({ tool: "browser_slow", params: {}, contractIdentity: handle.contractIdentity }));
		await started;
		req.destroy();
		await Promise.race([aborted, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("invoke signal was not aborted")), 1_000))]);
	} finally {
		await handle.close();
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
	if (process.platform !== "win32") assert.equal(statSync(lockfilePath()).mode & 0o777, 0o600);
	removeLockfile();
	assert.equal(existsSync(lockfilePath()), false);
	removeLockfile();
});

test("daemon status, connect, and unknown routes preserve control contracts", async () => {
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

test("MCP client reuses one validated daemon and never replays an uncertain invoke", async () => {
	isolateDaemonState();
	const contractIdentity = localDaemonContractIdentity();
	let statusRequests = 0;
	let invokeRequests = 0;
	let resetNextInvoke = false;
	const invokeBodies: Record<string, unknown>[] = [];
	const server = http.createServer(async (req, res) => {
		const send = (status: number, body: Record<string, unknown>) => {
			const json = JSON.stringify(body);
			res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
			res.end(json);
		};
		if (req.headers["x-browser-pilot-daemon-token"] !== "cached-daemon-token") return send(401, { ok: false });
		if (req.method === "GET" && req.url === "/status") {
			statusRequests += 1;
			return send(200, { ok: true, contractIdentity });
		}
		if (req.method === "POST" && req.url === "/invoke") {
			invokeRequests += 1;
			let raw = "";
			for await (const chunk of req) raw += String(chunk);
			invokeBodies.push(JSON.parse(raw) as Record<string, unknown>);
			if (resetNextInvoke) {
				req.socket.destroy();
				return;
			}
			return send(200, { ok: true, content: [{ type: "text", text: "{}" }] });
		}
		return send(404, { ok: false });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected TCP listener address");
		writeLockfile(daemonInfo({ controlPort: address.port, token: "cached-daemon-token", contractIdentity }));
		await invokeDaemonTool("browser_tabs", { action: "list" }, process.cwd());
		await invokeDaemonTool("browser_tabs", { action: "list" }, process.cwd());
		resetNextInvoke = true;
		await assert.rejects(invokeDaemonTool("browser_tabs", { action: "list" }, process.cwd()));
		assert.equal(statusRequests, 1);
		assert.equal(invokeRequests, 3);
		assert.deepEqual(invokeBodies.map((body) => body.contractIdentity), [contractIdentity, contractIdentity, contractIdentity]);
	} finally {
		removeLockfile();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
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
