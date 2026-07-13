/**
 * browser-pilot bridge daemon — the long-lived process that owns the live browser.
 *
 * Holds one BrowserBridgeServer (started lazily on the first tool invocation)
 * and exposes a token-guarded loopback control server:
 *   POST /invoke   {tool, params, cwd}  → run a tool, return {content, details, terminate}
 *   GET  /status                        → {ok, bridgePort, running, extensionConnected, tabs, tools}
 *   POST /shutdown                       → stop the bridge + control server
 *
 * `cwd` arrives per-invoke and is passed to execute as ctx.cwd, so artifact/evidence
 * roots stay scoped to the *caller*, not the daemon. The daemon is a user-local
 * singleton (see daemonControl.ts); its lockfile lives in a user-local state root.
 *
 * startDaemon() is also importable for in-process lifecycle tests (writeLock:false).
 */
import http from "node:http";
import { randomBytes } from "node:crypto";
import { BrowserBridgeServer } from "../../bridge/server/BrowserBridgeServer.js";
import { deriveBridgeReadiness } from "../../bridge/server/bridgeUtils.js";
import type { BrowserBridgeSnapshot, BrowserTabInfo } from "../../bridge/server/types.js";
import { defineBrowserCommands } from "../../commands/defineBrowserCommands.js";
import { defineAgentFacadeCommands } from "../../commands/agent/defineAgentFacadeCommands.js";
import type { EnsureStarted } from "../../commands/commandShared.js";
import { CommandManifestIndex, type CommandDefinition } from "../../commands/commandManifestIndex.js";
import { validateBrowserCommandArguments } from "../../commands/commandValidation.js";
import { registerHook, emitLog, timingLogHook, type MiddlewareContext } from "../../commands/middleware.js";
import { resolveUsageLogOptions, createUsageLogHook } from "../../commands/usageLog.js";
import { isRecord } from "../../utils/records.js";
import { writeLockfile, removeLockfile, type DaemonInfo } from "./daemonControl.js";
import { daemonVersion } from "./packageInfo.js";
import { createDaemonContractIdentity, type DaemonContractIdentity } from "./contractIdentity.js";
import { AgentContextService, getAgentContextService, installAgentContextService } from "./AgentContextService.js";
import * as authStore from "./authStore.js";
import { TenantLeaseRegistry } from "./tenantLease.js";
import {
	AUTH_ERROR_CODES,
	PAIRING_TOKEN_HEADER,
	PAIR_PENDING_TTL_MS,
	ENV_REQUIRE_PAIRING,
	type AgentRecord,
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
	contractIdentity: DaemonContractIdentity;
	close: () => Promise<void>;
}

export interface StartDaemonOptions {
	/** Write the user-local singleton lockfile (default true). Tests pass false. */
	writeLock?: boolean;
	/**
	 * Bind the BrowserBridgeServer immediately on startup instead of lazily on the
	 * first /connect or /invoke (default: same as writeLock). Eager binding lets the
	 * extension's always-on background probe connect before the first tool call, so
	 * the connection converges without the agent calling connect. Hermetic in-process
	 * tests (writeLock:false) skip it to avoid binding a real port.
	 */
	startBridgeEagerly?: boolean;
	/** Called after /shutdown closes the server, or by its bounded terminal fallback if a close callback stalls. */
	onShutdown?: () => void;
	/** Hermetic test injection: replace the command registry without adding a public validation route. */
	commandDefinitions?: readonly CommandDefinition[];
}

type CliInvokeMetadata = {
	command?: string;
	routing?: string;
	naturalSubcommand?: string;
	action?: string;
	compatibilityInterface?: string;
};

type JsonSender = (status: number, obj: Record<string, unknown>) => void;

export type InvokePipelineContext = Pick<DaemonControlContext, "toolByName" | "tenantLease" | "usageEnabled"> & {
	req: http.IncomingMessage;
	send: JsonSender;
	body: Record<string, unknown>;
};

type PreparedInvoke = {
	tool: string;
	cwd?: string;
	cli?: CliInvokeMetadata;
	def: CommandDefinition;
	args: Record<string, unknown>;
};

type PairResult = { decision: ConsentDecision; token?: string };
type PairingAuthorization =
	| { ok: true; record: AgentRecord }
	| { ok: false; status: number; body: Record<string, unknown> };
