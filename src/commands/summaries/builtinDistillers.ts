import { jsonCost } from "../../kernels/evidence/distill/cost.js";
import { compactEntityRenderingValue, lineEncodeEntity } from "../../kernels/evidence/distill/granularity.js";
import { registerCommandDistiller, registerDistillerDefinition, unwrapDistillData, type Distiller } from "../distillerRegistry.js";
import type { CommandFact } from "../resultTypes.js";
import { summarizeDomFlowData, summarizeEvidenceData, summarizeGenericValue, summarizeHookCollectData, summarizeHookPerformance, summarizeMemoryResult, summarizeNetworkData, summarizeWsSessionData } from "./index.js";
import { EvidenceSummarySchema, HookDomFlowSummarySchema, MemorySummarySchema, NetworkSummarySchema } from "./outputSchemas.js";
import { mintRef } from "../../kernels/refs/core.js";

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

function summaryFact(ref: string, plane: CommandFact["plane"], value: Record<string, unknown>, salience: CommandFact["salience"]): CommandFact {
	const compact = plane === "entity" ? compactEntityRenderingValue(value) : { ...value };
	const line = lineEncodeEntity(compact) || `${plane}:${ref}`;
	return {
		ref,
		plane,
		salience,
		renderings: {
			full: { value, cost: jsonCost(value) },
			compact: { value: compact, cost: jsonCost(compact) },
			line: { text: line, cost: line.length },
			ref: { text: ref, cost: ref.length },
		},
	};
}

function factifySummary(commandName: string, value: unknown, command: string | undefined, distiller: Distiller, salience: CommandFact["salience"]): CommandFact[] {
	const commandId = String(command || "default").replace(/[^a-z0-9._-]+/gi, "-");
	return [summaryFact(mintRef("summary", `${commandName}/${commandId}`), "summary", distiller(value, command), salience)];
}

export function ensureBuiltinDistillers(): void {
	if (builtinDistillersRegistered) return;
	builtinDistillersRegistered = true;

	// Register with summarySchema for structured-result conformance.
	registerDistillerDefinition({
		commandName: "browser_evidence",
		summarySchema: EvidenceSummarySchema,
		distill: evidenceDistiller,
		factify: (value, command) => factifySummary("browser_evidence", unwrapDistillData(value), command, evidenceDistiller, { consequence: 120, structure: 80 }),
	});
	registerDistillerDefinition({
		commandName: "browser_network",
		summarySchema: NetworkSummarySchema,
		distill: networkDistiller,
		factify: (value, command) => factifySummary("browser_network", unwrapDistillData(value), command, networkDistiller, { consequence: 220 }),
	});
	registerDistillerDefinition({
		commandName: "browser_hook",
		summarySchema: HookDomFlowSummarySchema,
		distill: hookToolDistiller,
		factify: (value, command) => factifySummary("browser_hook", value, command, hookToolDistiller, { consequence: 160, actionability: 40 }),
	});
	registerDistillerDefinition({
		commandName: "browser_memory",
		summarySchema: MemorySummarySchema,
		distill: memoryDistiller,
		factify: (value, command) => factifySummary("browser_memory", unwrapDistillData(value), command, memoryDistiller, { structure: 160 }),
	});

	// Remaining command distillers emit summaries without a registered schema.
	registerCommandDistiller("evidence.collect", (command) => command === "evidence.collect", evidenceDistiller);
	registerCommandDistiller("network.*", (command) => command.startsWith("network."), networkDistiller);
	registerCommandDistiller("hook.dom-flow", (command) => DOM_FLOW_COMMANDS.has(command), domFlowDistiller);
	registerCommandDistiller("ws.*", (command) => command.startsWith("ws."), wsDistiller);
}
