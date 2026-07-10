import type { ConsentDecision } from "../../bridge/protocol/consentTypes.js";

// Re-export so cli-side modules have a single import site for the consent seam.
export type { ConsentDecision };

// ---- Pairing token + code ----
export const PAIRING_TOKEN_PREFIX = "bp_pat_";
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no O/0/I/1/L
export const PAIRING_CODE_LENGTH = 6;

// ---- Auth store ----
export const AUTH_STORE_VERSION = 1 as const;
export type AgentStatus = "pending" | "active" | "revoked";

export interface AgentRecord {
  pairingId: string;
  label: string;
  tokenHash: string; // sha256 hex of the raw token; the raw token is never stored
  status: AgentStatus;
  createdAt: string;
  approvedAt: string | null;
  revokedAt: string | null;
  lastSeenAt: string | null;
  pairingCode?: string; // present only while status === "pending"
  pendingExpiresAt?: string | null;
}

export interface AuthStore {
  version: typeof AUTH_STORE_VERSION;
  agents: AgentRecord[];
}

// ---- TTLs / timeouts (milliseconds) ----
export const TENANT_LEASE_TTL_MS = 120_000;
export const PAIR_PENDING_TTL_MS = 120_000;
export const PAIR_WAIT_DEFAULT_MS = 120_000;

// ---- Headers / environment variables ----
export const PAIRING_TOKEN_HEADER = "x-browser-pilot-pairing-token";
export const ENV_PAIRING_TOKEN = "BROWSER_PILOT_PAIRING_TOKEN";
export const ENV_REQUIRE_PAIRING = "BROWSER_PILOT_REQUIRE_PAIRING";
export const ENV_AUTH_STATE_DIR = "BROWSER_PILOT_AUTH_STATE_DIR";

// ---- Error codes (returned in HTTP body { ok:false, code }) ----
export const AUTH_ERROR_CODES = {
  pairNoExtension: "PAIR_NO_EXTENSION",
  pairTimeout: "PAIR_TIMEOUT",
  pairDenied: "PAIR_DENIED",
  pairingInvalid: "PAIRING_INVALID",
  pairingRevoked: "PAIRING_REVOKED",
  pairingNotFound: "PAIRING_NOT_FOUND",
  leaseBusy: "LEASE_BUSY",
} as const;

// CLI-side error code surfaced by invokeTool when a command call hits a held lease (HTTP 409).
export const CLI_LEASE_BUSY = "CLI_LEASE_BUSY";

// ---- HTTP response shapes shared with the CLI ----
export type LeaseAction = "acquire" | "release" | "status";
export interface LeaseInfo {
  leaseId: string;
  pairingId: string;
  label: string;
  since: string;
  expiresAt: string;
}
export interface LeaseAcquireResponse { ok: true; lease: LeaseInfo; }
export interface LeaseStatusResponse { ok: true; lease: LeaseInfo | null; self: boolean; }
export interface LeaseBusyResponse {
  ok: false;
  code: "LEASE_BUSY";
  heldBy: { pairingId: string; label: string; since: string; expiresAt: string };
}

export interface RevokeResponse { ok: true; revoked: string; }

export interface PairingSummary {
  pairingId: string;
  label: string;
  status: AgentStatus;
  lastSeenAt: string | null;
  leaseHeld: boolean;
}
export interface PairingsResponse { ok: true; agents: PairingSummary[]; }
