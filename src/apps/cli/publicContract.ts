import type { CliCommand } from "./registry.js";
import { commandGroup } from "./commandMetadata.js";
import { localDaemonContractIdentity } from "../daemon/contractIdentity.js";
import { publicActionsForDefinition } from "../../commands/publicActionCatalog.js";
import { actionSchemaForDefinition, commandParametersForSchema } from "../../commands/actionSchemas.js";
import { COMMAND_CATALOG_SCHEMA_V3, COMMAND_SCHEMA_V3 } from "../../commands/publicContractSchemas.js";
import { isRecord } from "../../utils/records.js";
import { naturalSubcommandRoutes, type NaturalSubcommandInvocation } from "./naturalRouting.js";

export const COMMAND_CATALOG_V3 = COMMAND_CATALOG_SCHEMA_V3;

export interface CommandCatalogV3 {
	schema: typeof COMMAND_CATALOG_V3;
	contract: { version: 3; hash: string; toolCount: 19 };
	artifact: {
		resultField: "saved.path";
		inspectArgv: ["browser-pilot", "artifact", "inspect", "--path", "<saved.path>", "--json"];
	};
	commands: Array<{
		cli: string;
		tool: `browser_${string}`;
		group: string;
		summary: string;
		schemaArgv: string[];
		actions?: Array<{ cli: string; raw: string; schemaRef: string; schemaArgv: string[] }>;
		subcommands?: Array<{ cli: string; parameter: string; value: string; schemaArgv: string[] }>;
	}>;
}

export function buildCommandCatalogV3(commands: readonly CliCommand[]): CommandCatalogV3 {
	const identity = localDaemonContractIdentity();
	if (identity.toolCount !== 19 || commands.length !== 19) throw new Error(`command catalog v3 requires exactly 19 tools; found identity=${identity.toolCount}, registry=${commands.length}`);
	return {
		schema: COMMAND_CATALOG_V3,
		contract: { version: 3, hash: identity.commandContractHash, toolCount: 19 },
		artifact: {
			resultField: "saved.path",
			inspectArgv: ["browser-pilot", "artifact", "inspect", "--path", "<saved.path>", "--json"],
		},
		commands: commands.map((command) => {
			const actions = publicActionsForDefinition(command.def);
			const subcommands = naturalSubcommandRoutes(command).filter((route) => !route.action);
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
				...(subcommands.length ? {
					subcommands: subcommands.map((route) => ({
						cli: route.token,
						parameter: route.parameter,
						value: route.value,
						schemaArgv: ["browser-pilot", "schema", command.subcommand, route.token, "--json"],
					})),
				} : {}),
			};
		}),
	};
}

function narrowNaturalParameter(parameters: unknown, route: NaturalSubcommandInvocation): unknown {
	const narrowed = structuredClone(parameters);
	if (!isRecord(narrowed) || !isRecord(narrowed.properties)) throw new Error(`missing parameter schema for ${route.parameter}`);
	const current = narrowed.properties[route.parameter];
	if (!isRecord(current)) throw new Error(`missing parameter schema for ${route.parameter}`);
	const { anyOf: _anyOf, oneOf: _oneOf, enum: _enum, const: _const, ...annotations } = current;
	narrowed.properties[route.parameter] = { ...annotations, const: route.value };
	const required = Array.isArray(narrowed.required) ? narrowed.required.filter((item): item is string => typeof item === "string") : [];
	if (!required.includes(route.parameter)) required.push(route.parameter);
	narrowed.required = required;
	return narrowed;
}

export function buildCommandSchemaV3(command: CliCommand, rawAction?: string, naturalParameter?: NaturalSubcommandInvocation): Record<string, unknown> {
	const identity = localDaemonContractIdentity();
	const action = rawAction ? publicActionsForDefinition(command.def).find((candidate) => candidate.action === rawAction) : undefined;
	const baseParameters = action ? actionSchemaForDefinition(command.def, action.action) : commandParametersForSchema(command.def);
	const parameters = naturalParameter ? narrowNaturalParameter(baseParameters, naturalParameter) : baseParameters;
	if (!parameters) throw new Error(`missing action schema for ${command.name}:${rawAction}`);
	return {
		schema: COMMAND_SCHEMA_V3,
		contract: { version: 3, hash: identity.commandContractHash },
		command: { cli: command.subcommand, tool: command.name },
		...(action ? { action: { cli: action.cliAction, raw: action.action, owner: action.owner, schemaRef: action.schemaRef } } : {}),
		parameters,
	};
}
