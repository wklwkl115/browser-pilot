export type BrowserCommandQueueInfo = {
	key: string;
	browserSessionId: string;
	tabId: number;
	depth: number;
};

export class BrowserCommandQueueRegistry {
	private readonly queues = new Map<string, Promise<unknown>>();
	private readonly depths = new Map<string, number>();

	enqueue<T>(browserSessionId: string, tabId: number, run: () => Promise<T>): Promise<T> {
		const key = this.key(browserSessionId, tabId);
		this.depths.set(key, (this.depths.get(key) || 0) + 1);
		const previous = this.queues.get(key) || Promise.resolve();
		const next = previous.catch(() => undefined).then(run).finally(() => {
			const depth = Math.max(0, (this.depths.get(key) || 1) - 1);
			if (depth === 0) this.depths.delete(key);
			else this.depths.set(key, depth);
			if (this.queues.get(key) === stored) this.queues.delete(key);
		});
		const stored = next.catch(() => undefined);
		this.queues.set(key, stored);
		return next;
	}

	snapshot(): BrowserCommandQueueInfo[] {
		return Array.from(this.depths.entries()).map(([key, depth]) => {
			const [browserSessionId, tabIdRaw] = key.split(":", 2);
			return { key, browserSessionId, tabId: Number(tabIdRaw), depth };
		}).sort((a, b) => a.key.localeCompare(b.key));
	}

	clear(): void {
		this.queues.clear();
		this.depths.clear();
	}

	private key(browserSessionId: string, tabId: number): string {
		return `${browserSessionId}:${tabId}`;
	}
}
