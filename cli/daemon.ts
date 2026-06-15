/**
 * browser-pilot bridge daemon — the long-lived process that owns the live browser.
 *
 * Holds one BrowserBridgeServer (started lazily on the first tool invocation)
 * and exposes a token-guarded loopback control server:
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
import { ToolRegistryAdapter, type ToolDefinition } from "../src/frontend/toolCollector.js";
import { resolveBrowserResultEvidence } from "../src/resources/memoryResourceStore.js";
import { validateToolArgs } from "../src/frontend/validation.js";
import { registerHook, emitLog, timingLogHook, type MiddlewareContext } from "../src/frontend/middleware.js";
import { resolveUsageLogOptions, createUsageLogHook } from "../src/frontend/usageLog.js";
import { isRecord } from "../src/utils/records.js";
import { strippedDeprecatedParamKeys } from "../src/tools/prepareArguments.js";
import { writeLockfile, removeLockfile, type DaemonInfo } from "./daemonControl.js";
import { daemonVersion } from "./packageInfo.js";
import * as authStore from "./authStore.js";
import { TenantLeaseRegistry } from "./tenantLease.js";
import {
	AUTH_ERROR_CODES,
	PAIRING_TOKEN_HEADER,
	PAIR_PENDING_TTL_MS,
	ENV_REQUIRE_PAIRING,
	type PairingSummary,
} from "./authTypes.js";
import type { ConsentDecision } from "./authTypes.js";

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
		console.error(`[browser-pilot] usage logging → ${usage.filePath}${usage.raw ? " (raw args)" : ""}`);
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
		extension: extension ? {
			id: extension.extensionId,
			name: extension.name,
			version: extension.version,
			build: extension.build,
			extensionStale: extension.extensionStale,
			expectedBuild: extension.expectedBuild,
			reportedBuild: extension.reportedBuild,
			buildManifestPath: extension.buildManifestPath,
		} : undefined,
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

	const tenantLease = new TenantLeaseRegistry();

	function composeSummaries(): PairingSummary[] {
		return authStore.listAgents().map((r) => ({
			pairingId: r.pairingId,
			label: r.label,
			status: r.status,
			lastSeenAt: r.lastSeenAt,
			leaseHeld: tenantLease.holderPairingId() === r.pairingId,
		}));
	}

	bridgeServer.onRevokeRequest((pairingId: string) => {
		authStore.revoke(pairingId);
		tenantLease.forceRelease(pairingId);
		bridgeServer.broadcastPairedAgents(composeSummaries());
	});

	const pendingPairResults = new Map<string, Promise<{ decision: ConsentDecision; token?: string }>>();

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

	const adapter = new ToolRegistryAdapter();
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
		tenantLease.stop();
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
				try {
					await ensureStarted();
				} catch (error) {
					return send(503, {
						ok: false,
						code: "CLI_BRIDGE_START_FAILED",
						error: error instanceof Error ? error.message : String(error),
						status: bridgeStatusPayload(bridgeServer, toolCount, includeTabs),
					});
				}
				if (wait) {
					await bridgeServer.waitForExtensionReady(undefined, timeoutMs);
					// Best-effort: push the current paired-agent list to the freshly-connected extension.
					try { bridgeServer.broadcastPairedAgents(composeSummaries()); } catch { /* best-effort */ }
				}
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
				// Connection-authorization enforcement.
				// Grace mode: when no active agents exist AND env is not set, allow legacy ungated path.
				const requirePairing = process.env[ENV_REQUIRE_PAIRING] === "1" || authStore.hasActiveAgents();
				if (requirePairing) {
					const ptoken = req.headers[PAIRING_TOKEN_HEADER];
					const rec = authStore.findByToken(typeof ptoken === "string" ? ptoken : undefined);
					if (!rec) return send(401, { ok: false, code: AUTH_ERROR_CODES.pairingInvalid });
					if (rec.status === "revoked") return send(403, { ok: false, code: AUTH_ERROR_CODES.pairingRevoked });
					if (rec.status !== "active") return send(401, { ok: false, code: AUTH_ERROR_CODES.pairingInvalid });
					const held = tenantLease.ensureHeld(rec.pairingId, rec.label);
					if (!held.ok) return send(409, { ok: false, code: AUTH_ERROR_CODES.leaseBusy, heldBy: (held as { ok: false; heldBy: unknown }).heldBy });
					authStore.touch(rec.pairingId);
				}
				const ctx: MiddlewareContext = {
					method: "invoke",
					toolName: tool,
					startedAt: Date.now(),
					...(usageEnabled ? { args: validation.args } : {}),
					...(usageEnabled && cli ? { cli } : {}),
				};
				try {
					const result = await def.execute(`cli-${tool}-${Date.now()}`, validation.args, undefined, undefined, { cwd, hasUI: false, ...(cli ? { omitTransportDetails: true } : {}) });
					if (usageEnabled) ctx.resultBytes = JSON.stringify(result.content).length;
					emitLog(ctx, Date.now() - ctx.startedAt, result.terminate ? "error" : "ok", strippedDeprecatedParams.length ? { strippedDeprecatedParams } : undefined);
					const terminate = result.terminate === true;
					return send(200, { ok: true, content: result.content, ...(cli && !terminate ? {} : { details: result.details }), terminate });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					emitLog(ctx, Date.now() - ctx.startedAt, "error", { error: message, ...(strippedDeprecatedParams.length ? { strippedDeprecatedParams } : {}) });
					return send(200, { ok: true, content: [{ type: "text", text: message }], terminate: true });
				}
			}
			if (req.method === "POST" && pathname === "/pair/start") {
					const { label } = await readBody(req);
					if (!bridgeServer.hasConsentSurface()) {
						return send(409, { ok: false, code: AUTH_ERROR_CODES.pairNoExtension });
					}
					authStore.sweepExpiredPending();
					const { pairingId, code } = authStore.mintPending(String(label ?? "agent"));
					const expiresAt = new Date(Date.now() + PAIR_PENDING_TTL_MS).toISOString();
					const resultP = bridgeServer
						.sendConsentRequest({ pairingId, label: String(label ?? "agent"), code, expiresAt, timeoutMs: PAIR_PENDING_TTL_MS })
						.then((decision: ConsentDecision) => {
							if (decision === "approve") {
								const r = authStore.approve(pairingId);
								bridgeServer.broadcastPairedAgents(composeSummaries());
								return { decision, token: r?.token };
							}
							authStore.deny(pairingId);
							return { decision };
						})
						.catch((): { decision: ConsentDecision; token?: string } => {
							authStore.deny(pairingId);
							return { decision: "timeout" as ConsentDecision };
						});
					pendingPairResults.set(pairingId, resultP);
					return send(200, { ok: true, pairingId, code });
				}
				if (req.method === "POST" && pathname === "/pair/wait") {
					const { pairingId } = await readBody(req);
					const p = pendingPairResults.get(String(pairingId));
					if (!p) return send(408, { ok: false, code: AUTH_ERROR_CODES.pairTimeout });
					const res = await p;
					pendingPairResults.delete(String(pairingId));
					if (res.decision === "approve" && res.token) {
						return send(200, { ok: true, token: res.token });
					}
					if (res.decision === "deny") {
						return send(403, { ok: false, code: AUTH_ERROR_CODES.pairDenied });
					}
					return send(408, { ok: false, code: AUTH_ERROR_CODES.pairTimeout });
				}
				if (req.method === "POST" && pathname === "/lease") {
					const pairingToken = req.headers[PAIRING_TOKEN_HEADER];
					const rec = authStore.findByToken(typeof pairingToken === "string" ? pairingToken : undefined);
					if (!rec) return send(401, { ok: false, code: AUTH_ERROR_CODES.pairingInvalid });
					if (rec.status === "revoked") return send(403, { ok: false, code: AUTH_ERROR_CODES.pairingRevoked });
					if (rec.status !== "active") return send(401, { ok: false, code: AUTH_ERROR_CODES.pairingInvalid });
					const { action, ttlMs } = await readBody(req);
					if (action === "acquire") {
						const r = tenantLease.acquire(rec.pairingId, rec.label, typeof ttlMs === "number" ? ttlMs : undefined);
						if (!r.ok) {
							return send(409, { ok: false, code: AUTH_ERROR_CODES.leaseBusy, heldBy: (r as { ok: false; heldBy: unknown }).heldBy });
						}
						return send(200, { ok: true, lease: r.lease });
					}
					if (action === "release") {
						tenantLease.release(rec.pairingId);
						return send(200, { ok: true });
					}
					if (action === "status") {
						const lease = tenantLease.status();
						return send(200, { ok: true, lease, self: lease?.pairingId === rec.pairingId });
					}
					return send(400, { ok: false, error: `unknown lease action: ${String(action)}` });
				}
				if (req.method === "POST" && pathname === "/revoke") {
					const { pairingId } = await readBody(req);
					const found = authStore.revoke(String(pairingId));
					if (!found) return send(404, { ok: false, code: AUTH_ERROR_CODES.pairingNotFound });
					tenantLease.forceRelease(String(pairingId));
					bridgeServer.broadcastPairedAgents(composeSummaries());
					return send(200, { ok: true, revoked: pairingId });
				}
				if (req.method === "GET" && pathname === "/pairings") {
					authStore.sweepExpiredPending();
					return send(200, { ok: true, agents: composeSummaries() });
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
