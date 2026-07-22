import schemaJson from "../bridge/protocol/native-command.schema.json" with { type: "json" };

export type BridgeCommand = {
	cmd: string;
	method?: string;
	tabId?: number | string;
	[key: string]: unknown;
};

export type CommandSpec = {
	domain?: string;
	tabScoped?: boolean;
	accessMode?: "read" | "write";
	internal?: boolean;
	methods?: string[];
	defaultMethod?: string;
	methodRequired?: boolean;
	required?: string[];
	requiredAny?: string[][];
	paramsSchema?: Record<string, unknown>;
	methodSpecs?: Record<string, Pick<CommandSpec, "required" | "requiredAny" | "accessMode">>;
	canonical?: string;
	notes?: string;
};

export type NativeCommandProtocolSchema = {
	name: string;
	version: string;
	transport?: string;
	envelope?: Record<string, unknown>;
	domains: Record<string, string[]>;
	aliases?: Record<string, string>;
	commands: Record<string, CommandSpec>;
	errorCodes?: Record<string, { category?: string; retryable?: boolean; summary?: string }>;
	toolMetadata?: Record<string, unknown>;
};

export type BridgeCommandValidation =
	| { ok: true; command: BridgeCommand; spec: CommandSpec; canonicalCmd: string }
	| { ok: false; error: string; details: Record<string, unknown> };

const schema = schemaJson as unknown as NativeCommandProtocolSchema;

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

export function getNativeCommandProtocolSchema(): NativeCommandProtocolSchema {
	return schema;
}

export function canonicalBridgeCommand(cmd: string, currentSchema = getNativeCommandProtocolSchema()): string {
	const spec = currentSchema.commands[cmd];
	if (spec?.canonical) return spec.canonical;
	return currentSchema.aliases?.[cmd] || cmd;
}

function missingRequired(command: Record<string, unknown>, required: string[] | undefined): string[] {
	return (required || []).filter((field) => !hasValue(command[field]));
}

export function requiredAnySatisfied(command: Record<string, unknown>, groups: string[][] | undefined): boolean {
	if (!groups?.length) return true;
	return groups.some((group) => Array.isArray(group) && group.every((field) => hasValue(command[field])));
}

export function validateBridgeCommand(command: unknown, options: { allowMissingTabId?: boolean } = {}): BridgeCommandValidation {
	const currentSchema = getNativeCommandProtocolSchema();
	if (!isRecord(command)) return { ok: false, error: "Bridge command must be an object", details: { commandType: typeof command } };
	if (typeof command.cmd !== "string" || !command.cmd.trim()) return { ok: false, error: "Bridge command requires string cmd", details: { cmd: command.cmd } };

	const cmd = command.cmd.trim();
	const canonicalCmd = canonicalBridgeCommand(cmd, currentSchema);
	const spec = currentSchema.commands[cmd] || currentSchema.commands[canonicalCmd];
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
