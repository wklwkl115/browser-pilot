import type { CliCommand } from "./registry.js";
import { commandGroup } from "./commandMetadata.js";
import { localDaemonContractIdentity } from "../daemon/contractIdentity.js";
import { publicActionsForDefinition } from "../../commands/publicActionCatalog.js";
import { actionSchemaForDefinition, commandParametersForSchema } from "../../commands/actionSchemas.js";
import { COMMAND_CATALOG_SCHEMA_V3, COMMAND_SCHEMA_V3 } from "../../commands/publicContractSchemas.js";

export const COMMAND_CATALOG_V3 = COMMAND_CATALOG_SCHEMA_V3;

/** Public catalog tool count after agent façade GA (core 12 + security 7 + view/act/read). */
export const PUBLIC_CATALOG_TOOL_COUNT = 22 as const;

export interface CommandCatalogV3 {
	schema: typeof COMMAND_CATALOG_V3;
	contract: { version: 3; hash: string; toolCount: typeof PUBLIC_CATALOG_TOOL_COUNT };
	artifact: {
		resultField: "saved.path";
		inspectArgv: ["browser-pilot", "artifact", "--mode", "inspect", "--path", "<saved.path>", "--json"];
	};
	commands: Array<{
		cli: string;
		tool: `browser_${string}`;
		group: string;
		summary: string;
		schemaArgv: string[];
		actions?: Array<{ cli: string; raw: string; schemaRef: string; schemaArgv: string[] }>;
	}>;
}

export function buildCommandCatalogV3(commands: readonly CliCommand[]): CommandCatalogV3 {
	const identity = localDaemonContractIdentity();
	if (identity.toolCount !== PUBLIC_CATALOG_TOOL_COUNT || commands.length !== PUBLIC_CATALOG_TOOL_COUNT) {
		throw new Error(`command catalog v3 requires exactly ${PUBLIC_CATALOG_TOOL_COUNT} tools; found identity=${identity.toolCount}, registry=${commands.length}`);
	}
	return {
		schema: COMMAND_CATALOG_V3,
		contract: { version: 3, hash: identity.commandContractHash, toolCount: PUBLIC_CATALOG_TOOL_COUNT },
		artifact: {
			resultField: "saved.path",
			inspectArgv: ["browser-pilot", "artifact", "--mode", "inspect", "--path", "<saved.path>", "--json"],
		},
		commands: commands.map((command) => {
			const actions = publicActionsForDefinition(command.def);
			return {
				cli: command.subcommand,
				tool: command.name as `browser_${string}`,
				group: commandGroup(command),
				summary: command.description ?? command.def.label ?? command.name,
				schemaArgv: ["browser-pilot", "schema", command.subcommand, "--json"],
				...(actions.length ? {
					actions: actions.map((action) => ({
						cli: action.cliAction,
						raw: action.action,
						schemaRef: action.schemaRef,
						schemaArgv: ["browser-pilot", "schema", command.subcommand, action.cliAction, "--json"],
					})),
				} : {}),
			};
		}),
	};
}

export function buildCommandSchemaV3(command: CliCommand, rawAction?: string): Record<string, unknown> {
	const identity = localDaemonContractIdentity();
	const action = rawAction ? publicActionsForDefinition(command.def).find((candidate) => candidate.action === rawAction) : undefined;
	const parameters = action ? actionSchemaForDefinition(command.def, action.action) : commandParametersForSchema(command.def);
	if (!parameters) throw new Error(`missing action schema for ${command.name}:${rawAction}`);
	return {
		schema: COMMAND_SCHEMA_V3,
		contract: { version: 3, hash: identity.commandContractHash },
		command: { cli: command.subcommand, tool: command.name },
		...(action ? { action: { cli: action.cliAction, raw: action.action, owner: action.owner, schemaRef: action.schemaRef } } : {}),
		parameters,
	};
}
