import type { BrowserBridgeServer } from "../driver/BrowserBridgeServer.js";
import type { BrowserToolDefinition, BrowserToolHost } from "../frontend/toolHost.js";
import { isRecord } from "../utils/records.js";
import { withDeprecatedParamStrip } from "./prepareArguments.js";
import { extractToolRelevanceTerms } from "./relevanceTaps.js";

export function withRelevanceTraceTap(pi: BrowserToolHost, server: BrowserBridgeServer): BrowserToolHost {
	return {
		registerTool(definition: BrowserToolDefinition) {
			const preparedDefinition = withDeprecatedParamStrip(definition);
			pi.registerTool({
				...preparedDefinition,
				async execute(toolCallId, params, signal, onUpdate, ctx) {
					if (process.env.PI_BROWSER_RELEVANCE !== "0") {
						const terms = extractToolRelevanceTerms(preparedDefinition.name, params);
						if (terms.length) {
							const browserSessionId = isRecord(params) && typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
							server.recordPerceptionTraceTerms(browserSessionId, terms);
						}
					}
					return await preparedDefinition.execute(toolCallId, params, signal, onUpdate, ctx);
				},
			});
		},
	};
}
