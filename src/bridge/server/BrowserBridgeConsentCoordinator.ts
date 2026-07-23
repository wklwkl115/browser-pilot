import { WebSocket } from "ws";
import {
  CONSENT_MESSAGE_TYPES,
  type ConsentDecision,
  type ConsentRequestEnvelope,
  type PairedAgentSummary,
  type PairedAgentsEnvelope,
} from "../protocol/consentTypes.js";

export interface BrowserBridgeConsentCoordinatorDeps {
  /** Return the currently-selected open extension WebSocket, or undefined if none is connected. */
  getExtensionSocket(): WebSocket | undefined;
}

type PendingConsentEntry = {
  pairingId: string;
  resolve: (decision: ConsentDecision) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class BrowserBridgeConsentCoordinator {
  private readonly deps: BrowserBridgeConsentCoordinatorDeps;
  private pending?: PendingConsentEntry;
  private revokeHandler: ((pairingId: string) => void) | undefined;

  constructor(deps: BrowserBridgeConsentCoordinatorDeps) {
    this.deps = deps;
  }

  hasConsentSurface(): boolean {
    return this.deps.getExtensionSocket() !== undefined;
  }

  sendConsentRequest(input: {
    pairingId: string;
    label: string;
    code: string;
    expiresAt: string;
    timeoutMs: number;
  }): Promise<ConsentDecision> {
    const socket = this.deps.getExtensionSocket();
    if (!socket) {
      return Promise.reject(new Error("No extension consent surface is connected"));
    }

    return new Promise<ConsentDecision>((resolve) => {
      const { pairingId, label, code, expiresAt, timeoutMs } = input;
      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending.resolve("timeout");
      }

      const timer = setTimeout(() => {
        if (this.pending?.pairingId === pairingId) this.pending = undefined;
        resolve("timeout");
      }, Math.max(0, Math.floor(timeoutMs)));

      this.pending = { pairingId, resolve, timer };

      const envelope: ConsentRequestEnvelope = {
        type: CONSENT_MESSAGE_TYPES.request,
        pairingId,
        label,
        code,
        expiresAt,
      };

      try {
        socket.send(JSON.stringify(envelope));
      } catch {
        clearTimeout(timer);
        if (this.pending?.pairingId === pairingId) this.pending = undefined;
        resolve("timeout");
      }
    });
  }

  resolveConsent(pairingId: string, decision: "approve" | "deny"): void {
    const entry = this.pending;
    if (!entry || entry.pairingId !== pairingId) return;
    clearTimeout(entry.timer);
    this.pending = undefined;
    entry.resolve(decision);
  }

  onRevokeRequest(handler: (pairingId: string) => void): void {
    this.revokeHandler = handler;
  }

  fireRevoke(pairingId: string): void {
    this.revokeHandler?.(pairingId);
  }

  broadcastPairedAgents(agents: PairedAgentSummary[]): void {
    const socket = this.deps.getExtensionSocket();
    if (!socket) return;

    const envelope: PairedAgentsEnvelope = {
      type: CONSENT_MESSAGE_TYPES.pairedAgents,
      agents,
    };

    try {
      socket.send(JSON.stringify(envelope));
    } catch {
      /* best-effort broadcast — no extension means nothing to notify */
    }
  }
}
