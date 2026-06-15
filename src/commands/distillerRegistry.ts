import { summarizeGenericValue } from "./summaries/index.js";
import { isRecord } from "./summaries/common.js";
import { ensureBuiltinDistillers } from "./summaries/builtinDistillers.js";
import type { TSchema } from "typebox";
import type { Fact } from "../kernels/evidence/distill/fact.js";

export type Distiller = (value: unknown, command?: string) => Record<string, unknown>;
export type Factifier = (value: unknown, command?: string) => Fact[];

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

export function registerDistiller(commandName: string, distiller: Distiller): void {
	distillerRegistry.set(commandName, distiller);
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
	definitionRegistry.set(def.commandName, def);
	// Keep legacy registry in sync so distillValue() continues to work.
	distillerRegistry.set(def.commandName, def.distill);
}

/**
 * Retrieve the DistillerDefinition for a tool, if one was registered with
 * registerDistillerDefinition. Returns undefined for tools that only have a
 * legacy Distiller registered.
 */
export function getDistillerDefinition(commandName: string): DistillerDefinition | undefined {
	ensureBuiltinDistillersReady();
	return definitionRegistry.get(commandName);
}

/**
 * Return all command names that have a DistillerDefinition (with summarySchema).
 */
export function getDefinedDistillerToolNames(): string[] {
	ensureBuiltinDistillersReady();
	return Array.from(definitionRegistry.keys()).sort();
}

export function ensureBuiltinDistillersReady(): void {
	if (builtinRegistrationState !== "uninitialized") return;
	builtinRegistrationState = "registering";
	try {
		ensureBuiltinDistillers();
		builtinRegistrationState = "registered";
	} catch (error) {
		builtinRegistrationState = "uninitialized";
		throw error;
	}
}

function resolveDistiller(commandName: string, command?: string): Distiller | undefined {
	const byTool = distillerRegistry.get(commandName);
	if (byTool) return byTool;
	const cmd = String(command || "");
	for (const rule of commandDistillerRules) {
		if (rule.match(cmd)) return rule.distiller;
	}
	return undefined;
}

export function hasRegisteredDistiller(commandName: string, command?: string): boolean {
	ensureBuiltinDistillersReady();
	return !!resolveDistiller(commandName, command);
}

export function distillValue(commandName: string, command: string | undefined, value: unknown): Record<string, unknown> {
	ensureBuiltinDistillersReady();
	const distiller = resolveDistiller(commandName, command);
	return distiller ? distiller(value, command) : summarizeGenericValue(value);
}

export function getDistillerRegistrySnapshot(): { commandNames: string[]; commandRuleLabels: string[]; definitionToolNames: string[] } {
	ensureBuiltinDistillersReady();
	return {
		commandNames: Array.from(distillerRegistry.keys()).sort(),
		commandRuleLabels: commandDistillerRules.map((item) => item.label).sort(),
		definitionToolNames: Array.from(definitionRegistry.keys()).sort(),
	};
}
