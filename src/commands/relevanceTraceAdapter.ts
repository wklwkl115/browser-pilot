import type { BrowserBridgeServer } from "../bridge/server/BrowserBridgeServer.js";
import type { BrowserCommandDefinition, BrowserCommandSink } from "./commandDefinition.js";
import { isRecord } from "../utils/records.js";
import { withDeprecatedParamStrip } from "./prepareArguments.js";
import { extractToolRelevanceTerms } from "./relevanceTaps.js";

export function withRelevanceTraceTap(delegate: BrowserCommandSink, server: BrowserBridgeServer): BrowserCommandSink {
	return {
		define(definition: BrowserCommandDefinition) {
			const preparedDefinition = withDeprecatedParamStrip(definition);
			delegate.define({
				...preparedDefinition,
				async execute(toolCallId, params, signal, onUpdate, ctx) {
					if (process.env.BROWSER_PILOT_RELEVANCE !== "0") {
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
