import type { BrowserBridgeServer } from "../../driver/BrowserBridgeServer.js";
import { createBrowserAbmlRuntime, type BrowserAbmlRuntimeOptions } from "./runtime.js";

export function createBrowserAbmlIntegration(server: Pick<BrowserBridgeServer, "sendCommand" | "snapshot" | "createObservationSnapshot">, options: BrowserAbmlRuntimeOptions = {}) {
	const runtime = createBrowserAbmlRuntime(server, options);
	return {
		runtime,
		readStructure: async (input: { ref?: string; browserSessionId?: string; tabId?: number | string; timeoutMs?: number; maxChars?: number; baseline?: import("../entity.js").Entity[] }) => {
			return await runtime.read?.({ ref: input.ref, plane: "structure", baseline: input.baseline });
		},
	};
}
