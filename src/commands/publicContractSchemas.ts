export const COMMAND_CATALOG_SCHEMA_V3 = "browser-pilot-command-catalog/v3" as const;
export const COMMAND_SCHEMA_V3 = "browser-pilot-command-schema/v3" as const;

export const COMMAND_CATALOG_V3_JSON_SCHEMA = {
	$id: COMMAND_CATALOG_SCHEMA_V3,
	type: "object",
	properties: {
		schema: { const: COMMAND_CATALOG_SCHEMA_V3 },
		contract: { type: "object", required: ["version", "hash", "toolCount"], additionalProperties: false },
		artifact: { type: "object", required: ["resultField", "inspectArgv"], additionalProperties: false },
		commands: { type: "array" },
	},
	required: ["schema", "contract", "artifact", "commands"],
	additionalProperties: false,
} as const;

export const COMMAND_SCHEMA_V3_JSON_SCHEMA = {
	$id: COMMAND_SCHEMA_V3,
	type: "object",
	properties: {
		schema: { const: COMMAND_SCHEMA_V3 },
		contract: { type: "object", required: ["version", "hash"], additionalProperties: false },
		command: { type: "object", required: ["cli", "tool"], additionalProperties: false },
		action: { type: "object", required: ["cli", "raw", "owner", "schemaRef"], additionalProperties: false },
		parameters: { type: "object" },
	},
	required: ["schema", "contract", "command", "parameters"],
	additionalProperties: false,
} as const;
