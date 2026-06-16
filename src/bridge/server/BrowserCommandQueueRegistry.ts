import { BrowserBridgeError } from "../../utils/errors.js";

const DEFAULT_MAX_QUEUE_DEPTH = 64;
const WARNING_DEPTH_RATIO = 0.75;

export type BrowserCommandQueuePressure = {
	depth: number;
	maxDepth: number;
	warningThreshold: true;
};

export type BrowserCommandQueueStatus = {
	depth: number;
	maxDepth: number;
	pressure: number;
};

export type BrowserCommandQueueInfo = {
	key: string;
	browserSessionId: string;
	tabId: number;
	depth: number;
};

export class BrowserCommandQueueRegistry {
	private readonly queues = new Map<string, Promise<unknown>>();
	private readonly depths = new Map<string, number>();
	private readonly aliases = new Map<string, string>();
	private readonly displayKeys = new Map<string, string>();
	private readonly maxDepth: number;

	constructor(maxDepth = DEFAULT_MAX_QUEUE_DEPTH) {
		this.maxDepth = Math.max(1, Math.floor(maxDepth));
	}

	maxQueueDepth(): number {
		return this.maxDepth;
	}

	enqueue<T>(browserSessionId: string, tabId: number, run: () => Promise<T>): Promise<T> & { queuePressure?: BrowserCommandQueuePressure } {
		const key = this.resolveKey(this.key(browserSessionId, tabId));
		const currentDepth = this.depths.get(key) || 0;
		if (currentDepth >= this.maxDepth) {
			return Promise.reject(new BrowserBridgeError("QUEUE_FULL", "Browser command queue is full", { browserSessionId, tabId, depth: currentDepth, maxDepth: this.maxDepth }));
		}
		const newDepth = currentDepth + 1;
		this.depths.set(key, newDepth);
		const previous = this.queues.get(key) || Promise.resolve();
		const next = previous.catch(() => undefined).then(run).finally(() => {
			const depth = Math.max(0, (this.depths.get(key) || 1) - 1);
			if (depth === 0) {
				this.depths.delete(key);
				this.displayKeys.delete(key);
				for (const [alias, target] of Array.from(this.aliases.entries())) if (target === key) this.aliases.delete(alias);
			} else this.depths.set(key, depth);
			if (this.queues.get(key) === stored) this.queues.delete(key);
		});
		const stored = next.catch(() => undefined);
		this.queues.set(key, stored);
		const result: Promise<T> & { queuePressure?: BrowserCommandQueuePressure } = next;
		if (newDepth >= WARNING_DEPTH_RATIO * this.maxDepth) {
			result.queuePressure = { depth: newDepth, maxDepth: this.maxDepth, warningThreshold: true };
		}
		return result;
	}

	depth(browserSessionId: string, tabId: number): number {
		return this.depths.get(this.resolveKey(this.key(browserSessionId, tabId))) || 0;
	}

	status(browserSessionId: string, tabId: number): BrowserCommandQueueStatus {
		const depth = this.depth(browserSessionId, tabId);
		return { depth, maxDepth: this.maxDepth, pressure: depth / this.maxDepth };
	}

	migrateTabQueue(browserSessionId: string, fromTabId: number, toTabId: number): BrowserCommandQueueInfo | undefined {
		if (!Number.isInteger(fromTabId) || !Number.isInteger(toTabId) || fromTabId === toTabId) return undefined;
		const fromKey = this.resolveKey(this.key(browserSessionId, fromTabId));
		if (!this.depths.has(fromKey)) return undefined;
		const toKey = this.key(browserSessionId, toTabId);
		this.aliases.set(toKey, fromKey);
		this.displayKeys.set(fromKey, toKey);
		const depth = this.depths.get(fromKey) || 0;
		return this.infoFromKey(toKey, depth);
	}

	snapshot(): BrowserCommandQueueInfo[] {
		return Array.from(this.depths.entries()).map(([key, depth]) => {
			return this.infoFromKey(this.displayKeys.get(key) ?? key, depth);
		}).sort((a, b) => a.key.localeCompare(b.key));
	}

	clear(): void {
		this.queues.clear();
		this.depths.clear();
		this.aliases.clear();
		this.displayKeys.clear();
	}

	private key(browserSessionId: string, tabId: number): string {
		return `${browserSessionId}:${tabId}`;
	}

	private resolveKey(key: string): string {
		let current = key;
		for (let hops = 0; hops < 4; hops += 1) {
			const next = this.aliases.get(current);
			if (!next || next === current) return current;
			current = next;
		}
		return current;
	}

	private infoFromKey(key: string, depth: number): BrowserCommandQueueInfo {
		const [browserSessionId, tabIdRaw] = key.split(":", 2);
		return { key, browserSessionId, tabId: Number(tabIdRaw), depth };
	}
}
