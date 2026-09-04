import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { ensurePrivateStateDirectory } from "../../src/apps/daemon/daemonControl.ts";
import { BROWSER_PILOT_BRIDGE_SECRET_PLACEHOLDER } from "../../src/bridge/security/bridgePairing.ts";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const root = repositoryRoot;
const launchTimeoutMs = Math.max(5_000, Number(process.env.BROWSER_PILOT_SMOKE_LAUNCH_TIMEOUT_MS || 20_000));

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function existingBrowserCandidates() {
	const candidates = [process.env.BROWSER_PILOT_SMOKE_BROWSER];
	if (process.platform === "win32") {
		candidates.push(
			path.join(
				process.env.PROGRAMFILES || "C:\\Program Files",
				"Google",
				"Chrome for Testing",
				"Application",
				"chrome.exe",
			),
			path.join(
				process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
				"Microsoft",
				"Edge",
				"Application",
				"msedge.exe",
			),
			path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
		);
	} else if (process.platform === "darwin") {
		candidates.push(
			"/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		);
	} else {
		candidates.push(
			"/usr/bin/google-chrome-for-testing",
			"/usr/bin/google-chrome",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/usr/bin/microsoft-edge",
		);
	}
	const found = [];
	for (const candidate of [...new Set(candidates.filter(Boolean))]) {
		try {
			await access(candidate);
			found.push(candidate);
		} catch {
			// Try the next conventional browser path.
		}
	}
	return found;
}

async function daemonJson(daemon, pathname, init = {}, timeoutMs = 10_000) {
	const response = await fetch(`http://${daemon.controlHost}:${daemon.controlPort}${pathname}`, {
		...init,
		headers: {
			"x-browser-pilot-daemon-token": daemon.token,
			...(init.body ? { "content-type": "application/json" } : {}),
			...init.headers,
		},
		signal: AbortSignal.timeout(timeoutMs),
	});
	const value = await response.json();
	if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}: ${JSON.stringify(value)}`);
	return value;
}

function resultText(result) {
	return Array.isArray(result?.content)
		? result.content.map((item) => (typeof item?.text === "string" ? item.text : "")).join("\n")
		: "";
}

function resultEnvelope(result, label) {
	try {
		return JSON.parse(resultText(result));
	} catch {
		throw new Error(`${label} did not return JSON: ${resultText(result)}`);
	}
}

async function invoke(daemon, tool, params, transportTimeoutMs = 10_000, cwd = root) {
	const result = await daemonJson(
		daemon,
		"/invoke",
		{
			method: "POST",
			body: JSON.stringify({ tool, params, cwd, contractIdentity: daemon.contractIdentity }),
		},
		transportTimeoutMs,
	);
	if (result.ok !== true || result.terminate === true)
		throw new Error(`${tool} failed: ${resultText(result) || JSON.stringify(result)}`);
	return result;
}

async function waitForStatus(daemon, predicate, label) {
	const deadline = Date.now() + launchTimeoutMs;
	let last;
	do {
		last = await daemonJson(daemon, "/status?tabs=1");
		if (predicate(last)) return last;
		await delay(250);
	} while (Date.now() < deadline);
	throw new Error(
		`${label} timed out after ${launchTimeoutMs}ms; readiness=${last?.readiness ?? "unknown"}, tabs=${last?.tabCount ?? 0}`,
	);
}

function captureProcessOutput(child) {
	let output = "";
	const append = (chunk) => {
		output = (output + String(chunk)).slice(-8_000);
	};
	child.stdout?.on("data", append);
	child.stderr?.on("data", append);
	return () => output;
}

async function closeBrowserViaCdp(profileDir) {
	let endpoint;
	try {
		const [portLine, socketPath] = (await readFile(path.join(profileDir, "DevToolsActivePort"), "utf8"))
			.trim()
			.split(/\r?\n/);
		const port = Number(portLine);
		if (!Number.isInteger(port) || port <= 0 || !socketPath?.startsWith("/")) return false;
		endpoint = `ws://127.0.0.1:${port}${socketPath}`;
	} catch {
		return false;
	}
	return await new Promise((resolve) => {
		const socket = new WebSocket(endpoint);
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => {
			socket.terminate();
			finish(false);
		}, 2_000);
		socket.once("open", () => socket.send(JSON.stringify({ id: 1, method: "Browser.close" })));
		socket.on("message", (data) => {
			try {
				const message = JSON.parse(String(data));
				if (message?.id !== 1) return;
				if (message.error) finish(false);
				else finish(true);
			} catch {
				/* wait for the Browser.close response or socket close */
			}
		});
		socket.once("close", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

async function stopBrowser(child, profileDir) {
	if (profileDir && (await closeBrowserViaCdp(profileDir))) await delay(1_000);
	if (!child || child.exitCode !== null) return;
	child.kill();
	const exited = await Promise.race([
		new Promise((resolve) => child.once("exit", () => resolve(true))),
		delay(2_000).then(() => false),
	]);
	if (exited || child.exitCode !== null) return;
	child.kill("SIGKILL");
	await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(2_000)]);
}

