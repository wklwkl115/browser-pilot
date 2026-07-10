import { summarizeGenericValue } from "./summaries/index.js";
import { isRecord } from "./summaries/common.js";
import { ensureBuiltinDistillers } from "./summaries/builtinDistillers.js";
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
		ensureBuiltinDistillers();
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
