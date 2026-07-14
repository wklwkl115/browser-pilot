import { AsyncLocalStorage } from "node:async_hooks";
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

type BrowserCommandTransactionContext = {
	token: symbol;
	leaseGeneration: number;
	ownedKey: string;
};

export class BrowserCommandQueueRegistry {
	private readonly queues = new Map<string, Promise<unknown>>();
	private readonly depths = new Map<string, number>();
	private readonly aliases = new Map<string, string>();
	private readonly displayKeys = new Map<string, string>();
	private readonly transactionContext = new AsyncLocalStorage<BrowserCommandTransactionContext>();
	private readonly activeTransactionLeases = new Map<symbol, number>();
	private nextTransactionLeaseGeneration = 0;
	private readonly maxDepth: number;

	constructor(maxDepth = DEFAULT_MAX_QUEUE_DEPTH) {
		this.maxDepth = Math.max(1, Math.floor(maxDepth));
	}

	maxQueueDepth(): number {
		return this.maxDepth;
	}

	async withTransaction<T>(browserSessionId: string, tabId: number, run: () => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
		const activeContext = this.currentActiveTransactionContext();
		const requestedKey = this.resolveKey(this.key(browserSessionId, tabId));
		if (activeContext) {
			if (activeContext.ownedKey !== requestedKey) throw this.targetTransactionConflict(activeContext, browserSessionId, tabId);
			if (options.signal?.aborted) throw this.cancelledBeforeDispatch(browserSessionId, tabId);
			return await run();
		}
		return await this.enqueue(browserSessionId, tabId, async () => {
			const token = Symbol("browser-command-transaction");
			const leaseGeneration = ++this.nextTransactionLeaseGeneration;
			const context = { token, leaseGeneration, ownedKey: this.resolveKey(requestedKey) };
			this.activeTransactionLeases.set(token, leaseGeneration);
			try {
				return await this.transactionContext.run(context, run);
			} finally {
				if (this.activeTransactionLeases.get(token) === leaseGeneration) this.activeTransactionLeases.delete(token);
			}
		}, options);
	}

	ownsCurrentTransaction(browserSessionId: string, tabId: number): boolean {
		const context = this.currentActiveTransactionContext();
		return context?.ownedKey === this.resolveKey(this.key(browserSessionId, tabId));
	}

	enqueue<T>(browserSessionId: string, tabId: number, run: () => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> & { queuePressure?: BrowserCommandQueuePressure } {
		const key = this.resolveKey(this.key(browserSessionId, tabId));
		const activeContext = this.currentActiveTransactionContext();
		if (activeContext && activeContext.ownedKey !== key) throw this.targetTransactionConflict(activeContext, browserSessionId, tabId);
		const currentDepth = this.depths.get(key) || 0;
		if (currentDepth >= this.maxDepth) {
			return Promise.reject(new BrowserBridgeError("QUEUE_FULL", "Browser command queue is full", { browserSessionId, tabId, depth: currentDepth, maxDepth: this.maxDepth }));
		}
		const newDepth = currentDepth + 1;
		this.depths.set(key, newDepth);
		const previous = this.queues.get(key) || Promise.resolve();
		let started = false;
		let settled = false;
		let depthReleased = false;
		let resolveResult!: (value: T) => void;
		let rejectResult!: (error: unknown) => void;
		const resultPromise = new Promise<T>((resolve, reject) => {
			resolveResult = resolve;
			rejectResult = reject;
		});
		const releaseDepth = () => {
			if (depthReleased) return;
			depthReleased = true;
			const depth = Math.max(0, (this.depths.get(key) || 1) - 1);
			if (depth === 0) {
				this.depths.delete(key);
				this.displayKeys.delete(key);
				for (const [alias, target] of Array.from(this.aliases.entries())) if (target === key) this.aliases.delete(alias);
			} else this.depths.set(key, depth);
		};
		const abortBeforeDispatch = () => {
			if (settled || started) return;
			settled = true;
			releaseDepth();
			rejectResult(this.cancelledBeforeDispatch(browserSessionId, tabId));
		};
		options.signal?.addEventListener("abort", abortBeforeDispatch, { once: true });
		if (options.signal?.aborted) abortBeforeDispatch();
		const next = previous.catch(() => undefined).then(async () => {
			if (options.signal?.aborted) {
				abortBeforeDispatch();
				return undefined as T;
			}
			started = true;
			try {
				const value = await run();
				if (!settled) {
					settled = true;
					resolveResult(value);
				}
				return value;
			} catch (error) {
				if (!settled) {
					settled = true;
					rejectResult(error);
				}
				throw error;
			}
		}).finally(() => {
			options.signal?.removeEventListener("abort", abortBeforeDispatch);
			releaseDepth();
			if (this.queues.get(key) === stored) this.queues.delete(key);
		});
		const stored = next.catch(() => undefined);
		this.queues.set(key, stored);
		const result: Promise<T> & { queuePressure?: BrowserCommandQueuePressure } = resultPromise;
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
		this.activeTransactionLeases.clear();
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

	private currentActiveTransactionContext(): BrowserCommandTransactionContext | undefined {
		const context = this.transactionContext.getStore();
		if (!context) return undefined;
		return this.activeTransactionLeases.get(context.token) === context.leaseGeneration ? context : undefined;
	}

	private targetTransactionConflict(context: BrowserCommandTransactionContext, browserSessionId: string, tabId: number): BrowserBridgeError {
		return new BrowserBridgeError("TAB_LEASE_CONFLICT", "An active target transaction cannot acquire a different target", {
			browserSessionId,
			tabId,
			requestedQueueKey: this.resolveKey(this.key(browserSessionId, tabId)),
			ownedQueueKey: context.ownedKey,
			acked: false,
			dispatchStarted: false,
			invariant: "single_target_transaction",
		});
	}

	private cancelledBeforeDispatch(browserSessionId: string, tabId: number): BrowserBridgeError {
		return new BrowserBridgeError("BRIDGE_TIMEOUT", "Browser command was cancelled while waiting in the tab queue", {
			browserSessionId,
			tabId,
			acked: false,
			dispatchStarted: false,
			aborted: true,
		});
	}
}
