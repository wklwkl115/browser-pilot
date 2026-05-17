import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type BridgeCommand = {
	cmd: string;
	method?: string;
	tabId?: number | string;
	[key: string]: unknown;
};

type CommandSpec = {
	domain?: string;
	tabScoped?: boolean;
	methods?: string[];
	defaultMethod?: string;
	methodRequired?: boolean;
	required?: string[];
	requiredAny?: string[][];
	methodSpecs?: Record<string, Pick<CommandSpec, "required" | "requiredAny">>;
	canonical?: string;
};

type NativeCommandProtocolSchema = {
	name: string;
	version: string;
	domains: Record<string, string[]>;
	aliases?: Record<string, string>;
	commands: Record<string, CommandSpec>;
};

export type BridgeCommandValidation =
	| { ok: true; command: BridgeCommand; spec: CommandSpec; canonicalCmd: string }
	| { ok: false; error: string; details: Record<string, unknown> };

let cachedSchema: NativeCommandProtocolSchema | undefined;

function protocolSchemaPath(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bridge", "native_command_schema.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasValue(value: unknown): boolean {
	return value !== undefined && value !== null && value !== "";
}

function toTabId(value: unknown): number | undefined {
	const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

function assertProtocolShape(value: unknown): NativeCommandProtocolSchema {
	if (!isRecord(value)) throw new Error("native command protocol schema must be an object");
	if (!isRecord(value.commands)) throw new Error("native command protocol schema requires commands map");
	if (!isRecord(value.domains)) throw new Error("native command protocol schema requires domains map");
	return value as NativeCommandProtocolSchema;
}

export function getNativeCommandProtocolSchema(): NativeCommandProtocolSchema {
	if (!cachedSchema) cachedSchema = assertProtocolShape(JSON.parse(readFileSync(protocolSchemaPath(), "utf8")));
	return cachedSchema;
}

export function canonicalBridgeCommand(cmd: string, schema = getNativeCommandProtocolSchema()): string {
	const spec = schema.commands[cmd];
	if (spec?.canonical) return spec.canonical;
	return schema.aliases?.[cmd] || cmd;
}

function missingRequired(command: Record<string, unknown>, required: string[] | undefined): string[] {
	return (required || []).filter((field) => !hasValue(command[field]));
}

function requiredAnySatisfied(command: Record<string, unknown>, groups: string[][] | undefined): boolean {
	if (!groups?.length) return true;
	return groups.some((group) => Array.isArray(group) && group.every((field) => hasValue(command[field])));
}

export function validateBridgeCommand(command: unknown, options: { allowMissingTabId?: boolean } = {}): BridgeCommandValidation {
	const schema = getNativeCommandProtocolSchema();
	if (!isRecord(command)) return { ok: false, error: "Bridge command must be an object", details: { commandType: typeof command } };
	if (typeof command.cmd !== "string" || !command.cmd.trim()) return { ok: false, error: "Bridge command requires string cmd", details: { cmd: command.cmd } };

	const cmd = command.cmd.trim();
	const canonicalCmd = canonicalBridgeCommand(cmd, schema);
	const spec = schema.commands[cmd] || schema.commands[canonicalCmd];
	if (!spec) return { ok: false, error: `Unknown bridge command: ${cmd}`, details: { cmd } };

	const checked: BridgeCommand = { ...command, cmd } as BridgeCommand;
	const methods = Array.isArray(spec.methods) ? spec.methods : [];
	let methodSpec: Pick<CommandSpec, "required" | "requiredAny"> | undefined;
	if (methods.length) {
		const rawMethod = hasValue(checked.method) ? String(checked.method) : spec.defaultMethod;
		if (spec.methodRequired && !hasValue(rawMethod)) return { ok: false, error: `${cmd} requires method`, details: { cmd } };
		if (hasValue(rawMethod) && !methods.includes(String(rawMethod))) return { ok: false, error: `Unsupported method for ${cmd}: ${rawMethod}`, details: { cmd, method: rawMethod, supported: methods } };
		if (hasValue(rawMethod)) {
			checked.method = String(rawMethod);
			methodSpec = spec.methodSpecs?.[String(rawMethod)];
		}
	}

	const missing = [...missingRequired(checked, spec.required), ...missingRequired(checked, methodSpec?.required)];
	if (missing.length) return { ok: false, error: `${cmd} missing required fields: ${missing.join(", ")}`, details: { cmd, missing } };

	const requiredAny = [...(spec.requiredAny || []), ...(methodSpec?.requiredAny || [])];
	if (!requiredAnySatisfied(checked, requiredAny)) return { ok: false, error: `${cmd} requires one of field groups`, details: { cmd, requiredAny } };

	if (spec.tabScoped && !options.allowMissingTabId && toTabId(checked.tabId) === undefined) return { ok: false, error: `${cmd} requires tabId`, details: { cmd, tabId: checked.tabId } };
	return { ok: true, command: checked, spec, canonicalCmd };
}

export function nativeBridgeCommandNames(schema = getNativeCommandProtocolSchema()): string[] {
	return Object.entries(schema.domains)
		.filter(([domain]) => domain !== "core")
		.flatMap(([, names]) => names);
}
