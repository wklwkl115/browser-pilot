import { Buffer } from "node:buffer";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserBridgeError } from "./errors";
import { delay } from "./bridgeUtils";
import type { BrowserBridgeClientInfo } from "./types";

export type ManagedBrowserProfile = {
	profileId: string;
	profileDir: string;
	extensionDir: string;
	bridgePort: number;
	debugPort: number;
	chrome: string;
	processId?: number;
	browserId?: string;
	browserExtensionId?: string;
	startedAt: number;
	connectedAt?: number;
	owned: true;
	cleanup: "delete" | "keepOnFailure";
};

type ManagedProfileRecord = ManagedBrowserProfile & {
	process?: ChildProcess;
	bridgeEndpoint?: { stop(): Promise<void> | void };
	stdoutTail: string;
	stderrTail: string;
};

type BrowserProfileManagerOptions = {
	bridgePort: number;
	getClients: () => BrowserBridgeClientInfo[];
	selectBrowser: (browserId: string) => BrowserBridgeClientInfo;
	startBridgeEndpoint?: (port: number) => Promise<{ stop(): Promise<void> | void }>;
	rootDir?: string;
	extensionSource?: string;
};

type EnsureProfileOptions = {
	profileId: string;
	initialUrl?: string;
	cleanup?: "delete" | "keepOnFailure";
	reuse?: "none" | "owned";
	timeoutMs?: number;
};

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMP_ROOT = path.join(".pi", "temp-profiles");
const CHROME_CANDIDATES = [
	process.env.PI_BROWSER_PROFILE_CHROME,
	process.env.PI_BROWSER_SMOKE_CHROME,
	process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
	process.platform === "win32" ? path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
	process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe") : undefined,
	process.platform === "win32" ? path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe") : undefined,
	process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe") : undefined,
	process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined,
	"google-chrome",
	"chromium",
	"chromium-browser",
].filter(Boolean) as string[];

function safeProfileId(profileId: string): string {
	return profileId.replace(/[^A-Za-z0-9_.:-]+/g, "-").slice(0, 80) || `profile-${randomUUID()}`;
}

function isWindowsExecutable(chromeExe: string): boolean {
	return process.platform !== "win32" && /\.exe$/i.test(chromeExe) && /^\/mnt\/[a-z]\//i.test(chromeExe);
}

