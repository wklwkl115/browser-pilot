// Canonical wire contract for the connection-authorization consent channel.
// Shared by the daemon (cli/ + src/driver/). The Chrome extension (bridge_src/) is a
// separate build unit and cannot import this module, so the `type` string constants
// below ARE the wire contract the extension must match verbatim.

export const CONSENT_MESSAGE_TYPES = {
  request: "consent-request",
  response: "consent-response",
  revoke: "revoke-request",
  pairedAgents: "paired-agents",
} as const;

export interface ConsentRequestEnvelope {
  type: "consent-request";
  pairingId: string;
  label: string;
  code: string; // 6-char human-verification code, shown in terminal AND popup
  expiresAt: string; // ISO timestamp
}

export interface ConsentResponseEnvelope {
  type: "consent-response";
  pairingId: string;
  decision: "approve" | "deny";
}

export interface RevokeRequestEnvelope {
  type: "revoke-request";
  pairingId: string;
}

export type ConsentInboundEnvelope = ConsentResponseEnvelope | RevokeRequestEnvelope;

export interface PairedAgentSummary {
  pairingId: string;
  label: string;
  status: "pending" | "active" | "revoked";
  leaseHeld: boolean;
  lastSeenAt: string | null;
}

export interface PairedAgentsEnvelope {
  type: "paired-agents";
  agents: PairedAgentSummary[];
}

export type ConsentDecision = "approve" | "deny" | "timeout";

// The seam between WS-A (daemon endpoints call this) and WS-B (transport implements this).
export interface ConsentPort {
  // True when an extension consent surface is currently connected.
  hasConsentSurface(): boolean;
  // Push a consent request to the connected extension; resolves when the user decides
  // or the wait times out. Rejects only on transport failure (no extension connected).
  sendConsentRequest(input: {
    pairingId: string;
    label: string;
    code: string;
    expiresAt: string;
    timeoutMs: number;
  }): Promise<ConsentDecision>;
  // Register a callback invoked when the extension pushes a revoke-request.
  onRevokeRequest(handler: (pairingId: string) => void): void;
  // Push current paired-agent summaries to the connected extension consent surface.
  broadcastPairedAgents(agents: PairedAgentSummary[]): void;
}
