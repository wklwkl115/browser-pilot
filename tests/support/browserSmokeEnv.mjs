import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

const BROWSER_LAUNCH_HARDENING_ARGS = Object.freeze([
	"--disable-background-networking",
	"--disable-sync",
	"--disable-component-update",
	"--disable-default-apps",
]);
const RECENT_EPHEMERAL_PORTS = new Set();

function defaultChromeCandidates(envNames = ["PI_BROWSER_SMOKE_CHROME"]) {
	const envCandidates = envNames.map((name) => process.env[name]).filter(Boolean);
	return [
		...envCandidates,
		process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
		process.platform === "win32" ? path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe") : undefined,
		process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe") : undefined,
		process.platform === "win32" ? path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe") : undefined,
		process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe") : undefined,
		process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined,
		"google-chrome",
		"chromium",
		"chromium-browser",
	].filter(Boolean);
}

function isWindowsChromeExecutable(chromeExe) {
	return process.platform !== "win32" && /\.exe$/i.test(String(chromeExe || "")) && /^\/mnt\/[a-z]\//i.test(String(chromeExe || ""));
}

export function windowsPathForChrome(value, chromeExe) {
	if (!isWindowsChromeExecutable(chromeExe)) return value;
	const match = /^\/mnt\/([a-z])\/(.*)$/i.exec(String(value || ""));
	if (!match) return value;
	return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`;
}

export function browserLaunchHardeningArgs() {
	return [...BROWSER_LAUNCH_HARDENING_ARGS];
}

export function chromePath(options = {}) {
	const envNames = options.envNames || ["PI_BROWSER_SMOKE_CHROME"];
	const candidates = options.candidates || defaultChromeCandidates(envNames);
	const found = findChromePath({ candidates });
	if (found) return found;
	throw new Error(`Chrome/Chromium executable not found; set ${envNames.join(" or ")}. Tried: ${candidates.join(", ")}`);
}

export function findChromePath(options = {}) {
	const envNames = options.envNames || ["PI_BROWSER_SMOKE_CHROME"];
	const candidates = options.candidates || defaultChromeCandidates(envNames);
	for (const candidate of candidates) if (existsSync(candidate)) return candidate;
	return undefined;
}

async function closeServer(server) {
	if (!server.listening) return;
	await new Promise((resolve) => server.close(resolve));
}

export async function freePort(start = 0, end = 0) {
	if (start === 0) {
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const server = createServer();
			await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
			const address = server.address();
			await closeServer(server);
			if (!address || typeof address !== "object" || typeof address.port !== "number") throw new Error("Could not allocate ephemeral port");
			if (RECENT_EPHEMERAL_PORTS.has(address.port)) continue;
			RECENT_EPHEMERAL_PORTS.add(address.port);
			return address.port;
		}
		throw new Error("Could not allocate a distinct ephemeral port");
	}
	for (let port = start; port <= end; port += 1) {
		const server = createServer();
		try {
			await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
			await closeServer(server);
			return port;
		} catch {
			await closeServer(server);
		}
	}
	throw new Error(`No free port in range ${start}-${end}`);
}

export function stopProcessTree(child) {
	const pid = typeof child === "number" || typeof child === "string" ? child : child?.pid;
	if (!pid) return;
	try {
		if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
		else if (typeof child?.kill === "function") child.kill("SIGTERM");
		else process.kill(Number(pid), "SIGTERM");
	} catch {}
}

export function stopBrowserProcess(child) {
	stopProcessTree(child);
}
