/**
 * pi-browser bridge daemon — the long-lived process that owns the live browser.
 *
 * Holds one BrowserBridgeServer (started lazily on the first tool invocation, as
 * in the MCP/Pi hosts) and exposes a token-guarded loopback control server:
 *   POST /invoke   {tool, params, cwd}  → run a tool, return {content, details, terminate}
 *   GET  /status                        → {ok, bridgePort, running, extensionConnected, tabs, tools}
 *   POST /shutdown                       → stop the bridge + control server
 *
 * `cwd` arrives per-invoke and is passed to execute as ctx.cwd, so artifact/memory
 * roots stay scoped to the *caller*, not the daemon. The daemon is a user-local
 * singleton (see daemonControl.ts); its lockfile lives in a user-local state root.
 *
 * startDaemon() is also importable for in-process lifecycle tests (writeLock:false).
 */
import http from "node:http";
import { randomBytes } from "node:crypto";
import { BrowserBridgeServer } from "../src/driver/BrowserBridgeServer.js";
import { registerBrowserTools } from "../src/tools/registerTools.js";
import type { EnsureStarted } from "../src/tools/toolShared.js";
import { ToolCollectingAdapter, type ToolDefinition } from "../src/frontend/toolCollector.js";
import { resolveBrowserResultEvidence } from "../src/resources/memoryResourceStore.js";
import { validateToolArgs } from "../src/frontend/validation.js";
import { registerHook, emitLog, timingLogHook, type MiddlewareContext } from "../src/frontend/middleware.js";
import { resolveUsageLogOptions, createUsageLogHook } from "../src/frontend/usageLog.js";
import { isRecord } from "../src/utils/records.js";
import { strippedDeprecatedParamKeys } from "../src/tools/prepareArguments.js";
import { writeLockfile, removeLockfile, type DaemonInfo } from "./daemonControl.js";
import { daemonVersion } from "./packageInfo.js";

export const DAEMON_VERSION = daemonVersion();
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface DaemonHandle {
	controlHost: string;
	controlPort: number;
	token: string;
	bridgePort: number;
	close: () => Promise<void>;
}

export interface StartDaemonOptions {
	/** Write the user-local singleton lockfile (default true). Tests pass false. */
	writeLock?: boolean;
	/** Called after /shutdown has closed the server (foreground daemon exits the process here). */
	onShutdown?: () => void;
}

type CliInvokeMetadata = {
	command?: string;
	routing?: string;
	naturalSubcommand?: string;
	action?: string;
	compatibilityInterface?: string;
};

let hooksRegistered = false;
function registerDaemonHooks(): void {
	if (hooksRegistered) return;
	hooksRegistered = true;
	registerHook("on_log", timingLogHook);
	const usage = resolveUsageLogOptions();
	if (usage.enabled) {
		registerHook("on_log", createUsageLogHook(usage));
		console.error(`[pi-browser] usage logging → ${usage.filePath}${usage.raw ? " (raw args)" : ""}`);
	}
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let buf = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			buf += chunk;
			if (buf.length > MAX_BODY_BYTES) {
				reject(new Error("request body too large"));
				req.destroy();
			}
		});
		req.on("end", () => {
			try {
				resolve(buf ? (JSON.parse(buf) as Record<string, unknown>) : {});
			} catch (error) {
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
		req.on("error", reject);
	});
}

function safeTabs(server: BrowserBridgeServer): unknown[] {
	try {
		return server.getTabs();
	} catch {
		return [];
	}
}

function activeTabFrom(tabs: unknown[]): unknown {
	return tabs.find((tab) => typeof tab === "object" && tab && (tab as { active?: unknown }).active === true) ?? tabs[0] ?? null;
}

function bridgeStatusPayload(server: BrowserBridgeServer, toolCount: number, includeTabs: boolean): Record<string, unknown> {
	const tabs = safeTabs(server);
	let snapshot;
	try {
		snapshot = server.snapshot();
	} catch {
		snapshot = undefined;
	}
	const extension = snapshot?.extension;
	const lastTabSyncAt = server.getLastTabSyncAt();
	const now = Date.now();
	return {
		ok: true,
		bridgePort: server.running ? server.port : undefined,
		running: server.running,
		extensionConnected: snapshot?.extensionConnected === true,
		tabCount: tabs.length,
		activeTab: activeTabFrom(tabs),
		health: {
			connectedAt: extension?.connectedAt,
			lastSeenAt: extension?.lastSeenAt,
			lastPingAt: extension?.lastPingAt,
			lastPongAt: extension?.lastPongAt,
			connectedForMs: typeof extension?.connectedAt === "number" ? Math.max(0, now - extension.connectedAt) : undefined,
			tabSyncAt: lastTabSyncAt,
			tabSyncAgeMs: typeof lastTabSyncAt === "number" ? Math.max(0, now - lastTabSyncAt) : undefined,
			connectedClients: snapshot?.connectedClients,
		},
		...(includeTabs ? { tabs } : {}),
		tools: toolCount,
	};
}

