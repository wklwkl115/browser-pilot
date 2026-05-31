import { registerCommandDistiller, registerDistiller, unwrapDistillData, type Distiller } from "../distillerRegistry.js";
import { summarizeDomFlowData, summarizeEvidenceData, summarizeGenericValue, summarizeNetworkData, summarizeWsSessionData } from "./index.js";

const DOM_FLOW_COMMANDS = new Set(["hook.getNodeListeners", "hook.getListenerChain", "hook.getSinkHints"]);
let builtinDistillersRegistered = false;

function domFlowDistiller(value: unknown, command?: string): Record<string, unknown> {
	const cmd = String(command || "");
	return DOM_FLOW_COMMANDS.has(cmd) ? summarizeDomFlowData(cmd, value) : summarizeGenericValue(value);
}

const evidenceDistiller: Distiller = (value) => summarizeEvidenceData(unwrapDistillData(value));
const networkDistiller: Distiller = (value) => summarizeNetworkData(unwrapDistillData(value));
const wsDistiller: Distiller = (value, command) => summarizeWsSessionData(String(command || "ws"), unwrapDistillData(value));

export function registerBuiltinDistillers(): void {
	if (builtinDistillersRegistered) return;
	builtinDistillersRegistered = true;
	registerDistiller("browser_evidence", evidenceDistiller);
	registerCommandDistiller("evidence.collect", (command) => command === "evidence.collect", evidenceDistiller);
	registerDistiller("browser_network", networkDistiller);
	registerCommandDistiller("network.*", (command) => command.startsWith("network."), networkDistiller);
	registerDistiller("browser_hook", domFlowDistiller);
	registerCommandDistiller("hook.dom-flow", (command) => DOM_FLOW_COMMANDS.has(command), domFlowDistiller);
	registerCommandDistiller("ws.*", (command) => command.startsWith("ws."), wsDistiller);
}
