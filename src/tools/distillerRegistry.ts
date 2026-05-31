import { summarizeGenericValue } from "./summaries/index.js";
import { isRecord } from "./summaries/common.js";
import { registerBuiltinDistillers } from "./summaries/registerBuiltinDistillers.js";

export type Distiller = (value: unknown, command?: string) => Record<string, unknown>;

type CommandDistillerRule = {
	label: string;
	match: (command: string) => boolean;
	distiller: Distiller;
};

const distillerRegistry = new Map<string, Distiller>();
const commandDistillerRules: CommandDistillerRule[] = [];
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

export function getDistillerRegistrySnapshot(): { toolNames: string[]; commandRuleLabels: string[] } {
	ensureBuiltinDistillersRegistered();
	return {
		toolNames: Array.from(distillerRegistry.keys()).sort(),
		commandRuleLabels: commandDistillerRules.map((item) => item.label).sort(),
	};
}
