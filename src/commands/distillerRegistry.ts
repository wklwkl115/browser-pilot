import { jsonCost } from "../kernels/evidence/cost.js";
import { compactEntityRenderingValue, lineEncodeEntity } from "../kernels/evidence/distill/granularity.js";
import { mintRef } from "../kernels/refs/core.js";
import { summarizeDomFlowData, summarizeEvidenceData, summarizeGenericValue, summarizeHookCollectData, summarizeHookPerformance, summarizeNetworkData, summarizeWsSessionData } from "./summaries/index.js";
import { isRecord } from "./summaries/common.js";
import { EvidenceSummarySchema, HookDomFlowSummarySchema, NetworkSummarySchema } from "./summaries/outputSchemas.js";
import type { TSchema } from "typebox";
import type { CommandFact } from "./resultTypes.js";

export type Distiller = (value: unknown, command?: string) => Record<string, unknown>;
export type Factifier = (value: unknown, command?: string) => CommandFact[];

/**
 * Extended distiller definition that pairs a distill function with an explicit
 * summarySchema. When registered via registerDistillerDefinition, the schema
 * declares the tool's structured summary shape, and conformance tests
 * validate that real distill output passes the schema.
 *
 * summarySchema is the single source of truth for the structured output shape;
 * do NOT derive it from TypeScript return types.
 */
export type DistillerDefinition = {
	commandName: string;
	commandMatcher?: (command: string) => boolean;
	summarySchema: TSchema;
	distill: Distiller;
	factify?: Factifier;
};

const DOM_FLOW_COMMANDS = new Set(["hook.getNodeListeners", "hook.getListenerChain", "hook.getSinkHints"]);

function domFlowDistiller(value: unknown, command?: string): Record<string, unknown> {
	const cmd = String(command || "");
	return DOM_FLOW_COMMANDS.has(cmd) ? summarizeDomFlowData(cmd, value) : summarizeGenericValue(value);
}

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
			line: { text: line, cost: jsonCost(line) },
			ref: { text: ref, cost: jsonCost(ref) },
		},
	};
}

function factifySummary(commandName: string, value: unknown, command: string | undefined, distiller: Distiller, salience: CommandFact["salience"]): CommandFact[] {
	const commandId = String(command || "default").replace(/[^a-z0-9._-]+/gi, "-");
	return [summaryFact(mintRef("summary", `${commandName}/${commandId}`), "summary", distiller(value, command), salience)];
}

type CommandDistillerRule = {
	label: string;
	match: (command: string) => boolean;
	distiller: Distiller;
};

const commandDistillerRules: CommandDistillerRule[] = [];
const definitionRegistry = new Map<string, DistillerDefinition>();
let builtinRegistrationState: "uninitialized" | "registering" | "registered" = "uninitialized";

export function unwrapDistillData(value: unknown): unknown {
	return isRecord(value) && value.data !== undefined ? value.data : value;
}

export function registerCommandDistiller(label: string, match: (command: string) => boolean, distiller: Distiller): void {
	const rule: CommandDistillerRule = { label, match, distiller };
	const existing = commandDistillerRules.findIndex((item) => item.label === label);
	if (existing >= 0) commandDistillerRules[existing] = rule;
	else commandDistillerRules.push(rule);
}

export function registerDistillerDefinition(def: DistillerDefinition): void {
	definitionRegistry.set(def.commandName, def);
}

export function getDistillerDefinition(commandName: string): DistillerDefinition | undefined {
	ensureBuiltinDistillersReady();
	return definitionRegistry.get(commandName);
}

export function ensureBuiltinDistillersReady(): void {
	if (builtinRegistrationState !== "uninitialized") return;
	builtinRegistrationState = "registering";
	try {
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
		registerCommandDistiller("evidence.collect", (command) => command === "evidence.collect", evidenceDistiller);
		registerCommandDistiller("network.*", (command) => command.startsWith("network."), networkDistiller);
		registerCommandDistiller("hook.dom-flow", (command) => DOM_FLOW_COMMANDS.has(command), domFlowDistiller);
		registerCommandDistiller("ws.*", (command) => command.startsWith("ws."), wsDistiller);
		builtinRegistrationState = "registered";
	} catch (error) {
		builtinRegistrationState = "uninitialized";
		throw error;
	}
}

function resolveDistiller(commandName: string, command?: string): Distiller | undefined {
	const byTool = definitionRegistry.get(commandName)?.distill;
	if (byTool) return byTool;
	const cmd = String(command || "");
	for (const rule of commandDistillerRules) {
		if (rule.match(cmd)) return rule.distiller;
	}
	return undefined;
}

export function distillValue(commandName: string, command: string | undefined, value: unknown): Record<string, unknown> {
	ensureBuiltinDistillersReady();
	const distiller = resolveDistiller(commandName, command);
	return distiller ? distiller(value, command) : summarizeGenericValue(value);
}
