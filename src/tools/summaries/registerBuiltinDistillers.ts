import { registerCommandDistiller, registerDistillerDefinition, unwrapDistillData, type Distiller } from "../distillerRegistry.js";
import { summarizeDomFlowData, summarizeEvidenceData, summarizeGenericValue, summarizeHookCollectData, summarizeHookPerformance, summarizeMemoryResult, summarizeNetworkData, summarizeWsSessionData } from "./index.js";
import { EvidenceSummarySchema, HookDomFlowSummarySchema, MemorySummarySchema, NetworkSummarySchema } from "./outputSchemas.js";

const DOM_FLOW_COMMANDS = new Set(["hook.getNodeListeners", "hook.getListenerChain", "hook.getSinkHints"]);
let builtinDistillersRegistered = false;

function domFlowDistiller(value: unknown, command?: string): Record<string, unknown> {
	const cmd = String(command || "");
	return DOM_FLOW_COMMANDS.has(cmd) ? summarizeDomFlowData(cmd, value) : summarizeGenericValue(value);
}

// The browser_hook tool distiller: dom-flow reads → domFlow; collect → its own events summarizer
// (H3 — surface event types/counts/sample + a data.events hint instead of generic collapse); else generic.
function hookToolDistiller(value: unknown, command?: string): Record<string, unknown> {
	const cmd = String(command || "");
	if (DOM_FLOW_COMMANDS.has(cmd)) return summarizeDomFlowData(cmd, value);
	if (cmd === "hook.collect") return summarizeHookCollectData(unwrapDistillData(value));
	if (cmd === "hook.getPerformanceEntries") return summarizeHookPerformance(unwrapDistillData(value));
	return summarizeGenericValue(value);
}

const evidenceDistiller: Distiller = (value) => summarizeEvidenceData(unwrapDistillData(value));
const networkDistiller: Distiller = (value) => summarizeNetworkData(unwrapDistillData(value));
const wsDistiller: Distiller = (value, command) => summarizeWsSessionData(String(command || "ws"), unwrapDistillData(value));
const memoryDistiller: Distiller = (value) => summarizeMemoryResult(unwrapDistillData(value));

export function registerBuiltinDistillers(): void {
	if (builtinDistillersRegistered) return;
	builtinDistillersRegistered = true;

	// Phase-2 spike: register with summarySchema for MCP outputSchema + conformance.
	// Legacy registerDistiller path is kept in sync inside registerDistillerDefinition.
	registerDistillerDefinition({
		toolName: "browser_evidence",
		summarySchema: EvidenceSummarySchema,
		distill: evidenceDistiller,
	});
	registerDistillerDefinition({
		toolName: "browser_network",
		summarySchema: NetworkSummarySchema,
		distill: networkDistiller,
	});
	registerDistillerDefinition({
		toolName: "browser_hook",
		summarySchema: HookDomFlowSummarySchema,
		distill: hookToolDistiller,
	});
	registerDistillerDefinition({
		toolName: "browser_memory",
		summarySchema: MemorySummarySchema,
		distill: memoryDistiller,
	});

	// Legacy command distillers (no schema — outside Phase-2 scope).
	registerCommandDistiller("evidence.collect", (command) => command === "evidence.collect", evidenceDistiller);
	registerCommandDistiller("network.*", (command) => command.startsWith("network."), networkDistiller);
	registerCommandDistiller("hook.dom-flow", (command) => DOM_FLOW_COMMANDS.has(command), domFlowDistiller);
	registerCommandDistiller("ws.*", (command) => command.startsWith("ws."), wsDistiller);
}
