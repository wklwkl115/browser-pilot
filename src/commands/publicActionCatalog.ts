import type { BrowserCommandDefinition, CommandOwnedActionMetadata } from "./commandDefinition.js";
import { nativeToolMetadata } from "./nativeActionMetadata.js";

type GeneratedActionMetadata = {
	action: string;
	command: string;
	required?: readonly string[];
	requiredAny?: readonly (readonly string[])[];
	notes?: string;
	paramsSchema?: Record<string, unknown>;
};

const INTERNAL_NATIVE_ACTIONS = new Set(["browser_network:wait"]);

export type PublicCommandActionMetadata = {
	commandName: string;
	action: string;
	cliAction: string;
	owner: "native-schema" | "command";
	schemaRef: string;
	required: readonly string[];
	requiredAny: readonly (readonly string[])[];
	paramsSchema: Record<string, unknown>;
	/** Informational only; deliberately excluded by contract serialization. */
	notes?: string;
};

export function kebabCaseAction(action: string): string {
	return action.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`).replace(/_/g, "-").toLowerCase();
}

function generatedActions(commandName: string): GeneratedActionMetadata[] {
	const tools = nativeToolMetadata.nativeActionTools as unknown as Record<string, { actions?: readonly GeneratedActionMetadata[] }>;
	return [...(tools[commandName]?.actions ?? [])].filter((action) => !INTERNAL_NATIVE_ACTIONS.has(`${commandName}:${action.action}`));
}

function commandOwnedAction(commandName: string, metadata: CommandOwnedActionMetadata): PublicCommandActionMetadata {
	return {
		commandName,
		action: metadata.action,
		cliAction: metadata.cliAction ?? kebabCaseAction(metadata.action),
		owner: "command",
		schemaRef: metadata.schemaRef,
		required: [...(metadata.required ?? [])],
		requiredAny: (metadata.requiredAny ?? []).map((group) => [...group]),
		paramsSchema: structuredClone(metadata.paramsSchema),
	};
}

export function publicActionsForDefinition(definition: Pick<BrowserCommandDefinition, "name" | "actionMetadata">): PublicCommandActionMetadata[] {
	const native = generatedActions(definition.name).map((metadata): PublicCommandActionMetadata => ({
		commandName: definition.name,
		action: metadata.action,
		cliAction: kebabCaseAction(metadata.action),
		owner: "native-schema",
		schemaRef: metadata.command,
		required: [...(metadata.required ?? [])],
		requiredAny: (metadata.requiredAny ?? []).map((group) => [...group]),
		paramsSchema: structuredClone(metadata.paramsSchema ?? { type: "object", properties: {}, additionalProperties: false }),
		...(metadata.notes ? { notes: metadata.notes } : {}),
	}));
	const commandOwned = (definition.actionMetadata ?? []).map((metadata) => commandOwnedAction(definition.name, metadata));
	const actions = [...native, ...commandOwned].sort((left, right) => left.cliAction.localeCompare(right.cliAction) || left.action.localeCompare(right.action));
	const rawOwners = new Map<string, PublicCommandActionMetadata>();
	const cliOwners = new Map<string, PublicCommandActionMetadata>();
	for (const action of actions) {
		const rawPrior = rawOwners.get(action.action);
		if (rawPrior) throw new Error(`Duplicate action owner for ${definition.name}:${action.action} (${rawPrior.owner}, ${action.owner})`);
		rawOwners.set(action.action, action);
		const cliPrior = cliOwners.get(action.cliAction);
		if (cliPrior) throw new Error(`Duplicate CLI action owner for ${definition.name}:${action.cliAction} (${cliPrior.action}, ${action.action})`);
		cliOwners.set(action.cliAction, action);
	}
	return actions;
}

export function publicCommandActionCatalog(definitions: readonly Pick<BrowserCommandDefinition, "name" | "actionMetadata">[]): PublicCommandActionMetadata[] {
	return definitions
		.flatMap((definition) => publicActionsForDefinition(definition))
		.sort((left, right) => left.commandName.localeCompare(right.commandName) || left.cliAction.localeCompare(right.cliAction));
}

export function contractActionMetadata(definitions: readonly Pick<BrowserCommandDefinition, "name" | "actionMetadata">[]): Array<Record<string, unknown>> {
	return publicCommandActionCatalog(definitions).map((action) => ({
		commandName: action.commandName,
		action: action.action,
		cliAction: action.cliAction,
		owner: action.owner,
		schemaRef: action.schemaRef,
		required: [...action.required],
		requiredAny: action.requiredAny.map((group) => [...group]),
		paramsSchema: structuredClone(action.paramsSchema),
	}));
}
