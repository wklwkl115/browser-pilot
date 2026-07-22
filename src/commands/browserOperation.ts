import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";
import { BrowserBridgeError } from "../utils/errors.js";

type BrowserOperationOptions = {
	server: BrowserCommandRuntimePort;
	browserSessionId?: string;
	tabId?: number;
	timeoutMs: number;
	signal?: AbortSignal;
};

export type BrowserOperationDispatchContext = {
	signal: AbortSignal;
	deadlineAt: number;
};

export async function withBrowserOperation<T>(
	options: BrowserOperationOptions,
	dispatch: (context: BrowserOperationDispatchContext) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const deadlineAt = Date.now() + options.timeoutMs;
	const abortFromCaller = () => controller.abort(options.signal?.reason ?? new BrowserBridgeError("BRIDGE_TIMEOUT", "Browser operation was cancelled", { aborted: true }));
	const timer = setTimeout(() => controller.abort(new BrowserBridgeError("BRIDGE_TIMEOUT", `Browser operation exceeded ${options.timeoutMs}ms`, {
		timeoutMs: options.timeoutMs,
		aborted: true,
	})), options.timeoutMs);
	if (options.signal?.aborted) abortFromCaller();
	else options.signal?.addEventListener("abort", abortFromCaller, { once: true });

	const run = () => dispatch({ signal: controller.signal, deadlineAt });
	try {
		return options.server.withTargetTransaction && options.tabId !== undefined
			? await options.server.withTargetTransaction({ browserSessionId: options.browserSessionId, tabId: options.tabId, signal: controller.signal }, run)
			: await run();
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abortFromCaller);
	}
}
