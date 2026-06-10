import type { BrowserBridgeServer } from "../../driver/BrowserBridgeServer.js";
import type { EntityDiffOptions } from "../diff.js";
import { createBrowserAbmlRuntime, type BrowserAbmlRuntimeOptions } from "./runtime.js";

export function createBrowserAbmlIntegration(server: Pick<BrowserBridgeServer, "sendCommand" | "snapshot" | "createObservationSnapshot">, options: BrowserAbmlRuntimeOptions = {}) {
	const runtime = createBrowserAbmlRuntime(server, options);
	return {
		runtime,
		readStructure: async (input: { ref?: string; browserSessionId?: string; tabId?: number | string; timeoutMs?: number; maxChars?: number; baseline?: import("../entity.js").Entity[]; diffOptions?: EntityDiffOptions; prefetchedScan?: Record<string, unknown>; axCacheKey?: string }) => {
			return await runtime.read?.({ ref: input.ref, plane: "structure", baseline: input.baseline, diffOptions: input.diffOptions, prefetchedScan: input.prefetchedScan, axCacheKey: input.axCacheKey });
		},
		// R3.x P2-C causal stream plane: arm (no ref) or drain (pass the prior call's captureRef as `ref`) the
		// network/event causal channel. Symmetric to readStructure; the tab/session is the runtime's bound options.
		readStream: async (input: { plane: "network" | "event"; ref?: string; filter?: Record<string, unknown> }) => {
			return await runtime.read?.({ ref: input.ref, plane: input.plane, filter: input.filter });
		},
	};
}
