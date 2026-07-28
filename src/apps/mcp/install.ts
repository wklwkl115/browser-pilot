import { spawn } from "node:child_process";
import { access, cp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stateDir } from "../daemon/daemonControl.js";
import { packageRoot, packageVersion } from "../daemon/packageInfo.js";

export type BrowserName = "chrome" | "edge";

type BrowserCandidate = { browser: BrowserName; executable: string };
type OpenedBrowser = BrowserCandidate & { page: string };
type InstallOptions = {
	sourceDir?: string;
	installDir?: string;
	browser?: BrowserName;
	openPage?: (browser?: BrowserName) => Promise<OpenedBrowser>;
};

const REQUIRED_EXTENSION_FILES = ["manifest.json", "dist/service-worker.js"];

function candidatePaths(browser?: BrowserName): BrowserCandidate[] {
	const home = os.homedir();
	const candidates: BrowserCandidate[] = [];
	const add = (name: BrowserName, executable: string | undefined) => {
		if (executable && (!browser || browser === name)) candidates.push({ browser: name, executable });
	};
	const override = process.env.BROWSER_PILOT_BROWSER;
	if (override) {
		const basename = path.basename(override).toLowerCase();
		const overrideBrowser = basename.includes("edge") ? "edge" : basename.includes("chrome") || basename.includes("chromium") ? "chrome" : browser ?? "chrome";
		add(overrideBrowser, override);
	}

	if (process.platform === "win32") {
		const local = process.env.LOCALAPPDATA;
		const programFiles = process.env.PROGRAMFILES || "C:\\Program Files";
		const programFilesX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
		add("chrome", local ? path.join(local, "Google", "Chrome", "Application", "chrome.exe") : undefined);
		add("chrome", path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"));
		add("chrome", path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"));
		add("chrome", path.join(home, "scoop", "apps", "googlechrome", "current", "chrome.exe"));
		add("edge", path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"));
		add("edge", path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"));
	} else if (process.platform === "darwin") {
		add("chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
		add("edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
	} else {
		const directories = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
		for (const directory of directories) {
			add("chrome", path.join(directory, "google-chrome"));
			add("chrome", path.join(directory, "chromium"));
			add("chrome", path.join(directory, "chromium-browser"));
			add("edge", path.join(directory, "microsoft-edge"));
		}
	}

	const seen = new Set<string>();
	return candidates.filter((candidate) => {
		const key = process.platform === "win32" ? candidate.executable.toLowerCase() : candidate.executable;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

async function launch(executable: string, page: string): Promise<void> {
	const child = spawn(executable, [page], { detached: true, stdio: "ignore", windowsHide: true });
	await new Promise<void>((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", reject);
	});
	child.unref();
}

export async function openExtensionsPage(browser?: BrowserName): Promise<OpenedBrowser> {
	for (const candidate of candidatePaths(browser)) {
		try {
			await access(candidate.executable);
			const page = candidate.browser === "edge" ? "edge://extensions" : "chrome://extensions";
			await launch(candidate.executable, page);
			return { ...candidate, page };
		} catch {
			// Try the next installed browser.
		}
	}
	throw new Error(`No supported browser found. Set BROWSER_PILOT_BROWSER or open ${browser === "edge" ? "edge://extensions" : "chrome://extensions"} manually.`);
}

export function parseInstallBrowser(args: string[]): BrowserName | undefined {
	if (args.length === 0) return undefined;
	const value = args.length === 1 && args[0]?.startsWith("--browser=")
		? args[0].slice("--browser=".length)
		: args.length === 2 && args[0] === "--browser" ? args[1] : undefined;
	if (value === "chrome" || value === "edge") return value;
	throw new Error("Usage: browser-pilot-mcp install [--browser chrome|edge]");
}

export async function installBrowserExtension(options: InstallOptions = {}) {
	const root = packageRoot();
	const sourceDir = options.sourceDir ?? (root ? path.join(root, "bridge", "browser_pilot_bridge") : undefined);
	if (!sourceDir) throw new Error("Browser Pilot package root was not found");
	const installDir = path.resolve(options.installDir ?? path.join(stateDir(), "extension"));
	if (path.resolve(sourceDir) === installDir) throw new Error("Extension source and install directory must differ");
	for (const relative of REQUIRED_EXTENSION_FILES) {
		try { await access(path.join(sourceDir, relative)); }
		catch { throw new Error(`Packaged extension is incomplete: missing ${relative}. Run npm run build:bridge for a source checkout.`); }
	}
	await mkdir(path.dirname(installDir), { recursive: true, mode: 0o700 });
	await rm(installDir, { recursive: true, force: true });
	await cp(sourceDir, installDir, { recursive: true, force: true });
	try {
		const opened = await (options.openPage ?? openExtensionsPage)(options.browser);
		return { version: packageVersion(), installDir, ...opened };
	} catch (cause) {
		throw new Error(`Extension copied to ${installDir}, but its browser extensions page could not be opened: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
	}
}
