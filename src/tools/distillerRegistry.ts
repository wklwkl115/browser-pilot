import { summarizeGenericValue } from "./summaries/index.js";
import { isRecord } from "./summaries/common.js";
import { registerBuiltinDistillers } from "./summaries/registerBuiltinDistillers.js";
import type { TSchema } from "typebox";

export type Distiller = (value: unknown, command?: string) => Record<string, unknown>;

/**
 * Extended distiller definition that pairs a distill function with an explicit
 * summarySchema. When registered via registerDistillerDefinition, the schema
 * is used as the MCP outputSchema for tools/list, and conformance tests
 * validate that real distill output passes the schema.
 *
 * summarySchema is the single source of truth for the structured output shape;
 * do NOT derive it from TypeScript return types.
 */
export type DistillerDefinition = {
	toolName: string;
	commandMatcher?: (command: string) => boolean;
	summarySchema: TSchema;
	distill: Distiller;
};

type CommandDistillerRule = {
	label: string;
	match: (command: string) => boolean;
	distiller: Distiller;
};

const distillerRegistry = new Map<string, Distiller>();
const commandDistillerRules: CommandDistillerRule[] = [];
const definitionRegistry = new Map<string, DistillerDefinition>();
let builtinRegistrationState: "uninitialized" | "registering" | "registered" = "uninitialized";

export function unwrapDistillData(value: unknown): unknown {
	return isRecord(value) && value.data !== undefined ? value.data : value;
}

export function registerDistiller(toolName: string, distiller: Distiller): void {
	distillerRegistry.set(toolName, distiller);
}

export function registerCommandDistiller(label: string, match: (command: string) => boolean, distiller: Distiller): void {
	const rule: CommandDistillerRule = { label, match, distiller };
	const existing = commandDistillerRules.findIndex((item) => item.label === label);
	if (existing >= 0) commandDistillerRules[existing] = rule;
	else commandDistillerRules.push(rule);
}

/**
 * Register a DistillerDefinition — a distiller paired with an explicit
 * summarySchema. Also registers the underlying distill function via the
 * legacy registry path so existing callers continue to work unchanged.
 */
export function registerDistillerDefinition(def: DistillerDefinition): void {
	definitionRegistry.set(def.toolName, def);
	// Keep legacy registry in sync so distillValue() continues to work.
	distillerRegistry.set(def.toolName, def.distill);
}

/**
 * Retrieve the DistillerDefinition for a tool, if one was registered with
 * registerDistillerDefinition. Returns undefined for tools that only have a
 * legacy Distiller registered.
 */
export function getDistillerDefinition(toolName: string): DistillerDefinition | undefined {
	ensureBuiltinDistillersRegistered();
	return definitionRegistry.get(toolName);
}

/**
 * Return all tool names that have a DistillerDefinition (with summarySchema).
 */
export function getDefinedDistillerToolNames(): string[] {
	ensureBuiltinDistillersRegistered();
	return Array.from(definitionRegistry.keys()).sort();
}

export function ensureBuiltinDistillersRegistered(): void {
	if (builtinRegistrationState !== "uninitialized") return;
	builtinRegistrationState = "registering";
	try {
		registerBuiltinDistillers();
		builtinRegistrationState = "registered";
	} catch (error) {
		builtinRegistrationState = "uninitialized";
		throw error;
	}
}

function resolveDistiller(toolName: string, command?: string): Distiller | undefined {
	const byTool = distillerRegistry.get(toolName);
	if (byTool) return byTool;
	const cmd = String(command || "");
	for (const rule of commandDistillerRules) {
		if (rule.match(cmd)) return rule.distiller;
	}
	return undefined;
}

export function hasRegisteredDistiller(toolName: string, command?: string): boolean {
	ensureBuiltinDistillersRegistered();
	return !!resolveDistiller(toolName, command);
}

export function distillValue(toolName: string, command: string | undefined, value: unknown): Record<string, unknown> {
	ensureBuiltinDistillersRegistered();
	const distiller = resolveDistiller(toolName, command);
	return distiller ? distiller(value, command) : summarizeGenericValue(value);
}

export function getDistillerRegistrySnapshot(): { toolNames: string[]; commandRuleLabels: string[]; definitionToolNames: string[] } {
	ensureBuiltinDistillersRegistered();
	return {
		toolNames: Array.from(distillerRegistry.keys()).sort(),
		commandRuleLabels: commandDistillerRules.map((item) => item.label).sort(),
		definitionToolNames: Array.from(definitionRegistry.keys()).sort(),
	};
}