function windowsPathForChrome(value: string, chromeExe: string): string {
	if (!isWindowsExecutable(chromeExe)) return value;
	const match = /^\/mnt\/([a-z])\/(.*)$/i.exec(value);
	if (!match) return value;
	return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`;
}

function powershellString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function stopWindowsProcessForProfile(profile: ManagedBrowserProfile): void {
	if (!isWindowsExecutable(profile.chrome)) return;
	const profileNeedle = windowsPathForChrome(profile.profileDir, profile.chrome);
	const debugNeedle = `--remote-debugging-port=${profile.debugPort}`;
	const command = [
		`$profileNeedle=${powershellString(profileNeedle)};`,
		`$debugNeedle=${powershellString(debugNeedle)};`,
		"Get-CimInstance Win32_Process |",
		"Where-Object { $_.CommandLine -and ($_.CommandLine.Contains($profileNeedle) -or $_.CommandLine.Contains($debugNeedle)) } |",
		"ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
	].join(" ");
	spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { stdio: "ignore" });
}

async function freePort(start: number, end: number, excluded = new Set<number>()): Promise<number> {
	for (let port = start; port <= end; port += 1) {
		if (excluded.has(port)) continue;
		const server = createServer();
		try {
			await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
			await new Promise<void>((resolve) => server.close(() => resolve()));
			return port;
		} catch {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}
	throw new BrowserBridgeError("PROFILE_START_FAILED", `No free debug port in range ${start}-${end}`, { start, end });
}

async function removePathWithRetry(target: string, attempts = 8): Promise<void> {
	let lastError: unknown;
	for (let i = 0; i < attempts; i += 1) {
		try {
			await rm(target, { recursive: true, force: true });
			return;
		} catch (error) {
			lastError = error;
			await delay(100 + i * 100);
		}
	}
	throw lastError;
}

function chromePath(): string {
	for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate;
	throw new BrowserBridgeError("PROFILE_MANAGER_UNAVAILABLE", "Chrome/Chromium executable not found; set PI_BROWSER_PROFILE_CHROME or PI_BROWSER_SMOKE_CHROME", { tried: CHROME_CANDIDATES });
}

async function patchExtension(extensionDir: string, bridgePort: number, profile: ManagedBrowserProfile): Promise<void> {
	const serviceWorkerPath = path.join(extensionDir, "dist", "service-worker.js");
	let source = await readFile(serviceWorkerPath, "utf8");
	const managedProfile = {
		profileId: profile.profileId,
		profileDir: profile.profileDir,
		extensionDir: profile.extensionDir,
		bridgePort,
		debugPort: profile.debugPort,
		owned: true,
		cleanup: profile.cleanup,
	};
	const managedProfileB64 = Buffer.from(JSON.stringify(managedProfile), "utf8").toString("base64");
	source = source
		.replace(/127\.0\.0\.1:\d{2,5}/g, `127.0.0.1:${bridgePort}`)
		.replace(/PI_BROWSER_BRIDGE_PORT\s*=\s*\d+/g, `PI_BROWSER_BRIDGE_PORT = ${bridgePort}`)
		.replace("\"__PI_BROWSER_MANAGED_PROFILE_B64__\"", JSON.stringify(managedProfileB64))
		.replace("'__PI_BROWSER_MANAGED_PROFILE_B64__'", JSON.stringify(managedProfileB64));
	if (!source.includes(managedProfileB64)) throw new BrowserBridgeError("PROFILE_START_FAILED", "Managed profile metadata patch did not apply to service worker", { profileId: profile.profileId, serviceWorkerPath });
	await writeFile(serviceWorkerPath, source, "utf8");
}

export class BrowserProfileManager {
	private readonly bridgePort: number;
	private readonly getClients: () => BrowserBridgeClientInfo[];
	private readonly selectBrowser: (browserId: string) => BrowserBridgeClientInfo;
	private readonly startBridgeEndpoint?: (port: number) => Promise<{ stop(): Promise<void> | void }>;
	private readonly rootDir: string;
	private readonly extensionSource: string;
	private readonly profiles = new Map<string, ManagedProfileRecord>();

	constructor(options: BrowserProfileManagerOptions) {
		this.bridgePort = options.bridgePort;
		this.getClients = options.getClients;
		this.selectBrowser = options.selectBrowser;
		this.startBridgeEndpoint = options.startBridgeEndpoint;
		this.rootDir = options.rootDir || moduleRoot;
		this.extensionSource = options.extensionSource || path.join(this.rootDir, "bridge", "pi_browser_bridge");
	}

	list(): ManagedBrowserProfile[] {
		return Array.from(this.profiles.values()).map((profile) => this.publicProfile(profile));
	}

	get(profileId: string): ManagedBrowserProfile | undefined {
		const profile = this.profiles.get(profileId);
		return profile ? this.publicProfile(profile) : undefined;
	}

	async ensureProfile(options: EnsureProfileOptions): Promise<ManagedBrowserProfile> {
		const profileId = safeProfileId(options.profileId);
		const existing = this.profiles.get(profileId);
		const connected = this.clientForProfile(profileId);
		if (existing && options.reuse !== "none" && existing.process && !existing.process.killed && connected) {
			existing.browserId = connected.id;
			existing.browserExtensionId = connected.extensionId;
			existing.connectedAt ||= Date.now();
			this.selectBrowser(connected.id);
			return this.publicProfile(existing);
		}
		if (existing) await this.stopProfile(profileId, { deleteFiles: true }).catch(() => undefined);
		return await this.startProfile({ ...options, profileId });
	}

	async stopProfile(profileId: string, options: { deleteFiles?: boolean; timeoutMs?: number } = {}): Promise<ManagedBrowserProfile | undefined> {
		const profile = this.profiles.get(profileId);
		if (!profile) return undefined;
		if (profile.process && !profile.process.killed) {
			stopWindowsProcessForProfile(profile);
			try { profile.process.kill("SIGTERM"); } catch {}
			const deadline = Date.now() + Math.max(100, Math.min(options.timeoutMs || 5_000, 30_000));
			while (Date.now() < deadline && profile.process.exitCode === null && profile.process.signalCode === null) await delay(100);
			if (profile.process.exitCode === null && profile.process.signalCode === null) {
				if (profile.processId && (process.platform === "win32" || isWindowsExecutable(profile.chrome))) spawnSync("taskkill.exe", ["/PID", String(profile.processId), "/T", "/F"], { stdio: "ignore" });
				try { profile.process.kill("SIGKILL"); } catch {}
			}
		}
		try { await profile.bridgeEndpoint?.stop(); } catch {}
		this.profiles.delete(profileId);
		if (options.deleteFiles !== false) {
			await removePathWithRetry(profile.profileDir).catch(() => undefined);
			await removePathWithRetry(profile.extensionDir).catch(() => undefined);
		}
		return this.publicProfile(profile);
	}

	async stopAll(options: { deleteFiles?: boolean; timeoutMs?: number } = {}): Promise<ManagedBrowserProfile[]> {
		const stopped: ManagedBrowserProfile[] = [];
		for (const profileId of Array.from(this.profiles.keys())) {
			const profile = await this.stopProfile(profileId, options);
			if (profile) stopped.push(profile);
		}
		return stopped;
	}

	private async startProfile(options: EnsureProfileOptions): Promise<ManagedBrowserProfile> {
		if (!existsSync(path.join(this.extensionSource, "manifest.json"))) throw new BrowserBridgeError("PROFILE_MANAGER_UNAVAILABLE", "Pi Browser extension source is missing manifest.json", { extensionSource: this.extensionSource });
		const chromeExe = chromePath();
		const now = Date.now();
		const bridgePort = this.startBridgeEndpoint ? await freePort(Math.max(18766, this.bridgePort + 1), 18850) : this.bridgePort;
		const usedDebugPorts = new Set(Array.from(this.profiles.values()).map((profile) => profile.debugPort).filter((port) => Number.isInteger(port)));
		const debugPort = await freePort(9261, 9300, usedDebugPorts);
		const runId = `${safeProfileId(options.profileId)}-${now}`;
		const tempRoot = path.join(this.rootDir, TEMP_ROOT);
		const profileDir = path.join(tempRoot, `managed-profile-${runId}`);
		const extensionDir = path.join(tempRoot, `managed-extension-${runId}`);
		await mkdir(tempRoot, { recursive: true });
		await cp(this.extensionSource, extensionDir, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
		const profile: ManagedProfileRecord = {
			profileId: options.profileId,
			profileDir,
			extensionDir,
			bridgePort,
			debugPort,
			chrome: chromeExe,
			startedAt: now,
			owned: true,
			cleanup: options.cleanup || "delete",
			stdoutTail: "",
			stderrTail: "",
		};
		this.profiles.set(options.profileId, profile);
		try {
			const bridgeEndpoint = this.startBridgeEndpoint ? await this.startBridgeEndpoint(bridgePort) : undefined;
			profile.bridgeEndpoint = bridgeEndpoint;
			await patchExtension(extensionDir, bridgePort, profile);
			await mkdir(profileDir, { recursive: true });
			const chromeProfileDir = windowsPathForChrome(profileDir, chromeExe);
			const chromeExtensionDir = windowsPathForChrome(extensionDir, chromeExe);
			const args = [
				`--user-data-dir=${chromeProfileDir}`,
				`--disable-extensions-except=${chromeExtensionDir}`,
				`--load-extension=${chromeExtensionDir}`,
				`--remote-debugging-port=${debugPort}`,
				"--no-first-run",
				"--no-default-browser-check",
				"--disable-background-networking",
				"--enable-logging=stderr",
				"--v=0",
				options.initialUrl || "about:blank",
			];
			const child = spawn(chromeExe, args, { stdio: ["ignore", "pipe", "pipe"], detached: false });
			profile.process = child;
			profile.processId = child.pid;
			child.stdout?.on("data", (chunk) => { profile.stdoutTail = `${profile.stdoutTail}${chunk.toString()}`.slice(-4000); });
			child.stderr?.on("data", (chunk) => { profile.stderrTail = `${profile.stderrTail}${chunk.toString()}`.slice(-4000); });
			const client = await this.waitForProfileClient(options.profileId, options.timeoutMs || 30_000, bridgePort);
			profile.browserId = client.id;
			profile.browserExtensionId = client.extensionId;
			profile.connectedAt = Date.now();
			this.selectBrowser(client.id);
			return this.publicProfile(profile);
		} catch (error) {
			await this.stopProfile(options.profileId, { deleteFiles: profile.cleanup !== "keepOnFailure" }).catch(() => undefined);
			if (error instanceof BrowserBridgeError) throw error;
			throw new BrowserBridgeError("PROFILE_CONNECT_TIMEOUT", error instanceof Error ? error.message : String(error), { profileId: options.profileId, debugPort, processId: profile.processId, stdoutTail: profile.stdoutTail, stderrTail: profile.stderrTail });
		}
	}

	private async waitForProfileClient(profileId: string, timeoutMs: number, bridgePort: number): Promise<BrowserBridgeClientInfo> {
		const deadline = Date.now() + Math.max(100, timeoutMs);
		while (Date.now() <= deadline) {
			const client = this.clientForProfile(profileId);
			if (client) return client;
			await delay(250);
		}
		throw new BrowserBridgeError("PROFILE_CONNECT_TIMEOUT", "Managed browser profile did not connect to the bridge before deadline", { profileId, timeoutMs, bridgePort, clients: this.getClients().map((client) => ({ id: client.id, extensionId: client.extensionId, profileId: client.profileId, name: client.name })) });
	}

	private clientForProfile(profileId: string): BrowserBridgeClientInfo | undefined {
		return this.getClients().find((client) => client.profileId === profileId);
	}

	private publicProfile(profile: ManagedProfileRecord): ManagedBrowserProfile {
		return {
			profileId: profile.profileId,
			profileDir: profile.profileDir,
			extensionDir: profile.extensionDir,
			bridgePort: profile.bridgePort,
			debugPort: profile.debugPort,
			chrome: profile.chrome,
			processId: profile.processId,
			browserId: profile.browserId,
			browserExtensionId: profile.browserExtensionId,
			startedAt: profile.startedAt,
			connectedAt: profile.connectedAt,
			owned: true,
			cleanup: profile.cleanup,
		};
	}
}
