/**
 * Persistent token store for connection-authorization.
 *
 * The single paired agent is persisted in the existing JSON envelope. All writes go
 * through an in-process async mutex (a module-level promise chain) because the
 * daemon is a single-process singleton — no cross-process locking needed.
 */
import path from "node:path";
import os from "node:os";
import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	AUTH_STORE_VERSION,
	PAIRING_CODE_ALPHABET,
	PAIRING_CODE_LENGTH,
	PAIRING_TOKEN_PREFIX,
	PAIR_PENDING_TTL_MS,
	ENV_AUTH_STATE_DIR,
	type AgentRecord,
	type AuthStore,
} from "./authTypes.js";
import { atomicWriteText } from "../../utils/fsAtomic.js";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Replicates daemonControl.stateDir() logic without importing that module. */
function stateDir(): string {
	return process.env.BROWSER_PILOT_DAEMON_STATE_DIR || path.join(os.homedir(), ".browser-pilot");
}

export function authStateDir(): string {
	return process.env[ENV_AUTH_STATE_DIR] ?? stateDir();
}

export function authStorePath(): string {
	return path.join(authStateDir(), "browser-daemon-auth.json");
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

function sha256hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function generatePairingCode(): string {
	const buf = randomBytes(PAIRING_CODE_LENGTH * 2); // excess to avoid bias
	let code = "";
	for (let i = 0; i < buf.length && code.length < PAIRING_CODE_LENGTH; i++) {
		const idx = buf[i] % PAIRING_CODE_ALPHABET.length;
		// Rejection sampling: only accept bytes that map without bias
		if (buf[i] < Math.floor(256 / PAIRING_CODE_ALPHABET.length) * PAIRING_CODE_ALPHABET.length) {
			code += PAIRING_CODE_ALPHABET[idx];
		}
	}
	// Fallback: fill remaining chars with simple modulo (acceptable for a 6-char human code)
	while (code.length < PAIRING_CODE_LENGTH) {
		const byte = randomBytes(1)[0];
		code += PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length];
	}
	return code;
}

// ---------------------------------------------------------------------------
// In-process async mutex
// ---------------------------------------------------------------------------

let writeChain: Promise<void> = Promise.resolve();

function serialized(fn: () => Promise<void>): Promise<void> {
	writeChain = writeChain.then(fn, fn);
	return writeChain;
}

function persistEventually(): void {
	void persistCurrentStore().catch((error: unknown) => {
		console.error(`[browser-pilot] auth store persistence failed: ${error instanceof Error ? error.message : String(error)}`);
	});
}

// ---------------------------------------------------------------------------
// In-memory cache — avoids disk-read/write races in the single-process daemon.
// All mutations update _cache synchronously; disk writes are still async for
// durability but reads always see the latest in-process state.
// ---------------------------------------------------------------------------

let _cache: AuthStore | null = null;
let _cachePath: string | null = null;

function getCache(): AuthStore {
	const currentPath = authStorePath();
	if (_cache && _cachePath === currentPath) return _cache;
	_cache = loadFromDisk(currentPath);
	_cachePath = currentPath;
	return _cache;
}

function isNullableString(value: unknown): boolean {
	return value === null || typeof value === "string";
}

function isAgentRecord(value: unknown): value is AgentRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return typeof record.pairingId === "string"
		&& typeof record.label === "string"
		&& typeof record.tokenHash === "string"
		&& ["pending", "active", "revoked"].includes(String(record.status))
		&& typeof record.createdAt === "string"
		&& isNullableString(record.approvedAt)
		&& isNullableString(record.revokedAt)
		&& isNullableString(record.lastSeenAt)
		&& (record.pairingCode === undefined || typeof record.pairingCode === "string")
		&& (record.pendingExpiresAt === undefined || isNullableString(record.pendingExpiresAt));
}

function loadFromDisk(filePath: string): AuthStore {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: AUTH_STORE_VERSION, agents: [] };
		throw new Error(`Unable to read Browser Pilot auth store: ${filePath}`, { cause: error });
	}
	try {
		const parsed = JSON.parse(raw) as Partial<AuthStore>;
		if (parsed.version === AUTH_STORE_VERSION && Array.isArray(parsed.agents) && parsed.agents.every(isAgentRecord)) {
			return { version: AUTH_STORE_VERSION, agents: parsed.agents.slice(-1) };
		}
	} catch (error) {
		throw new Error(`Browser Pilot auth store is malformed: ${filePath}; move or delete it and pair again`, { cause: error });
	}
	throw new Error(`Browser Pilot auth store is malformed: ${filePath}; move or delete it and pair again`);
}

