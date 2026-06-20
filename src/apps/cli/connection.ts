import path from "node:path";
import { controlRequest, ensureDaemon, findDaemon, isDaemonVersionCurrent, isPidAlive, lockfilePath, readLockfile, type DaemonInfo, type DaemonStatus } from "../daemon/daemonControl.js";
import { resolvePairingToken } from "./pairing.js";
import { daemonVersion } from "../daemon/packageInfo.js";
import { EXIT } from "./render.js";
import type { LeaseStatusResponse } from "../daemon/authTypes.js";

export type RecoveryCommand = { command: string; argv: string[]; purpose: string };

function recoveryCommand(command: string, argv: string[], purpose: string): RecoveryCommand {
	return { command, argv, purpose };
}

export function connectionRecoveryCommands(timeoutMs = 30_000): RecoveryCommand[] {
	return [
		recoveryCommand("browser-pilot status --json", ["browser-pilot", "status", "--json"], "inspect current connection state without starting anything"),
		recoveryCommand("browser-pilot connect --wait --timeout-ms " + timeoutMs + " --json", ["browser-pilot", "connect", "--wait", "--timeout-ms", String(timeoutMs), "--json"], "start/reuse the daemon and wait for the browser extension"),
		recoveryCommand("browser-pilot doctor --json", ["browser-pilot", "doctor", "--json"], "inspect daemon, bridge, extension, and active tab diagnostics"),
		recoveryCommand("browser-pilot daemon status --json", ["browser-pilot", "daemon", "status", "--json"], "inspect low-level daemon state"),
	];
}

