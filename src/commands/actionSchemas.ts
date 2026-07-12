import type { BrowserCommandDefinition } from "./commandDefinition.js";
import { publicActionsForDefinition, type PublicCommandActionMetadata } from "./publicActionCatalog.js";
import { isRecord } from "../utils/records.js";
import { COMMAND_SCHEMA_V3 } from "./publicContractSchemas.js";

export { COMMAND_SCHEMA_V3 };

function cloneRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? structuredClone(value) : {};
}

function definitionProperties(definition: Pick<BrowserCommandDefinition, "parameters">): Record<string, unknown> {
	const root = isRecord(definition.parameters) ? definition.parameters : {};
	return isRecord(root.properties) ? root.properties : {};
}

function actionParamsSchema(action: PublicCommandActionMetadata): Record<string, unknown> {
	const schema = cloneRecord(action.paramsSchema);
	schema.type = "object";
	schema.properties = isRecord(schema.properties) ? schema.properties : {};
	schema.additionalProperties = false;
	if (action.required.length) schema.required = [...action.required];
	else delete schema.required;
	if (action.requiredAny.length) {
		schema.requiredAny = action.requiredAny.map((group) => [...group]);
		schema.anyOf = action.requiredAny.map((group) => ({ required: [...group] }));
	} else {
		delete schema.requiredAny;
		if (!Array.isArray(action.paramsSchema.anyOf)) delete schema.anyOf;
	}
	return schema;
}

function commonActionProperties(definition: BrowserCommandDefinition): Record<string, unknown> {
	return Object.fromEntries(Object.entries(definitionProperties(definition))
		.filter(([key]) => key !== "action" && key !== "params")
		.map(([key, schema]) => [key, structuredClone(schema)]));
}

export function actionSchemaForDefinition(definition: BrowserCommandDefinition, rawAction: string): Record<string, unknown> | undefined {
	const action = publicActionsForDefinition(definition).find((candidate) => candidate.action === rawAction);
	if (!action) return undefined;
	const params = actionParamsSchema(action);
	const paramsRequired = action.required.length > 0 || action.requiredAny.length > 0;
	return {
		type: "object",
		properties: {
			action: { const: action.action },
			params,
			...commonActionProperties(definition),
		},
		required: ["action", ...(paramsRequired ? ["params"] : [])],
		additionalProperties: false,
	};
}

/**
 * Compact command-level schema for action tools. It advertises canonical raw
 * actions and stable schema references without embedding every action schema.
 */
export function commandParametersForSchema(definition: BrowserCommandDefinition): Record<string, unknown> {
	const actions = publicActionsForDefinition(definition);
	if (!actions.length) return cloneRecord(definition.parameters);
	const root = isRecord(definition.parameters) ? definition.parameters : {};
	return {
		type: "object",
		properties: {
			action: {
				oneOf: actions.map((action) => ({ const: action.action, schemaRef: action.schemaRef })),
			},
			params: {
				type: "object",
				actionSchemaRefs: actions.map((action) => ({ action: action.action, schemaRef: action.schemaRef })),
			},
			...commonActionProperties(definition),
		},
		required: ["action"],
		additionalProperties: false,
		...(typeof root.description === "string" ? { description: root.description } : {}),
	};
}

export function publicActionSchemaMetadata(definition: BrowserCommandDefinition, rawAction: string) {
	const action = publicActionsForDefinition(definition).find((candidate) => candidate.action === rawAction);
	if (!action) return undefined;
	const parameters = actionSchemaForDefinition(definition, rawAction);
	if (!parameters) return undefined;
	return { action, parameters };
}
