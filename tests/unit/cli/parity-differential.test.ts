// Differential frontend parity: the pi-browser CLI and the Pi-native host share ONE
// tool core (registerBrowserTools → def.execute). This proves the CLI frontend does not
// alter tool semantics: for the same (tool, params, cwd), the result envelope from
//   A) direct def.execute(..., {cwd, hasUI:false})   — the Pi-native path
//   B) daemon POST /invoke {tool, params, cwd}        — the CLI path
// must be identical after normalizing inherently-variable fields (bridge port, ids,
// timestamps, durations, the cwd-rooted prefix). Browser-free / deterministic-error
// cases keep this hermetic — no live browser needed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserBridgeServer } from "../../../src/driver/BrowserBridgeServer.ts";
import { ToolCollectingAdapter } from "../../../src/frontend/toolCollector.ts";
import { registerBrowserTools } from "../../../src/tools/registerTools.ts";
import { validateToolArgs } from "../../../src/frontend/validation.ts";
import { startDaemon } from "../../../cli/daemon.ts";
import { controlRequest } from "../../../cli/daemonControl.ts";

// Cases chosen to be deterministic + browser-free:
//  - execute/tabs return a structured NO_TAB / NO_BROWSER_EXTENSION envelope (no extension)
//  - memory recall reads the local (empty) store under cwd/.pi/browser-memory
const CASES = [
	{ tool: "browser_execute", params: { script: "2 + 2" } },
	{ tool: "browser_tabs", params: { action: "list" } },
	{ tool: "browser_memory", params: { action: "recall" } },
];

function normalize(text: string, cwd: string): string {
	return text
		.split(cwd).join("<CWD>")
		.split(cwd.replace(/\\/g, "/")).join("<CWD>")
		.replace(/\\\\/g, "/").replace(/\\/g, "/")
		.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<TS>")
		.replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<PORT>")
		.replace(/"port":\s*\d+/g, '"port":<PORT>')
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>")
		.replace(/"(operationId|snapshotId|requestId|waitId|listenerId|callId|clientId)":\s*"[^"]*"/g, '"$1":"<ID>"')
		.replace(/"(durationMs|elapsedMs|tookMs|bytes|mtimeMs|startedAt|updatedAt)":\s*\d+/g, '"$1":<NUM>');
}

function envelopeText(content: unknown): string {
	return Array.isArray(content) ? content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("\n") : "";
}

test("CLI /invoke and Pi-native execute produce identical envelopes for the same params", async () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-parity-"));

	// A) the Pi-native surface: one adapter over its own server (same registration).
	const serverA = new BrowserBridgeServer();
	let startA: Promise<void> | undefined;
	const ensureStartedA = async () => {
		if (!startA) startA = serverA.start().catch((e) => { startA = undefined; throw e; });
		await startA;
		return serverA;
	};
	const adapterA = new ToolCollectingAdapter();
	registerBrowserTools(adapterA, serverA, ensureStartedA);

	// B) the CLI surface: the daemon (its own server), driven over the control channel.
	const handle = await startDaemon({ writeLock: false });
	const info = { controlHost: handle.controlHost, controlPort: handle.controlPort, token: handle.token };

	try {
		for (const { tool, params } of CASES) {
			const def = adapterA.getTool(tool);
			assert.ok(def, `tool ${tool} is registered`);
			const prepared = def!.prepareArguments ? def!.prepareArguments(params) : params;
			const v = validateToolArgs(def!.parameters, prepared);
			assert.ok(v.ok, `params validate for ${tool}: ${v.ok ? "" : v.error}`);

			const a = await def!.execute(`parity-${tool}`, (v as { args: Record<string, unknown> }).args, undefined, undefined, { cwd, hasUI: false });
			const { status, json } = await controlRequest(info, "POST", "/invoke", { tool, params, cwd });
			assert.equal(status, 200, `daemon /invoke ${tool} → 200`);

			const aNorm = normalize(envelopeText(a.content), cwd);
			const bNorm = normalize(envelopeText(json?.content), cwd);
			assert.ok(aNorm.length > 30, `${tool} produced a non-trivial envelope (guards against a vacuous match)`);
			assert.equal(bNorm, aNorm, `envelope parity for ${tool}`);
			assert.equal(json?.terminate === true, a.terminate === true, `terminate parity for ${tool}`);
		}
	} finally {
		await handle.close();
		await serverA.stop().catch(() => {});
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("deprecated mechanical params are tolerated via prepareArguments on both Pi-native and CLI paths", async () => {
	const cwd = mkdtempSync(path.join(os.tmpdir(), "pi-prepare-"));
	const serverA = new BrowserBridgeServer();
	const adapterA = new ToolCollectingAdapter();
	registerBrowserTools(adapterA, serverA, async () => serverA);
	const def = adapterA.getTool("browser_tabs");
	assert.ok(def, "browser_tabs is registered");
	const raw = { action: "list", detailLevel: "summary", maxChars: 1000, timeoutMs: 10 };
	const prepared = def!.prepareArguments ? def!.prepareArguments(raw) : raw;
	assert.deepEqual(prepared, { action: "list" });
	const validation = validateToolArgs(def!.parameters, prepared);
	assert.ok(validation.ok, validation.ok ? "" : validation.error);

	const handle = await startDaemon({ writeLock: false });
	const info = { controlHost: handle.controlHost, controlPort: handle.controlPort, token: handle.token };
	try {
		const { status, json } = await controlRequest(info, "POST", "/invoke", { tool: "browser_tabs", params: raw, cwd });
		assert.equal(status, 200);
		assert.equal(json?.ok, true);
		assert.equal(json?.terminate === true, false);
	} finally {
		await handle.close();
		await serverA.stop().catch(() => {});
		rmSync(cwd, { recursive: true, force: true });
	}
});