// ---------------------------------------------------------------------------
// Persist (always persists the current cache to disk)
// ---------------------------------------------------------------------------

function persistCurrentStore(): Promise<void> {
	const filePath = authStorePath();
	const content = JSON.stringify(getCache(), null, 2) + "\n";
	return serialized(() => atomicWriteText(filePath, content));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function mintPending(label: string): { pairingId: string; code: string } {
	const pairingId = randomUUID();
	const code = generatePairingCode();
	const now = new Date().toISOString();
	const record: AgentRecord = {
		pairingId,
		label,
		tokenHash: "",
		status: "pending",
		createdAt: now,
		approvedAt: null,
		revokedAt: null,
		lastSeenAt: null,
		pairingCode: code,
		pendingExpiresAt: new Date(Date.now() + PAIR_PENDING_TTL_MS).toISOString(),
	};
	// Starting a new pairing replaces the previous agent immediately.
	getCache().agents = [record];
	// Write to disk asynchronously for persistence.
	persistEventually();
	return { pairingId, code };
}

export async function approve(pairingId: string): Promise<{ token: string } | null> {
	// Read from in-memory cache so we see the record even if the disk write from
	// mintPending() has not yet completed (the consent callback may fire before
	// the async disk write finishes).
	const cache = getCache();
	const record = cache.agents.find((a) => a.pairingId === pairingId && a.status === "pending");
	if (!record) return null;

	const rawToken = PAIRING_TOKEN_PREFIX + randomBytes(32).toString("base64url");
	const tokenHash = sha256hex(rawToken);
	const now = new Date().toISOString();

	// Update in-memory cache synchronously.
	record.tokenHash = tokenHash;
	record.status = "active";
	record.approvedAt = now;
	delete record.pairingCode;
	delete record.pendingExpiresAt;

	// Persist to disk — await so the write completes before the caller responds.
	// If the write fails the exception propagates, ensuring the caller knows the
	// approval was not durably persisted.
	await persistCurrentStore();

	return { token: rawToken };
}

export async function deny(pairingId: string): Promise<void> {
	// Remove from in-memory cache synchronously.
	const cache = getCache();
	const idx = cache.agents.findIndex((a) => a.pairingId === pairingId && a.status === "pending");
	if (idx !== -1) {
		cache.agents.splice(idx, 1);
		// Persist to disk — await so the removal is durable before returning.
		await persistCurrentStore();
	}
}

export function findByToken(rawToken: string | undefined): AgentRecord | null {
	if (!rawToken) return null;
	const hash = Buffer.from(sha256hex(rawToken));
	return getCache().agents.find((agent) => {
		const candidate = Buffer.from(agent.tokenHash);
		return candidate.length === hash.length && timingSafeEqual(candidate, hash);
	}) ?? null;
}

export async function revoke(pairingId: string): Promise<boolean> {
	const cache = getCache();
	const record = cache.agents.find((a) => a.pairingId === pairingId);
	if (!record) return false;

	const now = new Date().toISOString();
	// Update in-memory cache synchronously.
	record.status = "revoked";
	record.revokedAt = now;

	await persistCurrentStore();

	return true;
}

export function touch(pairingId: string): void {
	const now = new Date().toISOString();
	const cache = getCache();
	const record = cache.agents.find((a) => a.pairingId === pairingId);
	if (record) {
		record.lastSeenAt = now;
		persistEventually();
	}
}

export function sweepExpiredPending(): void {
	const cache = getCache();
	const now = Date.now();
	const before = cache.agents.length;
	cache.agents = cache.agents.filter((a) => {
		if (a.status !== "pending") return true;
		if (!a.pendingExpiresAt) return false;
		return Date.parse(a.pendingExpiresAt) > now;
	});
	if (cache.agents.length !== before) {
		persistEventually();
	}
}

export function listAgents(): AgentRecord[] {
	return getCache().agents;
}