type DaemonControlContext = {
	token: string;
	bridgeServer: BrowserBridgeServer;
	tenantLease: TenantLeaseRegistry;
	ensureStarted: EnsureStarted;
	toolByName: Map<string, CommandDefinition>;
	toolCount: number;
	contractIdentity: DaemonContractIdentity;
	usageEnabled: boolean;
	pendingPairResults: Map<string, Promise<PairResult>>;
	composeSummaries: () => PairingSummary[];
	draining: boolean;
	close: () => Promise<void>;
	onShutdown: StartDaemonOptions["onShutdown"];
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

function safely<T>(read: () => T, fallback: T): T {
	try {
		return read();
	} catch {
		return fallback;
	}
}

function activeTabFrom(tabs: unknown[]): unknown {
	return tabs.find((tab) => typeof tab === "object" && tab && (tab as { active?: unknown }).active === true) ?? tabs[0] ?? null;
}

function ageMs(timestamp: unknown, now: number): number | undefined {
	return typeof timestamp === "number" ? Math.max(0, now - timestamp) : undefined;
}

function extensionStatusPayload(extension: BrowserBridgeSnapshot["extension"]): Record<string, unknown> | undefined {
	return extension ? {
		id: extension.extensionId,
		name: extension.name,
		version: extension.version,
		build: extension.build,
		extensionStale: extension.extensionStale,
		expectedBuild: extension.expectedBuild,
		reportedBuild: extension.reportedBuild,
		buildManifestPath: extension.buildManifestPath,
	} : undefined;
}

function bridgeHealthPayload(snapshot: BrowserBridgeSnapshot | undefined, lastTabSyncAt: number | undefined, now: number): Record<string, unknown> {
	const extension = snapshot?.extension;
	return {
		connectedAt: extension?.connectedAt,
		lastSeenAt: extension?.lastSeenAt,
		lastPingAt: extension?.lastPingAt,
		lastPongAt: extension?.lastPongAt,
		connectedForMs: ageMs(extension?.connectedAt, now),
		tabSyncAt: lastTabSyncAt,
		tabSyncAgeMs: ageMs(lastTabSyncAt, now),
		connectedClients: snapshot?.connectedClients,
		lastDisconnectReason: snapshot?.lastDisconnectReason,
		lastDisconnectAt: snapshot?.lastDisconnectAt,
		lastDisconnectAgeMs: ageMs(snapshot?.lastDisconnectAt, now),
		connectionMetrics: snapshot?.connectionMetrics,
		requestMetrics: snapshot?.requestMetrics,
	};
}

function bridgeStatusPayload(server: BrowserBridgeServer, toolCount: number, contractIdentity: DaemonContractIdentity, includeTabs: boolean): Record<string, unknown> {
	const tabs: BrowserTabInfo[] = safely(() => server.getTabs(), []);
	const snapshot = safely<BrowserBridgeSnapshot | undefined>(() => server.snapshot(), undefined);
	const lastTabSyncAt = server.getLastTabSyncAt();
	const now = Date.now();
	const readiness = deriveBridgeReadiness({
		running: server.running,
		extensionConnected: snapshot?.extensionConnected === true,
		connectedClients: typeof snapshot?.connectedClients === "number" ? snapshot.connectedClients : undefined,
		lastDisconnectAt: typeof snapshot?.lastDisconnectAt === "number" ? snapshot.lastDisconnectAt : undefined,
		now,
	});
	return {
		ok: true,
		bridgePort: server.running ? server.port : undefined,
		running: server.running,
		readiness,
		extensionConnected: snapshot?.extensionConnected === true,
		extension: extensionStatusPayload(snapshot?.extension),
		tabCount: tabs.length,
		activeTab: activeTabFrom(tabs),
		health: bridgeHealthPayload(snapshot, lastTabSyncAt, now),
		...(includeTabs ? { tabs } : {}),
		tools: toolCount,
		contractIdentity,
	};
}

function authorizePairing(req: http.IncomingMessage): PairingAuthorization {
	const ptoken = req.headers[PAIRING_TOKEN_HEADER];
	const rec = authStore.findByToken(typeof ptoken === "string" ? ptoken : undefined);
	if (!rec) return { ok: false, status: 401, body: { ok: false, code: AUTH_ERROR_CODES.pairingInvalid } };
	if (rec.status === "revoked") return { ok: false, status: 403, body: { ok: false, code: AUTH_ERROR_CODES.pairingRevoked } };
	if (rec.status !== "active") return { ok: false, status: 401, body: { ok: false, code: AUTH_ERROR_CODES.pairingInvalid } };
	return { ok: true, record: rec };
}

function authorizeInvoke(req: http.IncomingMessage, tenantLease: TenantLeaseRegistry): { ok: true; ownerId: string } | { ok: false; status: number; body: Record<string, unknown> } {
	if (process.env[ENV_REQUIRE_PAIRING] !== "1" && !authStore.hasActiveAgents()) return { ok: true, ownerId: "local-cli" };
	const auth = authorizePairing(req);
	if (!auth.ok) return auth;
	const held = tenantLease.ensureHeld(auth.record.pairingId, auth.record.label);
	if (!held.ok) return { ok: false, status: 409, body: { ok: false, code: AUTH_ERROR_CODES.leaseBusy, heldBy: held.heldBy } };
	authStore.touch(auth.record.pairingId);
	return { ok: true, ownerId: auth.record.pairingId };
}

/** Pure daemon pre-execution validator, exported for CLI/daemon parity corpora. */
export function validateDaemonCommandArguments(definition: CommandDefinition, args: unknown) {
	return validateBrowserCommandArguments(definition, args);
}

function prepareInvoke(body: Record<string, unknown>, toolByName: Map<string, CommandDefinition>): PreparedInvoke | { errorStatus: number; errorBody: Record<string, unknown> } {
	const tool = typeof body.tool === "string" ? body.tool : "";
	const params = body.params === undefined ? {} : body.params;
	const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
	const cli = isRecord(body.cli) ? body.cli as CliInvokeMetadata : undefined;
	const def = toolByName.get(tool);
	if (!def) return { errorStatus: 404, errorBody: { ok: false, error: `unknown tool: ${tool || "(missing)"}` } };
	const validation = validateDaemonCommandArguments(def, params);
	if (!validation.ok) return { errorStatus: 400, errorBody: { ok: false, code: "COMMAND_VALIDATION_FAILED", error: validation.error, issues: validation.issues } };
	return { tool, cwd, cli, def, args: validation.args };
}

async function executeInvoke(invocation: PreparedInvoke, usageEnabled: boolean, operationOwnerId = "local-cli"): Promise<Record<string, unknown>> {
	const ctx: MiddlewareContext = {
		method: "invoke",
		commandName: invocation.tool,
		startedAt: Date.now(),
		...(usageEnabled ? { args: invocation.args } : {}),
		...(usageEnabled && invocation.cli ? { cli: invocation.cli } : {}),
	};
	try {
		const result = await invocation.def.execute(`cli-${invocation.tool}-${Date.now()}`, invocation.args, undefined, undefined, { cwd: invocation.cwd, hasUI: false, operationOwnerId, ...(invocation.cli ? { omitTransportDetails: true } : {}) });
		if (usageEnabled) ctx.resultBytes = JSON.stringify(result.content).length;
		emitLog(ctx, Date.now() - ctx.startedAt, result.terminate ? "error" : "ok");
		const terminate = result.terminate === true;
		return { ok: true, content: result.content, ...(invocation.cli && !terminate ? {} : { details: result.details }), terminate };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		emitLog(ctx, Date.now() - ctx.startedAt, "error", { error: message });
		return { ok: true, content: [{ type: "text", text: message }], terminate: true };
	}
}

export async function handleInvokeRoute({ req, send, body, toolByName, tenantLease, usageEnabled }: InvokePipelineContext): Promise<void> {
	const prepared = prepareInvoke(body, toolByName);
	if ("errorStatus" in prepared) return send(prepared.errorStatus, prepared.errorBody);
	const auth = authorizeInvoke(req, tenantLease);
	if (!auth.ok) return send(auth.status, auth.body);
	return send(200, await executeInvoke(prepared, usageEnabled, auth.ownerId));
}

async function handleConnectRoute(context: DaemonControlContext, req: http.IncomingMessage, send: JsonSender): Promise<void> {
	const body = await readBody(req);
	const wait = body.wait === true;
	const timeoutMs = Math.max(0, Math.min(120_000, Math.floor(Number(body.timeoutMs ?? 0) || 0)));
	const includeTabs = body.tabs === true;
	const wasRunning = context.bridgeServer.running;
	try {
		await context.ensureStarted();
	} catch (error) {
		return send(503, {
			ok: false,
			code: "CLI_BRIDGE_START_FAILED",
			error: error instanceof Error ? error.message : String(error),
			status: bridgeStatusPayload(context.bridgeServer, context.toolCount, context.contractIdentity, includeTabs),
		});
	}
	if (wait) {
		await context.bridgeServer.waitForExtensionReady(undefined, timeoutMs);
		try { context.bridgeServer.broadcastPairedAgents(context.composeSummaries()); } catch { /* best-effort */ }
	}
	const status = bridgeStatusPayload(context.bridgeServer, context.toolCount, context.contractIdentity, includeTabs);
	return send(200, { ok: true, startedBridge: !wasRunning && context.bridgeServer.running, status });
}

async function handlePairStartRoute(context: DaemonControlContext, req: http.IncomingMessage, send: JsonSender): Promise<void> {
	const { label } = await readBody(req);
	if (!context.bridgeServer.hasConsentSurface()) return send(409, { ok: false, code: AUTH_ERROR_CODES.pairNoExtension });
	authStore.sweepExpiredPending();
	const { pairingId, code } = authStore.mintPending(String(label ?? "agent"));
	const result = context.bridgeServer.sendConsentRequest({ pairingId, label: String(label ?? "agent"), code, expiresAt: new Date(Date.now() + PAIR_PENDING_TTL_MS).toISOString(), timeoutMs: PAIR_PENDING_TTL_MS })
		.then(async (decision: ConsentDecision): Promise<PairResult> => {
			if (decision !== "approve") {
				await authStore.deny(pairingId);
				return { decision };
			}
			const approved = await authStore.approve(pairingId);
			context.bridgeServer.broadcastPairedAgents(context.composeSummaries());
			return { decision, token: approved?.token };
		})
		.catch(async (): Promise<PairResult> => {
			await authStore.deny(pairingId);
			return { decision: "timeout" };
		});
	context.pendingPairResults.set(pairingId, result);
	return send(200, { ok: true, pairingId, code });
}

async function handlePairWaitRoute(context: DaemonControlContext, req: http.IncomingMessage, send: JsonSender): Promise<void> {
	const { pairingId } = await readBody(req);
	const key = String(pairingId);
	const pending = context.pendingPairResults.get(key);
	if (!pending) return send(408, { ok: false, code: AUTH_ERROR_CODES.pairTimeout });
	const result = await pending;
	context.pendingPairResults.delete(key);
	if (result.decision === "approve" && result.token) return send(200, { ok: true, token: result.token });
	if (result.decision === "deny") return send(403, { ok: false, code: AUTH_ERROR_CODES.pairDenied });
	return send(408, { ok: false, code: AUTH_ERROR_CODES.pairTimeout });
}

async function handleLeaseRoute(context: DaemonControlContext, req: http.IncomingMessage, send: JsonSender): Promise<void> {
	const auth = authorizePairing(req);
	if (!auth.ok) return send(auth.status, auth.body);
	const { action, ttlMs } = await readBody(req);
	if (action === "acquire") {
		const result = context.tenantLease.acquire(auth.record.pairingId, auth.record.label, typeof ttlMs === "number" ? ttlMs : undefined);
		return result.ok
			? send(200, { ok: true, lease: result.lease })
			: send(409, { ok: false, code: AUTH_ERROR_CODES.leaseBusy, heldBy: result.heldBy });
	}
	if (action === "release") {
		context.tenantLease.release(auth.record.pairingId);
		return send(200, { ok: true });
	}
	if (action === "status") {
		const lease = context.tenantLease.status();
		return send(200, { ok: true, lease, self: lease?.pairingId === auth.record.pairingId });
	}
	return send(400, { ok: false, error: `unknown lease action: ${String(action)}` });
}

function scheduleShutdown(context: DaemonControlContext): void {
	setImmediate(() => {
		let completed = false;
		let fallback: NodeJS.Timeout | undefined;
		const complete = (): void => {
			if (completed) return;
			completed = true;
			if (fallback) clearTimeout(fallback);
			context.onShutdown?.();
		};
		// Foreground daemon shutdown is terminal. If a browser/HTTP close callback is
		// lost, invoke the process-level shutdown hook before managed replacement's
		// five-second proof window expires; the OS then closes any residual handles.
		if (context.onShutdown) fallback = setTimeout(complete, 2_000);
		void context.close().then(complete, complete);
	});
}

async function handleControlRequest(context: DaemonControlContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	const send: JsonSender = (status, obj) => {
		const body = JSON.stringify(obj);
		res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
		res.end(body);
	};
	if (req.headers["x-browser-pilot-daemon-token"] !== context.token) return send(401, { ok: false, error: "unauthorized" });
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	try {
		switch (`${req.method} ${url.pathname}`) {
			case "GET /status":
				return send(200, bridgeStatusPayload(context.bridgeServer, context.toolCount, context.contractIdentity, url.searchParams.get("tabs") === "1"));
			case "POST /shutdown":
				context.draining = true;
				send(200, { ok: true });
				scheduleShutdown(context);
				return;
			case "POST /connect":
				return await handleConnectRoute(context, req, send);
			case "POST /invoke":
				if (context.draining) return send(503, { ok: false, code: "DAEMON_DRAINING", error: "daemon is draining for shutdown" });
				return await handleInvokeRoute({ req, send, body: await readBody(req), toolByName: context.toolByName, tenantLease: context.tenantLease, usageEnabled: context.usageEnabled });
			case "POST /pair/start":
				return await handlePairStartRoute(context, req, send);
			case "POST /pair/wait":
				return await handlePairWaitRoute(context, req, send);
			case "POST /lease":
				return await handleLeaseRoute(context, req, send);
			case "POST /revoke": {
				const { pairingId } = await readBody(req);
				if (!authStore.revoke(String(pairingId))) return send(404, { ok: false, code: AUTH_ERROR_CODES.pairingNotFound });
				context.tenantLease.release(String(pairingId));
				context.bridgeServer.broadcastPairedAgents(context.composeSummaries());
				return send(200, { ok: true, revoked: pairingId });
			}
			case "GET /pairings":
				authStore.sweepExpiredPending();
				return send(200, { ok: true, agents: context.composeSummaries() });
			default:
				return send(404, { ok: false, error: `not found: ${req.method} ${url.pathname}` });
		}
	} catch (error) {
		return send(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
	}
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
		tenantLease.release(pairingId);
		bridgeServer.broadcastPairedAgents(composeSummaries());
	});

	const pendingPairResults = new Map<string, Promise<PairResult>>();

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

	installAgentContextService(new AgentContextService());

	const AGENT_FACADE_NAMES = new Set(["browser_view", "browser_act", "browser_read"]);
	let commandDefinitions: CommandDefinition[];
	let publicCommandDefinitions: CommandDefinition[];
	if (options.commandDefinitions) {
		commandDefinitions = [...options.commandDefinitions];
		publicCommandDefinitions = commandDefinitions.filter((def) => !AGENT_FACADE_NAMES.has(def.name));
	} else {
		const adapter = new CommandManifestIndex();
		defineBrowserCommands(adapter, bridgeServer, ensureStarted);
		publicCommandDefinitions = adapter.getCommands();
		defineAgentFacadeCommands({ commands: adapter, ensureStarted });
		commandDefinitions = adapter.getCommands();
	}
	const toolByName = new Map<string, CommandDefinition>(commandDefinitions.map((def) => [def.name, def]));
	// Contract identity / toolCount remain public catalog only (preview must not rewrite v3 wire).
	const contractIdentity = createDaemonContractIdentity(publicCommandDefinitions);
	const toolCount = contractIdentity.toolCount;

	const token = randomBytes(24).toString("hex");
	const usageEnabled = resolveUsageLogOptions().enabled;

	let closing = false;
	const close = async (): Promise<void> => {
		if (closing) return;
		closing = true;
		tenantLease.stop();
		try {
			getAgentContextService().expireAll();
		} catch {
			/* best-effort */
		}
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeIdleConnections?.();
			// /shutdown has already acknowledged before close() is scheduled. Force any
			// lingering loopback keep-alive request closed on the next turn so one CLI
			// connection cannot hold a draining daemon beyond replacement grace.
			setImmediate(() => server.closeAllConnections?.());
		});
		await bridgeServer.stop().catch(() => {
			/* best-effort */
		});
		if (writeLock) removeLockfile();
	};

	const controlContext: DaemonControlContext = { token, bridgeServer, tenantLease, ensureStarted, toolByName, toolCount, contractIdentity, usageEnabled, pendingPairResults, composeSummaries, draining: false, close, onShutdown: options.onShutdown };
	const server = http.createServer((req, res) => void handleControlRequest(controlContext, req, res));

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	const controlPort = typeof address === "object" && address ? address.port : 0;

	const startBridgeEagerly = options.startBridgeEagerly ?? writeLock;
	if (startBridgeEagerly) {
		// Bind the bridge now so the extension's background probe can dial in before the
		// first tool call — the connection "takes over" without an explicit connect.
		// Best-effort: a bind failure must not abort daemon startup. The lazy
		// ensureStarted() path (/connect, /invoke) still retries and surfaces the error.
		try {
			await ensureStarted();
		} catch (error) {
			console.error(`[browser-pilot] eager bridge start failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	if (writeLock) {
		const info: DaemonInfo = {
			pid: process.pid,
			controlHost: "127.0.0.1",
			controlPort,
			...(bridgeServer.running ? { bridgePort: bridgeServer.port } : {}),
			token,
			startedAt: new Date().toISOString(),
			version: DAEMON_VERSION,
			contractIdentity,
		};
		writeLockfile(info);
	}

	return { controlHost: "127.0.0.1", controlPort, token, bridgePort: bridgeServer.running ? bridgeServer.port : 0, contractIdentity, close };
}