async function removeProfileDir(profileDir) {
	if (
		path.dirname(path.resolve(profileDir)) !== path.resolve(os.tmpdir()) ||
		!path.basename(profileDir).startsWith("browser-pilot-test-")
	)
		throw new Error(`Refusing to remove unexpected browser profile: ${profileDir}`);
	try {
		await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	} catch (error) {
		const code = error && typeof error === "object" ? String(error.code || "") : "";
		if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(code)) throw error;
		console.warn(
			`[browser-pilot-smoke] temporary profile cleanup was deferred after a Windows file lock (${code}): ${path.basename(profileDir)}`,
		);
	}
}

async function launchConnectedBrowser(daemon, fixtureUrl, profileRoot, extensionDir) {
	const candidates = await existingBrowserCandidates();
	if (!candidates.length)
		throw new Error("no Chrome/Edge/Chromium executable found; set BROWSER_PILOT_SMOKE_BROWSER");
	const failures = [];
	for (const executable of candidates) {
		const profileDir = await mkdtemp(path.join(profileRoot, "candidate-"));
		const child = spawn(
			executable,
			[
				"--headless=new",
				"--disable-gpu",
				"--no-first-run",
				"--no-default-browser-check",
				"--remote-debugging-port=0",
				"--enable-features=Prerender2",
				"--disable-features=PreloadingHoldback,Prerender2MemoryControls",
				`--user-data-dir=${profileDir}`,
				`--disable-extensions-except=${extensionDir}`,
				`--load-extension=${extensionDir}`,
				"--window-size=1280,900",
				fixtureUrl,
			],
			{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
		);
		const output = captureProcessOutput(child);
		try {
			const status = await waitForStatus(
				daemon,
				(value) =>
					value.extensionConnected === true &&
					value.extension?.extensionStale !== true &&
					Array.isArray(value.tabs) &&
					value.tabs.some((tab) => String(tab?.url || "").startsWith(fixtureUrl)),
				`extension handshake via ${executable}`,
			);
			return { child, executable, status, output, profileDir };
		} catch (error) {
			failures.push({
				executable,
				error: error instanceof Error ? error.message : String(error),
				output: output(),
			});
			await stopBrowser(child, profileDir);
		}
	}
	throw new Error(`no browser completed the extension handshake: ${JSON.stringify(failures)}`);
}

/** Uses only an isolated browser profile and an ephemeral pairing secret, never the user's installed extension. */
export async function withBrowserHarness(createFixture, run) {
	await import("../build-bridge.mjs");
	const profileDir = await mkdtemp(path.join(os.tmpdir(), "browser-pilot-test-"));
	let fixture;
	let daemon;
	let browser;
	try {
		ensurePrivateStateDirectory(profileDir);
		const extensionDir = path.join(profileDir, "extension");
		await cp(path.join(root, "bridge", "browser_pilot_bridge"), extensionDir, { recursive: true });
		const secret = randomBytes(32).toString("base64url");
		const workerPath = path.join(extensionDir, "dist", "service-worker.js");
		const worker = await readFile(workerPath, "utf8");
		if (!worker.includes(BROWSER_PILOT_BRIDGE_SECRET_PLACEHOLDER))
			throw new Error("Test extension lacks pairing placeholder");
		await writeFile(workerPath, worker.replaceAll(BROWSER_PILOT_BRIDGE_SECRET_PLACEHOLDER, secret));
		fixture = await createFixture();
		const { startDaemon } = await import("../../src/apps/daemon/server.ts");
		daemon = await startDaemon({ writeLock: false, startBridgeEagerly: true, bridgeSecret: secret });
		if (!daemon.bridgePort) throw new Error("daemon did not start the browser bridge");
		browser = await launchConnectedBrowser(daemon, fixture.url, profileDir, extensionDir);
		return await run({ daemon, browser, fixture });
	} finally {
		try {
			await stopBrowser(browser?.child, browser?.profileDir);
		} finally {
			try {
				await daemon?.close();
			} finally {
				try {
					await fixture?.close();
				} finally {
					await removeProfileDir(profileDir);
				}
			}
		}
	}
}

export { invoke, resultText, resultEnvelope, waitForStatus };
