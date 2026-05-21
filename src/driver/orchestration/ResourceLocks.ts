import { orchestrationLocked } from "./orchestrationErrors";

export type ResourceLockRelease = () => void;

export class ResourceLocks {
	private readonly held = new Map<string, { acquiredAt: number; owner?: string }>();

	acquire(key: string, owner?: string): ResourceLockRelease {
		const normalizedKey = String(key || "").trim();
		if (!normalizedKey) throw orchestrationLocked("Cannot acquire an empty orchestration lock", { key });
		const existing = this.held.get(normalizedKey);
		if (existing) throw orchestrationLocked("Browser orchestration resource is locked", { key: normalizedKey, owner: existing.owner, acquiredAt: existing.acquiredAt });
		this.held.set(normalizedKey, { acquiredAt: Date.now(), owner });
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.held.delete(normalizedKey);
		};
	}

	async runExclusive<T>(key: string, owner: string | undefined, fn: () => Promise<T>): Promise<T> {
		const release = this.acquire(key, owner);
		try {
			return await fn();
		} finally {
			release();
		}
	}

	isLocked(key: string): boolean {
		return this.held.has(key);
	}

	snapshot(): Array<{ key: string; acquiredAt: number; owner?: string }> {
		return Array.from(this.held.entries()).map(([key, value]) => ({ key, ...value }));
	}

	clear(): void {
		this.held.clear();
	}
}
