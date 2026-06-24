import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { handleInvokeRoute } from "../../src/apps/daemon/server.ts";
import { controlRequest } from "../../src/apps/daemon/daemonControl.ts";
import { TenantLeaseRegistry } from "../../src/apps/daemon/tenantLease.ts";
import { AUTH_ERROR_CODES, ENV_AUTH_STATE_DIR, PAIRING_TOKEN_HEADER } from "../../src/apps/daemon/authTypes.ts";
import * as authStore from "../../src/apps/daemon/authStore.ts";
import { strictCommandParameters } from "../../src/commands/commandShared.ts";
import type { CommandDefinition } from "../../src/commands/commandManifestIndex.ts";

const originalAuthStateDir = process.env[ENV_AUTH_STATE_DIR];
const originalRequirePairing = process.env.BROWSER_PILOT_REQUIRE_PAIRING;

function isolateAuthStore() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "browser-pilot-invoke-auth-"));
	process.env[ENV_AUTH_STATE_DIR] = dir;
	delete process.env.BROWSER_PILOT_REQUIRE_PAIRING;
	return dir;
}

function restoreEnv() {
	if (originalAuthStateDir === undefined) delete process.env[ENV_AUTH_STATE_DIR];
	else process.env[ENV_AUTH_STATE_DIR] = originalAuthStateDir;
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
				details: { cwd: ctx?.cwd, hasUI: ctx?.hasUI, omitTransportDetails: ctx?.omitTransportDetails },
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
	return new Map<string, CommandDefinition>([[success.name, success], [throwing.name, throwing]]);
}

async function activePairing(label: string) {
	const pending = authStore.mintPending(label);
	const approved = await authStore.approve(pending.pairingId);
	assert.ok(approved);
	return { pairingId: pending.pairingId, token: approved.token };
}

test.afterEach(() => {
	restoreEnv();
});

test("daemon invoke allows legacy requests when pairing is not required", async () => {
	isolateAuthStore();
	const res = await invoke({ body: { tool: "browser_success", params: { message: "ok" }, cwd: "project" }, toolByName: tools() });
	assert.equal(res.status, 200);
	assert.deepEqual(res.json.content, [{ type: "text", text: "ok" }]);
	assert.equal(res.json.terminate, false);
	assert.deepEqual(res.json.details, { cwd: "project", hasUI: false });
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

test("daemon invoke returns validation errors before authorization", async () => {
	isolateAuthStore();
	await activePairing("agent-a");
	const res = await invoke({ body: { tool: "browser_success", params: {} }, toolByName: tools() });
	assert.equal(res.status, 400);
	assert.match(String(res.json.error), /Invalid parameters/);
	assert.match(String(res.json.error), /message/);
});

test("daemon invoke wraps command throws as terminating success envelope", async () => {
	isolateAuthStore();
	const pair = await activePairing("agent-a");
	const res = await invoke({ body: { tool: "browser_throw", params: {} }, toolByName: tools(), headers: { [PAIRING_TOKEN_HEADER]: pair.token } });
	assert.equal(res.status, 200);
	assert.equal(res.json.ok, true);
	assert.deepEqual(res.json.content, [{ type: "text", text: "boom from command" }]);
	assert.equal(res.json.terminate, true);
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
				assert.equal(typeof address, "object");
				await controlRequest({ controlHost: "127.0.0.1", controlPort: address!.port, token: "daemon-token" }, "POST", "/invoke", {}, 1_000, { pairingToken: "pair-token" });
			} catch (error) {
				reject(error);
			} finally {
				server.close();
			}
		});
	});
	assert.equal(seen, "pair-token");
});
