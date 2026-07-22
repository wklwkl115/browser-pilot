import { canonicalBridgeCommand, getNativeCommandProtocolSchema, validateBridgeCommand } from "../../../types/nativeProtocol";

const schema = getNativeCommandProtocolSchema();

function nativeCommands(): string[] {
	const commands: string[] = [];
	for (const [domain, names] of Object.entries(schema.domains)) {
		if (domain !== "core") commands.push(...names);
	}
	return commands;
}

function canonicalCommand(cmd: unknown): string {
	return canonicalBridgeCommand(String(cmd || ""), schema);
}

const nativeCommandNames = nativeCommands();
const nativeCommandMap = Object.fromEntries(nativeCommandNames.map((cmd) => [cmd, canonicalCommand(cmd)]));
for (const [alias, target] of Object.entries(schema.aliases || {})) {
	if (nativeCommandMap[target] || schema.commands[target]?.domain !== "core") nativeCommandMap[alias] = target;
}

export const BrowserPilotNativeProtocol = {
	schema,
	aliases: schema.aliases || {},
	commandNames: Object.keys(schema.commands),
	nativeCommands: nativeCommandNames,
	nativeCommandMap,
	canonicalCommand,
	validateCommand: validateBridgeCommand,
};
