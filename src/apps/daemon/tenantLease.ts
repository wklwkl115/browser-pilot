/**
 * Single-tenant coarse lease registry.
 *
 * Only one agent can hold the "tenant" lease at a time. FCFS: the first agent
 * that acquires the lease holds it until it releases or the TTL expires. The
 * same holder can refresh its own lease. A background interval sweeps expired
 * leases every 15 seconds.
 */
import { randomUUID } from "node:crypto";
import { TENANT_LEASE_TTL_MS, type LeaseInfo } from "./authTypes.js";

export class TenantLeaseRegistry {
	private current: LeaseInfo | null = null;
	private readonly timer: ReturnType<typeof setInterval>;

	constructor() {
		this.timer = setInterval(() => {
			if (this.current && Date.parse(this.current.expiresAt) < Date.now()) {
				this.current = null;
			}
		}, 15_000);
		// Don't keep the process alive just for this sweep.
		this.timer.unref?.();
	}

	/** Stop the background sweep timer. */
	stop(): void {
		clearInterval(this.timer);
	}

	/** Current lease info, or null if free. */
	status(): LeaseInfo | null {
		if (this.current && Date.parse(this.current.expiresAt) < Date.now()) {
			this.current = null;
		}
		return this.current;
	}

	/** PairingId of the current holder, or null if free. */
	holderPairingId(): string | null {
		return this.status()?.pairingId ?? null;
	}

	/**
	 * Acquire or refresh the lease.
	 * FCFS: if free or same holder → ok; else → busy.
	 */
	acquire(
		pairingId: string,
		label: string,
		ttlMs: number = TENANT_LEASE_TTL_MS,
	): { ok: true; lease: LeaseInfo } | { ok: false; heldBy: { pairingId: string; label: string; since: string; expiresAt: string } } {
		const existing = this.status();

		if (existing === null || existing.pairingId === pairingId) {
			// Fresh acquire or refresh.
			const isRefresh = existing !== null && existing.pairingId === pairingId;
			const now = new Date().toISOString();
			const lease: LeaseInfo = {
				leaseId: isRefresh ? existing.leaseId : randomUUID(),
				pairingId,
				label,
				since: isRefresh ? existing.since : now,
				expiresAt: new Date(Date.now() + ttlMs).toISOString(),
			};
			this.current = lease;
			return { ok: true, lease };
		}

		return {
			ok: false,
			heldBy: { pairingId: existing.pairingId, label: existing.label, since: existing.since, expiresAt: existing.expiresAt },
		};
	}

	/**
	 * Ensure the caller holds the lease, auto-acquiring if free or refreshing
	 * if already the holder.
	 */
	ensureHeld(
		pairingId: string,
		label: string,
	): { ok: true } | { ok: false; heldBy: { pairingId: string; label: string; since: string; expiresAt: string } } {
		const result = this.acquire(pairingId, label);
		if (result.ok) return { ok: true };
		return { ok: false, heldBy: result.heldBy };
	}

	/** Extend the expiry if the caller is the current holder. */
	refresh(pairingId: string, ttlMs: number = TENANT_LEASE_TTL_MS): void {
		if (this.current?.pairingId === pairingId) {
			this.current = {
				...this.current,
				expiresAt: new Date(Date.now() + ttlMs).toISOString(),
			};
		}
	}

	/** Release the lease if the caller is the current holder. */
	release(pairingId: string): void {
		if (this.current?.pairingId === pairingId) {
			this.current = null;
		}
	}

	/** Force-release the lease if the caller is the current holder (used on revoke). */
	forceRelease(pairingId: string): void {
		if (this.current?.pairingId === pairingId) {
			this.current = null;
		}
	}
}
