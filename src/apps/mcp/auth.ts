import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { ENV_AUTH_STATE_DIR, ENV_PAIRING_TOKEN, PAIR_WAIT_DEFAULT_MS } from "../daemon/authTypes.js";
import { controlRequest, ensureDaemon, stateDir } from "../daemon/daemonControl.js";
import { atomicWriteText } from "../../utils/fsAtomic.js";

const pairingTokens = new Map<string, string | undefined>();

export function agentTokenPath(projectRoot = process.cwd(), clientName = ""): string {
	const root = process.platform === "win32" ? path.resolve(projectRoot).toLowerCase() : path.resolve(projectRoot);
	const scope = createHash("sha256").update(root).update("\0").update(clientName).digest("hex").slice(0, 24);
	return path.join(process.env[ENV_AUTH_STATE_DIR] || stateDir(), "mcp-agents", `${scope}.json`);
}

export function resolvePairingToken(projectRoot = process.cwd(), clientName = ""): string | undefined {
	const configured = process.env[ENV_PAIRING_TOKEN];
	if (configured) return configured;
	const tokenPath = agentTokenPath(projectRoot, clientName);
	if (pairingTokens.has(tokenPath)) return pairingTokens.get(tokenPath);
	try {
		const parsed = JSON.parse(readFileSync(tokenPath, "utf8")) as { token?: unknown };
		const token = typeof parsed.token === "string" && parsed.token ? parsed.token : undefined;
		pairingTokens.set(tokenPath, token);
		return token;
	} catch {
		pairingTokens.set(tokenPath, undefined);
		return undefined;
	}
}

export async function runMcpPairing(args: Record<string, unknown>, signal?: AbortSignal, projectRoot = process.cwd(), clientName = ""): Promise<Record<string, unknown>> {
	const unknown = Object.keys(args).find((key) => !["action", "label", "pairingId"].includes(key));
	if (unknown) throw new Error(`browser_pair unknown parameter: ${unknown}`);
	const action = args.action;
	if (action !== "start" && action !== "wait") throw new Error("browser_pair action must be start or wait");
	if (action === "start") {
		const label = typeof args.label === "string" && args.label.trim() ? args.label.trim() : "mcp-agent";
		const daemon = await ensureDaemon();
		const response = await controlRequest(daemon, "POST", "/pair/start", { label }, 10_000, { signal });
		if (response.status !== 200 || response.json?.ok !== true) throw new Error(String(response.json?.code || response.json?.error || `pair start failed (HTTP ${response.status})`));
		return { action, pairingId: String(response.json.pairingId), code: String(response.json.code) };
	}
	const pairingId = typeof args.pairingId === "string" ? args.pairingId.trim() : "";
	if (!pairingId) throw new Error("browser_pair wait requires pairingId");
	const daemon = await ensureDaemon();
	const response = await controlRequest(daemon, "POST", "/pair/wait", { pairingId }, PAIR_WAIT_DEFAULT_MS + 5_000, { signal });
	if (response.status !== 200 || response.json?.ok !== true || typeof response.json.token !== "string") throw new Error(String(response.json?.code || response.json?.error || `pair wait failed (HTTP ${response.status})`));
	const tokenPath = agentTokenPath(projectRoot, clientName);
	await atomicWriteText(tokenPath, `${JSON.stringify({ token: response.json.token, pairingId }, null, 2)}\n`);
	pairingTokens.set(tokenPath, response.json.token);
	return { action, pairingId, paired: true };
}
