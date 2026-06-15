/**
 * Pairing-token persistence helpers for the CLI agent side.
 *
 * The daemon manages the auth store; the CLI side only needs to persist
 * the raw token (so it can attach it to future /lease and /invoke calls)
 * alongside the pairingId and label for display purposes.
 */
import path from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { atomicWriteText } from "../src/utils/fsAtomic.js";
import { ENV_AUTH_STATE_DIR, ENV_PAIRING_TOKEN } from "./authTypes.js";
import { stateDir } from "./daemonControl.js";

/** Directory where the CLI stores its agent-side auth files. */
export function authStateDir(): string {
	return process.env[ENV_AUTH_STATE_DIR] || stateDir();
}

/** Path to the persisted agent token JSON file. */
export function agentTokenPath(): string {
	return path.join(authStateDir(), "agent-token.json");
}

export interface AgentTokenFile {
	token: string;
	pairingId: string;
	label: string;
}

/**
 * Read the persisted agent token from disk.
 * Returns null on any read/parse failure (file absent, malformed JSON, etc.).
 */
export function readAgentToken(): AgentTokenFile | null {
	try {
		const raw = readFileSync(agentTokenPath(), "utf8");
		const parsed = JSON.parse(raw) as Partial<AgentTokenFile>;
		if (
			typeof parsed.token === "string" &&
			typeof parsed.pairingId === "string" &&
			typeof parsed.label === "string"
		) {
			return { token: parsed.token, pairingId: parsed.pairingId, label: parsed.label };
		}
	} catch {
		/* missing / unreadable / malformed → treat as absent */
	}
	return null;
}

/**
 * Persist an agent token to disk atomically.
 * Creates the state directory if needed before writing.
 */
export async function writeAgentToken(token: string, pairingId: string, label: string): Promise<void> {
	mkdirSync(authStateDir(), { recursive: true });
	const content: AgentTokenFile = { token, pairingId, label };
	await atomicWriteText(agentTokenPath(), JSON.stringify(content, null, 2) + "\n");
}

/**
 * Resolve the pairing token to attach to control requests.
 *
 * Precedence (highest to lowest):
 *   1. Explicit `--token` CLI flag value
 *   2. `BROWSER_PILOT_PAIRING_TOKEN` environment variable
 *   3. Persisted agent-token file on disk
 *
 * Returns `undefined` if no token is available from any source.
 */
export function resolvePairingToken(flag?: string): string | undefined {
	if (flag) return flag;
	const env = process.env[ENV_PAIRING_TOKEN];
	if (env) return env;
	return readAgentToken()?.token ?? undefined;
}
