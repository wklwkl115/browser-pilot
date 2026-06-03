// Daemon control-channel lifecycle, in-process (no spawn, no live browser).
// Starts the daemon with writeLock:false and drives /status, auth, unknown-tool,
// and param-validation through the loopback control server, then closes it.
// We never call stopDaemon() here — an in-process daemon's pid IS this test
// process, and stopDaemon would SIGTERM us. handle.close() is the safe teardown.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDaemon } from "../../../cli/daemon.ts";
import { controlRequest, findDaemon } from "../../../cli/daemonControl.ts";
import { buildCliCommands } from "../../../cli/registry.ts";

function rawGet(port: number, pathname: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, method: "GET", path: pathname, headers }, (res) => {
			let buf = "";
			res.setEncoding("utf8");
			res.on("data", (c) => { buf += c; });
			res.on("end", () => { let body: unknown; try { body = buf ? JSON.parse(buf) : undefined; } catch { body = buf; } resolve({ status: res.statusCode ?? 0, body }); });
		});
		req.on("error", reject);
		req.setTimeout(3_000, () => req.destroy(new Error("timeout")));
		req.end();
	});
}

test("daemon control channel: auth, status, unknown tool, validation", async () => {
	const handle = await startDaemon({ writeLock: false });
	const info = { controlHost: handle.controlHost, controlPort: handle.controlPort, token: handle.token };
	try {
		// Token guard: no token → 401.
		const unauth = await rawGet(handle.controlPort, "/status");
		assert.equal(unauth.status, 401, "missing token is rejected");

		// /status with token → 200, tools registered, bridge not yet started.
		const status = await controlRequest(info, "GET", "/status");
		assert.equal(status.status, 200);
		assert.equal(status.json?.ok, true);
		assert.equal(status.json?.running, false, "bridge starts lazily — not running before any invoke");
		assert.ok(typeof status.json?.tools === "number" && (status.json.tools as number) > 0, "tools are registered");

		// Unknown tool → 404 ok:false (no browser touched).
		const unknown = await controlRequest(info, "POST", "/invoke", { tool: "browser_does_not_exist", params: {} });
		assert.equal(unknown.status, 404);
		assert.equal(unknown.json?.ok, false);

		// Param validation runs before execute: a tool with required params + {} → 400.
		const withRequired = buildCliCommands().find((c) => {
			const req = (c.parameters as { required?: unknown })?.required;
			return Array.isArray(req) && req.length > 0;
		});
		if (withRequired) {
			const invalid = await controlRequest(info, "POST", "/invoke", { tool: withRequired.name, params: {} });
			assert.equal(invalid.status, 400, `validation rejects empty params for ${withRequired.name}`);
			assert.equal(invalid.json?.ok, false);
		}
	} finally {
		await handle.close();
	}
});

test("findDaemon discovers a live daemon via its lockfile", async () => {
	const prev = process.env.PI_BROWSER_DAEMON_STATE_DIR;
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-daemon-live-"));
	process.env.PI_BROWSER_DAEMON_STATE_DIR = dir;
	const handle = await startDaemon({ writeLock: true });
	try {
		const found = await findDaemon();
		assert.ok(found, "lockfile-backed daemon is discoverable");
		assert.equal(found!.info.controlPort, handle.controlPort);
		assert.equal(found!.status.ok, true);
		assert.equal(found!.status.tools as number, (await controlRequest({ controlHost: handle.controlHost, controlPort: handle.controlPort, token: handle.token }, "GET", "/status")).json?.tools);
	} finally {
		await handle.close(); // removes the lockfile (writeLock:true)
		assert.equal(existsSync(path.join(dir, "browser-daemon.json")), false, "close() reclaims the lockfile");
		if (prev === undefined) delete process.env.PI_BROWSER_DAEMON_STATE_DIR;
		else process.env.PI_BROWSER_DAEMON_STATE_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
});
