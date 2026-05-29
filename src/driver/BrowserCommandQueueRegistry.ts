import { BrowserBridgeError } from "./errors";

const DEFAULT_MAX_QUEUE_DEPTH = 64;

export type BrowserCommandQueueInfo = {
	key: string;
	browserSessionId: string;
	tabId: number;
	depth: number;
};

export class BrowserCommandQueueRegistry {
	private readonly queues = new Map<string, Promise<unknown>>();
	private readonly depths = new Map<string, number>();
	private readonly maxDepth: number;

	constructor(maxDepth = DEFAULT_MAX_QUEUE_DEPTH) {
		this.maxDepth = Math.max(1, Math.floor(maxDepth));
	}

	maxQueueDepth(): number {
		return this.maxDepth;
	}

	enqueue<T>(browserSessionId: string, tabId: number, run: () => Promise<T>): Promise<T> {
		const key = this.key(browserSessionId, tabId);
		const currentDepth = this.depths.get(key) || 0;
		if (currentDepth >= this.maxDepth) {
			return Promise.reject(new BrowserBridgeError("QUEUE_FULL", "Browser command queue is full", { browserSessionId, tabId, depth: currentDepth, maxDepth: this.maxDepth }));
		}
		this.depths.set(key, currentDepth + 1);
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

	depth(browserSessionId: string, tabId: number): number {
		return this.depths.get(this.key(browserSessionId, tabId)) || 0;
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
