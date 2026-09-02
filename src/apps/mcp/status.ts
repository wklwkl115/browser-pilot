import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	daemonContractReport,
	findDaemon,
	isPidAlive,
	lockfilePath,
	readLockfile,
	stateDir,
	type DaemonStatus,
} from "../daemon/daemonControl.js";
import { packageRoot, packageVersion } from "../daemon/packageInfo.js";
import { readExpectedExtensionBuild } from "../../bridge/server/extensionBuild.js";
import { isRecord } from "../../utils/records.js";

/**
 * `browser-pilot-mcp status` — one-shot local diagnosis of the install, the daemon, and the
 * extension link, with the next action a user should take. Pure data first (`collectStatus`),
 * text rendering second (`renderStatus`), so the JSON form stays scriptable.
 */

export type StatusLevel = "ok" | "warn" | "fail";

export type StatusCheck = {
	id: string;
	level: StatusLevel;
	summary: string;
	detail?: Record<string, unknown>;
	fix?: string;
};

export type StatusReport = {
	version: string;
	node: string;
	platform: string;
	stateDir: string;
	verdict: StatusLevel;
	checks: StatusCheck[];
};

type StatusDeps = {
	stateDir?: () => string;
	packageRoot?: () => string | undefined;
	findDaemon?: typeof findDaemon;
	readLockfile?: typeof readLockfile;
	isPidAlive?: typeof isPidAlive;
	expectedBuildId?: () => string | undefined;
};

const RELOAD_HINT =
	"Open chrome://extensions (or edge://extensions), find Browser Pilot Bridge, and click Reload; then open or reload any tab.";

