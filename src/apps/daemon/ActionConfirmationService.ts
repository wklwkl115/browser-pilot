import { createHash, randomBytes } from "node:crypto";
import {
	type ActionConfirmationRecord,
	type ActionConfirmationDecision,
	verifyActionConfirmation,
	redactedSemanticActionForDigest,
	pageIdentityDigestMaterial,
	actionRequiresConfirmation,
} from "../../kernels/agent/actionConfirmation.js";
import type { PageIdentity } from "../../kernels/session/pageIdentity.js";
import type { SemanticActionV1 } from "../../kernels/agent/agentTypes.js";

const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_PENDING = 256;

function digest(parts: string[]): string {
	return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

export function ownerPairingDigest(owner: string): string {
	return digest(["owner", owner]);
}

export function contextRefDigest(contextRef: string): string {
	return digest(["context", contextRef]);
}

export function semanticActionDigest(action: SemanticActionV1): string {
	return digest(["action", JSON.stringify(redactedSemanticActionForDigest(action))]);
}

/**
 * Daemon-owned action confirmation store.
 * Extends consent ownership (owner-bound, one-shot) without a second UI consent store.
 * Pairing authorization remains BrowserBridgeConsentCoordinator.
 */
export class ActionConfirmationService {
	private readonly pending = new Map<string, ActionConfirmationRecord>();
	private nowFn: () => number;

	constructor(options: { now?: () => number } = {}) {
		this.nowFn = options.now ?? (() => Date.now());
	}

	mint(input: {
		owner: string;
		contextRef: string;
		contextRevision: number;
		pageIdentity?: PageIdentity;
		action: SemanticActionV1;
		reason: string;
		ttlMs?: number;
	}): ActionConfirmationRecord {
		this.evict();
		while (this.pending.size >= MAX_PENDING) {
			const first = this.pending.keys().next().value;
			if (first === undefined) break;
			this.pending.delete(first);
		}
		const now = this.nowFn();
		const record: ActionConfirmationRecord = {
			confirmationRef: `cnf_${randomBytes(12).toString("hex")}`,
			ownerPairingDigest: ownerPairingDigest(input.owner),
			contextRefDigest: contextRefDigest(input.contextRef),
			contextRevision: input.contextRevision,
			pageIdentityDigest: digest([pageIdentityDigestMaterial(input.pageIdentity)]),
			semanticActionDigest: semanticActionDigest(input.action),
			reason: input.reason,
			expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
		};
		this.pending.set(record.confirmationRef, record);
		return record;
	}

	consume(input: {
		confirmationRef: string;
		owner: string;
		contextRef: string;
		contextRevision: number;
		pageIdentity?: PageIdentity;
		action: SemanticActionV1;
	}): ActionConfirmationDecision {
		// Read before TTL eviction so expired records still report "expired" (not "not_found").
		const record = this.pending.get(input.confirmationRef);
		const decision = verifyActionConfirmation({
			record,
			now: this.nowFn(),
			ownerPairingDigest: ownerPairingDigest(input.owner),
			contextRefDigest: contextRefDigest(input.contextRef),
			contextRevision: input.contextRevision,
			pageIdentityDigest: digest([pageIdentityDigestMaterial(input.pageIdentity)]),
			semanticActionDigest: semanticActionDigest(input.action),
		});
		if (record && (decision.kind === "authorized" || decision.kind === "expired" || decision.kind === "consumed")) {
			if (decision.kind === "authorized") record.consumedAt = this.nowFn();
			this.pending.delete(input.confirmationRef);
		}
		this.evict();
		return decision;
	}

	requiresConfirmation(input: {
		action: SemanticActionV1;
		candidateRisk?: "normal" | "sensitive" | "irreversible";
	}) {
		return actionRequiresConfirmation(input);
	}

	expireAll(): void {
		this.pending.clear();
	}

	private evict(): void {
		const now = this.nowFn();
		for (const [id, record] of this.pending) {
			if (now > record.expiresAt || record.consumedAt !== undefined) this.pending.delete(id);
		}
	}
}

let activeConfirmation: ActionConfirmationService | undefined;

export function installActionConfirmationService(service: ActionConfirmationService): ActionConfirmationService {
	activeConfirmation = service;
	return service;
}

export function getActionConfirmationService(): ActionConfirmationService {
	if (!activeConfirmation) activeConfirmation = new ActionConfirmationService();
	return activeConfirmation;
}

export function resetActionConfirmationServiceForTests(): void {
	activeConfirmation = undefined;
}
