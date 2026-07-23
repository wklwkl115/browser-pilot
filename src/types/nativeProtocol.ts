import schemaJson from "../bridge/protocol/native-command.schema.json" with { type: "json" };
import { validateCommandArgs } from "../validation/commandArgs.js";
import { isRecord, toTabId } from "../utils/records.js";

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
};

export type BridgeCommandValidation =
	| { ok: true; command: BridgeCommand; spec: CommandSpec; canonicalCmd: string }
	| { ok: false; error: string; details: Record<string, unknown> };

const schema = schemaJson as unknown as NativeCommandProtocolSchema;

function hasValue(value: unknown): boolean {
	return value !== undefined && value !== null && value !== "";
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

const COMMAND_ENVELOPE_FIELDS = new Set(["cmd", "tabId", "timeoutMs", "sessionId"]);
const PUBLIC_INTERNAL_CONTROL_FIELDS = ["browserSessionId", "tabId", "sessionId", "timeoutMs"] as const;

function commandPayload(command: Record<string, unknown>, allowResolvedTarget: boolean): Record<string, unknown> {
	return Object.fromEntries(Object.entries(command).filter(([key]) => !COMMAND_ENVELOPE_FIELDS.has(key) && !(allowResolvedTarget && key === "target")));
}

function validateCommandEnvelope(command: Record<string, unknown>): string | undefined {
	if (command.tabId !== undefined && (!Number.isInteger(command.tabId) || Number(command.tabId) <= 0)) return "tabId must be a positive integer";
	if (command.sessionId !== undefined && typeof command.sessionId !== "string") return "sessionId must be a string";
	if (command.timeoutMs !== undefined && (!Number.isInteger(command.timeoutMs) || Number(command.timeoutMs) < 0)) return "timeoutMs must be a non-negative integer";
	return undefined;
}

export function requiredAnySatisfied(command: Record<string, unknown>, groups: string[][] | undefined): boolean {
	if (!groups?.length) return true;
	return groups.some((group) => Array.isArray(group) && group.every((field) => hasValue(command[field])));
}

export function validateBridgeCommand(command: unknown, options: { allowMissingTabId?: boolean; allowResolvedTarget?: boolean; publicCall?: boolean } = {}): BridgeCommandValidation {
	const currentSchema = getNativeCommandProtocolSchema();
	if (!isRecord(command)) return { ok: false, error: "Bridge command must be an object", details: { commandType: typeof command } };
	if (typeof command.cmd !== "string" || !command.cmd.trim()) return { ok: false, error: "Bridge command requires string cmd", details: { cmd: command.cmd } };

	const cmd = command.cmd.trim();
	const canonicalCmd = canonicalBridgeCommand(cmd, currentSchema);
	const spec = currentSchema.commands[canonicalCmd] || currentSchema.commands[cmd];
	if (!spec) return { ok: false, error: `Unknown bridge command: ${cmd}`, details: { cmd } };
	if (options.publicCall) {
		const field = PUBLIC_INTERNAL_CONTROL_FIELDS.find((key) => command[key] !== undefined);
		if (field) return { ok: false, error: `${cmd}: ${field} is runtime-managed; use the tool-level targetRef only when tab disambiguation is required`, details: { cmd, field } };
	}

	const checked: BridgeCommand = { ...command, cmd } as BridgeCommand;
	const envelopeError = validateCommandEnvelope(checked);
	if (envelopeError) return { ok: false, error: `${cmd} ${envelopeError}`, details: { cmd } };
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
	if (canonicalCmd === "persistent_cdp" && checked.action === "detachTarget" && !hasValue(checked.targetId) && !hasValue(checked.sessionId)) {
		return { ok: false, error: `${cmd} detachTarget requires targetId or sessionId`, details: { cmd, action: checked.action } };
	}

	if (spec.paramsSchema) {
		const allowResolvedTarget = options.allowResolvedTarget === true && canonicalCmd === "input.ref";
		const params = validateCommandArgs(spec.paramsSchema, commandPayload(checked, allowResolvedTarget));
		if (!params.ok) return { ok: false, error: `${cmd}: ${params.error}`, details: { cmd, issues: params.issues } };
	}

	if (spec.tabScoped && !options.allowMissingTabId && toTabId(checked.tabId) === undefined) return { ok: false, error: `${cmd} requires tabId`, details: { cmd, tabId: checked.tabId } };
	return { ok: true, command: checked, spec, canonicalCmd };
}