function readJson(filePath: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function packagedExtensionCheck(root: string | undefined): StatusCheck {
	const dir = root ? path.join(root, "bridge", "browser_pilot_bridge") : undefined;
	const worker = dir ? path.join(dir, "dist", "service-worker.js") : undefined;
	if (!dir || !worker || !existsSync(worker))
		return {
			id: "packaged-extension",
			level: "fail",
			summary: "Packaged extension bundle is missing from this install",
			detail: { dir },
			fix: "Reinstall the package, or run `npm run build:bridge` in a source checkout.",
		};
	return { id: "packaged-extension", level: "ok", summary: "Packaged extension bundle present", detail: { dir } };
}

function installedExtensionCheck(installDir: string, expectedBuildId: string | undefined): StatusCheck {
	const manifest = readJson(path.join(installDir, "manifest.json"));
	if (!manifest)
		return {
			id: "installed-extension",
			level: "fail",
			summary: "Extension has not been installed for this user",
			detail: { installDir },
			fix: "Run `npx browser-pilot-mcp install`, then load the printed directory as an unpacked extension.",
		};
	const build = readJson(path.join(installDir, "dist", "build-manifest.json"));
	const installedBuildId = typeof build?.buildId === "string" ? build.buildId : undefined;
	const detail = { installDir, version: manifest.version, buildId: installedBuildId, expectedBuildId };
	if (expectedBuildId && installedBuildId && installedBuildId !== expectedBuildId)
		return {
			id: "installed-extension",
			level: "warn",
			summary: "Installed extension files are older than this package",
			detail,
			fix: `Run \`npx browser-pilot-mcp install\` to refresh the files, then ${RELOAD_HINT}`,
		};
	return {
		id: "installed-extension",
		level: "ok",
		summary: `Extension ${String(manifest.version)} installed`,
		detail,
	};
}

function daemonChecks(
	found: Awaited<ReturnType<typeof findDaemon>>,
	lock: ReturnType<typeof readLockfile>,
	pidAlive: (pid: number) => boolean,
): StatusCheck[] {
	if (!found) {
		if (!lock)
			return [
				{
					id: "daemon",
					level: "ok",
					summary: "Daemon is not running (it starts on the first tool call)",
					detail: { lockfile: lockfilePath() },
				},
			];
		const alive = pidAlive(lock.pid);
		return [
			{
				id: "daemon",
				level: "warn",
				summary: alive
					? `Daemon pid ${lock.pid} is alive but its control port did not answer`
					: `Stale daemon lockfile for dead pid ${lock.pid}`,
				detail: {
					pid: lock.pid,
					controlPort: lock.controlPort,
					version: lock.version,
					startedAt: lock.startedAt,
				},
				fix: alive
					? "Wait a few seconds and retry; if it persists, stop the process and let the next tool call start a fresh daemon."
					: "The lockfile will be reclaimed automatically on the next tool call.",
			},
		];
	}
	const { info, status } = found;
	const contract = daemonContractReport(found);
	const checks: StatusCheck[] = [
		{
			id: "daemon",
			level: "ok",
			summary: `Daemon ${info.version} answering on 127.0.0.1:${info.controlPort} (pid ${info.pid})`,
			detail: {
				pid: info.pid,
				controlPort: info.controlPort,
				bridgePort: status.bridgePort,
				startedAt: info.startedAt,
			},
		},
	];
	checks.push(
		contract.check.ok
			? { id: "daemon-contract", level: "ok", summary: "Daemon command contract matches this package" }
			: {
					id: "daemon-contract",
					level: "warn",
					summary: "Running daemon was started by a different Browser Pilot version",
					detail: { reason: contract.check.reason, mismatches: contract.check.mismatches },
					fix: "The next tool call replaces it automatically. If that fails, stop the old process manually.",
				},
	);
	checks.push(...extensionLinkChecks(status));
	return checks;
}

function extensionLinkChecks(status: DaemonStatus): StatusCheck[] {
	const health = isRecord(status.health) ? status.health : {};
	const extension = isRecord(status.extension) ? status.extension : {};
	if (!status.running)
		return [
			{
				id: "bridge",
				level: "warn",
				summary: "Daemon is up but the browser bridge has not been started yet",
				fix: "Run any browser_* tool once; the bridge binds lazily.",
			},
		];
	if (!status.extensionConnected) {
		const everConnected = typeof health.lastDisconnectAt === "number";
		return [
			{
				id: "bridge",
				level: "fail",
				summary: everConnected
					? "Extension was connected before but is not connected now"
					: "No browser extension has connected to the bridge",
				detail: {
					bridgePort: status.bridgePort,
					readiness: status.readiness,
					lastDisconnectReason: health.lastDisconnectReason,
					lastDisconnectAgeMs: health.lastDisconnectAgeMs,
				},
				fix: everConnected
					? "The extension service worker is probably idle. Open or reload any browser tab; it reconnects automatically."
					: `Make sure the Browser Pilot Bridge extension is loaded and enabled, then ${RELOAD_HINT}`,
			},
		];
	}
	const extensionLabel = typeof extension.version === "string" ? `Extension ${extension.version}` : "Extension";
	const checks: StatusCheck[] = [
		{
			id: "bridge",
			level: "ok",
			summary: `${extensionLabel} connected (${status.tabCount ?? 0} tabs tracked)`,
			detail: {
				bridgePort: status.bridgePort,
				readiness: status.readiness,
				extensionId: extension.id,
				connectedForMs: health.connectedForMs,
				activeTab: status.activeTab,
			},
		},
	];
	if (extension.extensionStale === true)
		checks.push({
			id: "extension-build",
			level: "warn",
			summary: "Connected extension build differs from this package",
			detail: { expectedBuild: extension.expectedBuild, reportedBuild: extension.reportedBuild },
			fix: `Run \`npx browser-pilot-mcp install\`, then ${RELOAD_HINT}`,
		});
	return checks;
}

function worst(levels: StatusLevel[]): StatusLevel {
	if (levels.includes("fail")) return "fail";
	if (levels.includes("warn")) return "warn";
	return "ok";
}

export async function collectStatus(deps: StatusDeps = {}): Promise<StatusReport> {
	const resolveStateDir = deps.stateDir ?? stateDir;
	const root = (deps.packageRoot ?? packageRoot)();
	const expectedBuildId = deps.expectedBuildId ?? (() => readExpectedExtensionBuild().buildId);
	const checks: StatusCheck[] = [
		packagedExtensionCheck(root),
		installedExtensionCheck(path.join(resolveStateDir(), "extension"), expectedBuildId()),
	];
	const found = await (deps.findDaemon ?? findDaemon)();
	checks.push(...daemonChecks(found, (deps.readLockfile ?? readLockfile)(), deps.isPidAlive ?? isPidAlive));
	return {
		version: packageVersion(),
		node: process.version,
		platform: `${process.platform}-${process.arch}`,
		stateDir: resolveStateDir(),
		verdict: worst(checks.map((check) => check.level)),
		checks,
	};
}

const LEVEL_MARK: Record<StatusLevel, string> = { ok: "[ok]  ", warn: "[warn]", fail: "[fail]" };

export function renderStatus(report: StatusReport): string {
	const lines = [
		`Browser Pilot ${report.version} (node ${report.node}, ${report.platform})`,
		`State directory: ${report.stateDir}`,
		"",
	];
	for (const check of report.checks) {
		lines.push(`${LEVEL_MARK[check.level]} ${check.summary}`);
		if (check.fix) lines.push(`       -> ${check.fix}`);
	}
	lines.push("");
	lines.push(
		report.verdict === "ok"
			? "Everything looks ready."
			: report.verdict === "warn"
				? "Usable, but see the warnings above."
				: "Not ready: fix the failing checks above, then run this command again.",
	);
	return lines.join("\n");
}
