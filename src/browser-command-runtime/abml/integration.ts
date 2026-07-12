import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import type { EntityDiff, EntityDiffOptions } from "../../kernels/abml/diff.js";
import { createBrowserAbmlRuntime, type BrowserAbmlRuntimeOptions } from "../../browser-runtime/abml/runtime.js";
import { buildNativeEntityDiff } from "../../native/browserPilotNativeKernels.js";
import type { PageWorldScanBundleV1 } from "../../kernels/abml/pageWorldScan.js";

export function createBrowserAbmlIntegration(server: Pick<BrowserCommandRuntimePort, "sendCommand" | "snapshot" | "createObservationSnapshot">, options: BrowserAbmlRuntimeOptions = {}) {
	const runtime = createBrowserAbmlRuntime(server, options);
	return {
		runtime,
		readStructure: async (input: { ref?: string; browserSessionId?: string; tabId?: number | string; timeoutMs?: number; maxChars?: number; baseline?: import("../../kernels/abml/entity.js").Entity[]; diffOptions?: EntityDiffOptions; prefetchedScan?: PageWorldScanBundleV1; axCacheKey?: string }) => {
			const result = await runtime.read?.({ ref: input.ref, plane: "structure", baseline: input.baseline, diffOptions: input.diffOptions, prefetchedScan: input.prefetchedScan, axCacheKey: input.axCacheKey });
			if (!result?.ok || !input.baseline || !result.entities) return result;
			const nativeDiff: EntityDiff | undefined = buildNativeEntityDiff(input.baseline, result.entities, input.diffOptions);
			return nativeDiff ? { ...result, diff: nativeDiff } : result;
		},
		// Arm (no ref) or drain (pass the prior call's captureRef as `ref`) the
		// network/event causal channel. Symmetric to readStructure; the tab/session is the runtime's bound options.
		readStream: async (input: { plane: "network" | "event"; ref?: string; filter?: Record<string, unknown> }) => {
			return await runtime.read?.({ ref: input.ref, plane: input.plane, filter: input.filter });
		},
	};
}