/** Construct the daemon, start its control server, and (optionally) write the lockfile. */
export async function startDaemon(options: StartDaemonOptions = {}): Promise<DaemonHandle> {
	const writeLock = options.writeLock ?? true;
	registerDaemonHooks();

	const bridgeServer = new BrowserBridgeServer();

	let startPromise: Promise<void> | undefined;
	const ensureStarted: EnsureStarted = async () => {
		if (!startPromise) {
			startPromise = bridgeServer.start().catch((error) => {
				startPromise = undefined;
				throw error;
			});
		}
		await startPromise;
		return bridgeServer;
	};

	const adapter = new ToolCollectingAdapter();
	registerBrowserTools(adapter, bridgeServer, ensureStarted, {
		memoryEvidenceResolver: resolveBrowserResultEvidence,
	});
	const toolByName = new Map<string, ToolDefinition>(adapter.getTools().map((def) => [def.name, def]));
	const toolCount = toolByName.size;

	const token = randomBytes(24).toString("hex");
	const usageEnabled = resolveUsageLogOptions().enabled;

	let closing = false;
	const close = async (): Promise<void> => {
		if (closing) return;
		closing = true;
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await bridgeServer.stop().catch(() => {
			/* best-effort */
		});
		if (writeLock) removeLockfile();
	};

	const server = http.createServer((req, res) => {
		void handleControlRequest(req, res);
	});

	async function handleControlRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const send = (status: number, obj: Record<string, unknown>): void => {
			const body = JSON.stringify(obj);
			res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
			res.end(body);
		};
		// Loopback + token are the only auth — never expose this server off 127.0.0.1.
		if (req.headers["x-pi-daemon-token"] !== token) return send(401, { ok: false, error: "unauthorized" });
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const pathname = url.pathname;
		try {
			if (req.method === "GET" && pathname === "/status") {
				return send(200, bridgeStatusPayload(bridgeServer, toolCount, url.searchParams.get("tabs") === "1"));
			}
			if (req.method === "POST" && pathname === "/shutdown") {
				send(200, { ok: true });
				setImmediate(() => {
					// Fire onShutdown (process.exit for the foreground daemon) even if close()
					// hangs on a slow bridge stop — a wedged close must never keep the daemon alive.
					let done = false;
					const finish = () => { if (done) return; done = true; options.onShutdown?.(); };
					const force = setTimeout(finish, 1_500);
					force.unref?.();
					void close().then(() => { clearTimeout(force); finish(); }, () => { clearTimeout(force); finish(); });
				});
				return;
			}
			if (req.method === "POST" && pathname === "/connect") {
				const body = await readBody(req);
				const wait = body.wait === true;
				const timeoutMs = Math.max(0, Math.min(120_000, Math.floor(Number(body.timeoutMs ?? 0) || 0)));
				const includeTabs = body.tabs === true;
				const wasRunning = bridgeServer.running;
				await ensureStarted();
				if (wait) await bridgeServer.waitForExtensionReady(undefined, timeoutMs);
				const status = bridgeStatusPayload(bridgeServer, toolCount, includeTabs);
				return send(200, { ok: true, startedBridge: !wasRunning && bridgeServer.running, status });
			}
			if (req.method === "POST" && pathname === "/invoke") {
				const body = await readBody(req);
				const tool = typeof body.tool === "string" ? body.tool : "";
				const params = isRecord(body.params) ? body.params : {};
				const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
				const cli = isRecord(body.cli) ? body.cli as CliInvokeMetadata : undefined;
				const def = toolByName.get(tool);
				if (!def) return send(404, { ok: false, error: `unknown tool: ${tool || "(missing)"}` });
				const prepared = (def.prepareArguments ? def.prepareArguments(params) : params) as Record<string, unknown>;
				const strippedDeprecatedParams = strippedDeprecatedParamKeys(params, prepared);
				const validation = validateToolArgs(def.parameters, prepared);
				if (!validation.ok) return send(400, { ok: false, error: validation.error });
				const ctx: MiddlewareContext = {
					method: "invoke",
					toolName: tool,
					startedAt: Date.now(),
					...(usageEnabled ? { args: validation.args } : {}),
					...(usageEnabled && cli ? { cli } : {}),
				};
				try {
					const result = await def.execute(`cli-${tool}-${Date.now()}`, validation.args, undefined, undefined, { cwd, hasUI: false });
					if (usageEnabled) ctx.resultBytes = JSON.stringify(result.content).length;
					emitLog(ctx, Date.now() - ctx.startedAt, result.terminate ? "error" : "ok", strippedDeprecatedParams.length ? { strippedDeprecatedParams } : undefined);
					return send(200, { ok: true, content: result.content, details: result.details, terminate: result.terminate === true });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					emitLog(ctx, Date.now() - ctx.startedAt, "error", { error: message, ...(strippedDeprecatedParams.length ? { strippedDeprecatedParams } : {}) });
					return send(200, { ok: true, content: [{ type: "text", text: message }], terminate: true });
				}
			}
			return send(404, { ok: false, error: `not found: ${req.method} ${pathname}` });
		} catch (error) {
			return send(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	const controlPort = typeof address === "object" && address ? address.port : 0;

	if (writeLock) {
		const info: DaemonInfo = {
			pid: process.pid,
			controlHost: "127.0.0.1",
			controlPort,
			token,
			startedAt: new Date().toISOString(),
			version: DAEMON_VERSION,
		};
		writeLockfile(info);
	}

	return { controlHost: "127.0.0.1", controlPort, token, bridgePort: bridgeServer.running ? bridgeServer.port : 0, close };
}
