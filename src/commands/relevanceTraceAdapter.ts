import type { BrowserCommandRelevanceTracePort } from "../ports/BrowserCommandRuntimePort.js";
import type { BrowserCommandDefinition, BrowserCommandSink } from "./commandDefinition.js";
import { isRecord } from "../utils/records.js";
import { extractToolRelevanceTerms } from "./relevanceTaps.js";

export function withRelevanceTraceTap(delegate: BrowserCommandSink, server: BrowserCommandRelevanceTracePort): BrowserCommandSink {
	return {
		define(definition: BrowserCommandDefinition) {
			delegate.define({
				...definition,
				async execute(toolCallId, params, signal, onUpdate, ctx) {
					const terms = extractToolRelevanceTerms(definition.name, params);
					if (terms.length) {
						const browserSessionId = isRecord(params) && typeof params.browserSessionId === "string" ? params.browserSessionId : undefined;
						server.recordPerceptionTraceTerms?.(browserSessionId, terms);
					}
					return await definition.execute(toolCallId, params, signal, onUpdate, ctx);
				},
			});
		},
	};
}
