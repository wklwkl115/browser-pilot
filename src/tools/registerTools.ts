import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BrowserBridgeServer } from "../driver/BrowserBridgeServer.js";
import { ensureBuiltinDistillersRegistered } from "./distillerRegistry.js";
import { withDeprecatedParamStrip } from "./prepareArguments.js";
import { resolveBrowserToolRegistrars } from "./toolRegistry.js";
import type { EnsureStarted, MemoryResultResourceResolver, ToolRegistrarContext } from "./toolShared.js";

export function registerBrowserTools(_pi: ExtensionAPI, _server: BrowserBridgeServer, ensureStarted: EnsureStarted, options: { memoryEvidenceResolver?: MemoryResultResourceResolver } = {}) {
	ensureBuiltinDistillersRegistered();
	const pi: ExtensionAPI = {
		..._pi,
		registerTool(definition) {
			_pi.registerTool(withDeprecatedParamStrip(definition));
		},
	};
	const context: ToolRegistrarContext = { pi, ensureStarted, memoryEvidenceResolver: options.memoryEvidenceResolver };
	for (const registerTool of resolveBrowserToolRegistrars()) registerTool(context);
}
