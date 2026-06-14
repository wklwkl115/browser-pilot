import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);

function messageOf(error) {
	if (error instanceof Error) return error.message;
	if (error && typeof error === "object" && typeof error.message === "string") return error.message;
	return String(error);
}

function codeOf(error) {
	return error && typeof error === "object" && typeof error.code === "string" ? error.code : undefined;
}

function includesPort(localAddress, port) {
	const text = String(localAddress || "");
	return text.endsWith(`:${port}`) || text.endsWith(`.${port}`);
}

async function runCommand(file, args, timeoutMs = 1_500) {
	try {
		const { stdout } = await execFileAsync(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
		return String(stdout || "");
	} catch {
		return "";
	}
}

async function readWindowsProcess(pid) {
	const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -First 1; if ($p) { [pscustomobject]@{pid=$p.ProcessId;name=$p.Name;commandLine=$p.CommandLine} | ConvertTo-Json -Compress }`;
	const stdout = await runCommand("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
	try {
		const parsed = JSON.parse(stdout);
		return { pid: Number(parsed.pid || pid), name: parsed.name || undefined, commandLine: parsed.commandLine || undefined };
	} catch {
		return { pid };
	}
}

async function findWindowsPortOwners(port) {
	const stdout = await runCommand("netstat.exe", ["-ano", "-p", "TCP"]);
	const pids = new Set();
	for (const line of stdout.split(/\r?\n/)) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 5 || parts[0].toUpperCase() !== "TCP") continue;
		const [_, local, __, state, pid] = parts;
		if (state.toUpperCase() !== "LISTENING" || !includesPort(local, port)) continue;
		const numericPid = Number(pid);
		if (Number.isInteger(numericPid) && numericPid > 0) pids.add(numericPid);
	}
	return await Promise.all(Array.from(pids).slice(0, 4).map(readWindowsProcess));
}

async function readProcCommandLine(pid) {
	try {
		const raw = await readFile(`/proc/${pid}/cmdline`);
		return raw.toString("utf8").replace(/\0/g, " ").trim() || undefined;
	} catch {
		return undefined;
	}
}

async function findPosixPortOwners(port) {
	const owners = [];
	const lsof = await runCommand("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
	for (const line of lsof.split(/\r?\n/).slice(1)) {
		const parts = line.trim().split(/\s+/);
		const pid = Number(parts[1]);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		owners.push({ pid, name: parts[0], commandLine: await readProcCommandLine(pid) });
	}
	if (owners.length) return owners.slice(0, 4);
	const ss = await runCommand("ss", ["-ltnp", `sport = :${port}`]);
	const pids = new Set(Array.from(ss.matchAll(/pid=(\d+)/g)).map((match) => Number(match[1])).filter((pid) => Number.isInteger(pid) && pid > 0));
	for (const pid of pids) owners.push({ pid, commandLine: await readProcCommandLine(pid) });
	return owners.slice(0, 4);
}

async function findPortOwners(port) {
	return process.platform === "win32" ? await findWindowsPortOwners(port) : await findPosixPortOwners(port);
}

async function fetchBridgeHealth(host, port, timeoutMs = 600) {
	return await new Promise((resolve) => {
		const req = http.get({ host, port, path: "/health", timeout: timeoutMs }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => { if (body.length < 4096) body += chunk; });
			res.on("end", () => {
				let json;
				try { json = JSON.parse(body); } catch {}
				resolve({ ok: res.statusCode && res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode, body: body.slice(0, 4096), json });
			});
		});
		req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "health_timeout" }); });
		req.on("error", (error) => resolve({ ok: false, error: messageOf(error), code: codeOf(error) }));
	});
}

export function classifyBridgePortOwner({ health, owners } = {}) {
	const ownerText = (owners || []).map((owner) => `${owner.name || ""} ${owner.commandLine || ""}`).join("\n").toLowerCase();
	const healthName = String(health?.json?.name || "").toLowerCase();
	const healthBody = String(health?.body || "").toLowerCase();
	if (/smoke-browser|smoke:browser|tests[\\/]+smoke|browser-tools-bridge-refactor/.test(ownerText)) return "orphan_socket";
	if (health?.ok && (healthName.includes("browser-pilot") || healthBody.includes("browser-pilot"))) return "agent_occupies";
	if (/pi[\\/]+agent|pi-coding-agent|browserbridgeserver|browser-pilot/.test(ownerText)) return "agent_occupies";
	if (/node|npm|pnpm|yarn|cmd\.exe|powershell/.test(ownerText)) return "orphan_socket";
	return "unknown_owner";
}

function adviceFor(reason) {
	if (reason === "agent_occupies") return "A running Pi agent/bridge already owns the MV3 extension port; stop that agent or run smoke after freeing the port. The smoke script will not kill user processes.";
	if (reason === "orphan_socket") return "A leftover local node/smoke process appears to own the port; inspect the reported PID and close it manually if it is stale.";
	return "Another process owns the port; inspect the reported PID/command line and free the port before running smoke.";
}

export async function diagnoseBridgePortInUse({ host, port, error }) {
	const [health, owners] = await Promise.all([
		fetchBridgeHealth(host, port),
		findPortOwners(port),
	]);
	const reason = classifyBridgePortOwner({ health, owners });
	return {
		reason,
		host,
		port,
		errorCode: codeOf(error),
		message: messageOf(error),
		owners,
		health,
		advice: adviceFor(reason),
	};
}