export function staleLockfileDiagnostic(): Record<string, unknown> | null {
	const info = readLockfile();
	if (!info) return null;
	let lockfileAgeMs: number | null = null;
	let lockfileAge: string | null = null;
	if (info.startedAt) {
		const started = new Date(info.startedAt).getTime();
		if (Number.isFinite(started)) {
			lockfileAgeMs = Date.now() - started;
			const seconds = Math.floor(lockfileAgeMs / 1000);
			if (seconds < 60) lockfileAge = `${seconds}s ago`;
			else if (seconds < 3600) lockfileAge = `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
			else lockfileAge = `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ago`;
		}
	}
	return {
		pid: info.pid,
		controlHost: info.controlHost,
		controlPort: info.controlPort,
		...(info.bridgePort != null ? { bridgePort: info.bridgePort } : {}),
		version: info.version,
		expectedVersion: daemonVersion(),
		versionStale: !isDaemonVersionCurrent(info),
		startedAt: info.startedAt,
		...(lockfileAge !== null ? { lockfileAge, lockfileAgeMs } : {}),
		pidAlive: isPidAlive(info.pid),
		unreachable: true,
		hint: isPidAlive(info.pid)
			? "The daemon process is alive but not responding. It may be stuck — try 'browser-pilot daemon stop' and restart."
			: "The daemon process (PID " + info.pid + ") is no longer running but its lockfile remains. Run 'browser-pilot connect' to start a fresh daemon.",
	};
}

function activeTabFrom(status: DaemonStatus | undefined): unknown {
	const activeTabs = Array.isArray(status?.tabs) ? status.tabs : [];
	return status?.activeTab ?? activeTabs.find((tab) => typeof tab === "object" && tab && (tab as { active?: unknown }).active === true) ?? activeTabs[0] ?? null;
}

function publicDaemon(info: DaemonInfo, status: DaemonStatus): Record<string, unknown> {
	return {
		running: true,
		reachable: true,
		lockfile: lockfilePath(),
		pid: info.pid,
		controlPort: info.controlPort,
		version: info.version,
		expectedVersion: daemonVersion(),
		versionStale: !isDaemonVersionCurrent(info),
		toolCount: status.tools,
	};
}

function publicBridge(status: DaemonStatus | undefined): Record<string, unknown> {
	return {
		running: Boolean(status?.running),
		port: status?.bridgePort ?? null,
	};
}

function publicExtension(status: DaemonStatus | undefined): Record<string, unknown> {
	const extension = status?.extension && typeof status.extension === "object" ? status.extension : {};
	const health = status?.health && typeof status.health === "object" ? status.health : {};
	const base: Record<string, unknown> = {
		connected: status?.extensionConnected === true,
		...extension,
	};
	if (status?.extensionConnected !== true && health.lastDisconnectReason) {
		base.lastDisconnectReason = health.lastDisconnectReason;
		base.lastDisconnectAt = health.lastDisconnectAt;
		base.lastDisconnectAgeMs = health.lastDisconnectAgeMs;
	}
	return base;
}

function tabCountFrom(status: DaemonStatus | undefined): number {
	if (typeof status?.tabCount === "number") return status.tabCount;
	return Array.isArray(status?.tabs) ? status.tabs.length : 0;
}

/**
 * Best-effort fetch of the current lease status from the daemon.
 * Returns a lease block or null; never throws (errors are silently swallowed
 * so that a missing/unauth /lease endpoint never breaks `status`).
 */
async function fetchLeaseStatus(info: DaemonInfo): Promise<Record<string, unknown> | null> {
	try {
		const pairingToken = resolvePairingToken();
		const { status, json } = await controlRequest(
			info,
			"POST",
			"/lease",
			{ action: "status" },
			5_000,
			pairingToken ? { pairingToken } : undefined,
		);
		if (status === 200 && json && json.ok === true) {
			const typed = json as unknown as LeaseStatusResponse;
			return {
				held: typed.lease !== null,
				self: typed.self,
				lease: typed.lease ?? null,
			};
		}
	} catch {
		/* best-effort — swallow all errors */
	}
	return null;
}

export async function connectionStatus(cwd = process.cwd(), timeoutMs = 15_000, opts: { tabs?: boolean } = {}): Promise<Record<string, unknown>> {
	const found = await findDaemon({ tabs: opts.tabs });
	const staleLockfile = found ? null : staleLockfileDiagnostic();
	const ready = Boolean(found && isDaemonVersionCurrent(found.info) && found.status.running === true && found.status.extensionConnected === true);
	// Best-effort lease status — omitted (not null) when unavailable
	const leaseStatus = found ? await fetchLeaseStatus(found.info) : null;
	const readiness = found
		? (typeof found.status.readiness === "string" ? found.status.readiness : (found.status.extensionConnected === true ? "ready" : "bridge-up"))
		: "no-daemon";
	return {
		command: "status",
		ready,
		readiness,
		cwd,
		daemon: found
			? publicDaemon(found.info, found.status)
			: {
				running: false,
				reachable: false,
				lockfile: lockfilePath(),
				expectedVersion: daemonVersion(),
				staleLockfile,
			},
		bridge: publicBridge(found?.status),
		extension: publicExtension(found?.status),
		tabCount: tabCountFrom(found?.status),
		...(opts.tabs ? { tabs: Array.isArray(found?.status.tabs) ? found?.status.tabs : [] } : {}),
		activeTab: activeTabFrom(found?.status),
		health: found?.status.health ?? {},
		...(leaseStatus !== null ? { lease: leaseStatus } : {}),
		artifactRoot: path.join(cwd, ".browser-pilot", "artifacts"),
		recovery: { commands: connectionRecoveryCommands(timeoutMs) },
	};
}

function connectFailureEnvelope(message: string, details: Record<string, unknown>, timeoutMs: number, code = "CLI_EXTENSION_NOT_CONNECTED"): Record<string, unknown> {
	const isBridgeStartFailure = code === "CLI_BRIDGE_START_FAILED";
	return {
		ok: false,
		exitCode: EXIT.unavailable,
		code,
		command: "connect",
		ready: false,
		message,
		taxonomy: { domain: "cli", category: isBridgeStartFailure ? "bridge" : "connection", retryable: true, source: "cli" },
		...details,
		recovery: {
			hint: isBridgeStartFailure ? "Inspect daemon and bridge startup diagnostics before waiting for the browser extension." : "Ensure the Browser Pilot extension is installed, enabled, and connected to the reported bridge port.",
			commands: connectionRecoveryCommands(timeoutMs),
		},
	};
}

export async function connectBrowser(opts: { wait: boolean; timeoutMs: number; cwd?: string; tabs?: boolean }): Promise<{ exitCode: number; envelope: Record<string, unknown> }> {
	const startedAt = Date.now();
	const before = await findDaemon();
	let info: DaemonInfo;
	try {
		info = await ensureDaemon({ startTimeoutMs: Math.min(Math.max(opts.timeoutMs, 1_000), 30_000) });
	} catch (error) {
		return {
			exitCode: EXIT.unavailable,
			envelope: {
				ok: false,
				exitCode: EXIT.unavailable,
				code: "CLI_DAEMON_UNAVAILABLE",
				command: "connect",
				ready: false,
				message: error instanceof Error ? error.message : String(error),
				taxonomy: { domain: "cli", category: "daemon", retryable: true, source: "cli" },
				diagnostics: {},
				recovery: { commands: connectionRecoveryCommands(opts.timeoutMs) },
			},
		};
	}
	const startedDaemon = !before || before.info.pid !== info.pid;
	let response;
	try {
		response = await controlRequest(info, "POST", "/connect", { wait: opts.wait, timeoutMs: opts.timeoutMs, tabs: opts.tabs === true }, Math.max(opts.timeoutMs + 2_000, 5_000));
	} catch (error) {
		return {
			exitCode: EXIT.unavailable,
			envelope: {
				ok: false,
				exitCode: EXIT.unavailable,
				code: "CLI_DAEMON_UNAVAILABLE",
				command: "connect",
				ready: false,
				message: error instanceof Error ? error.message : String(error),
				taxonomy: { domain: "cli", category: "daemon", retryable: true, source: "cli" },
				diagnostics: {},
				recovery: { commands: connectionRecoveryCommands(opts.timeoutMs) },
			},
		};
	}
	const json = response.json ?? {};
	const status = json.status as DaemonStatus | undefined;
	const ready = status?.running === true && status.extensionConnected === true;
	const readiness = typeof status?.readiness === "string" ? status.readiness : (ready ? "ready" : "bridge-up");
	const common = {
		command: "connect",
		ready,
		readiness,
		startedDaemon,
		startedBridge: json.startedBridge === true,
		waitedMs: Date.now() - startedAt,
		daemon: publicDaemon(info, status ?? { ok: true }),
		bridge: publicBridge(status),
		extension: publicExtension(status),
		tabCount: tabCountFrom(status),
		...(opts.tabs ? { tabs: Array.isArray(status?.tabs) ? status.tabs : [] } : {}),
		activeTab: activeTabFrom(status),
		health: status?.health ?? {},
	};
	if (response.status !== 200 || json.ok === false) {
		const code = typeof json.code === "string" ? json.code : "CLI_EXTENSION_NOT_CONNECTED";
		return {
			exitCode: EXIT.unavailable,
			envelope: connectFailureEnvelope(typeof json.error === "string" ? json.error : `daemon /connect failed (HTTP ${response.status})`, common, opts.timeoutMs, code),
		};
	}
	if (opts.wait && !ready) {
		return {
			exitCode: EXIT.unavailable,
			envelope: connectFailureEnvelope("Browser extension did not connect before timeout", common, opts.timeoutMs),
		};
	}
	return {
		exitCode: EXIT.ok,
		envelope: {
			ok: true,
			exitCode: EXIT.ok,
			...common,
			recovery: { commands: ready ? [] : connectionRecoveryCommands(opts.timeoutMs) },
		},
	};
}
