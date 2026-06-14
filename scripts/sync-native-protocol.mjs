import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const sourcePath = path.join(root, "bridge", "native_command_schema.json");
const schema = JSON.parse(readFileSync(sourcePath, "utf8"));
const schemaText = JSON.stringify(schema, null, 2);

const outputs = [
	[path.join(root, "bridge", "pi_browser_bridge", "native_command_schema.json"), generateBridgeSchema],
	[path.join(root, "bridge_src", "service_worker", "protocol.ts"), generateBridgeProtocolTs],
	[path.join(root, "src", "protocol", "nativeProtocol.ts"), generateNodeProtocolTs],
	[path.join(root, "src", "protocol", "nativeActionMetadata.ts"), generateNativeActionMetadataTs],
	[path.join(root, "src", "protocol", "nativeErrorCodes.ts"), generateNativeErrorCodesTs],
	[path.join(root, "docs", "generated", "native-protocol.generated.md"), generateNativeProtocolDocs],
];

function generatedHeader(source = "bridge/native_command_schema.json") {
	return `// Generated from ${source}. Do not edit by hand.\n`;
}

function generateBridgeSchema() {
	return `${schemaText}\n`;
}

function generateBridgeProtocolTs() {
	return `${generatedHeader()}import type { JsonRecord, PiBridgeCommand } from "./types";

type PiCommandSpec = JsonRecord & {
  domain?: string;
  tabScoped?: boolean;
  accessMode?: 'read' | 'write';
  internal?: boolean;
  methods?: string[];
  defaultMethod?: string;
  methodRequired?: boolean;
  required?: string[];
  requiredAny?: string[][];
  methodSpecs?: Record<string, PiCommandSpec>;
  canonical?: string;
};
type PiProtocolSchema = JsonRecord & {
  aliases: Record<string, string>;
  domains: Record<string, string[]>;
  commands: Record<string, PiCommandSpec>;
};

(function installPiNativeProtocol(global: typeof globalThis & { PiNativeProtocol?: unknown }) {
  'use strict';
  const schema = ${schemaText} as PiProtocolSchema;

  function isObject(value: unknown): value is PiBridgeCommand {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function hasValue(value: unknown): boolean {
    return value !== undefined && value !== null && value !== '';
  }

  function toTabId(value: unknown): number | undefined {
    const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }

  function allCommands(): string[] {
    return Object.keys(schema.commands || {});
  }

  function nativeCommands(): string[] {
    const domains = schema.domains || {};
    const out: string[] = [];
    for (const [domain, names] of Object.entries(domains)) {
      if (domain === 'core' || !Array.isArray(names)) continue;
      for (const name of names) out.push(name);
    }
    return out;
  }

  function canonicalCommand(cmd: unknown): string {
    const key = String(cmd || '');
    const direct = schema.commands && schema.commands[key];
    if (direct && direct.canonical) return direct.canonical;
    return (schema.aliases && schema.aliases[key]) || key;
  }

  function nativeCommandMap(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const cmd of nativeCommands()) out[cmd] = canonicalCommand(cmd);
    for (const [alias, target] of Object.entries(schema.aliases || {})) {
      if (out[target] || (schema.commands && schema.commands[target] && schema.commands[target].domain !== 'core')) out[alias] = target;
    }
    return out;
  }

  function missingRequired(command: JsonRecord, required?: string[]): string[] {
    return (required || []).filter((field) => !hasValue(command[field]));
  }

  function requiredAnySatisfied(command: JsonRecord, groups?: string[][]): boolean {
    if (!Array.isArray(groups) || groups.length === 0) return true;
    return groups.some((group) => Array.isArray(group) && group.every((field) => hasValue(command[field])));
  }

  function validateCommand(command: unknown, options?: { allowMissingTabId?: boolean }) {
    const opts = options || {};
    if (!isObject(command)) return { ok: false, error: 'Bridge command must be an object', details: { commandType: typeof command } };
    if (typeof command.cmd !== 'string' || !command.cmd.trim()) return { ok: false, error: 'Bridge command requires string cmd', details: { cmd: command.cmd } };

    const cmd = command.cmd.trim();
    const canonical = canonicalCommand(cmd);
    const spec = (schema.commands && (schema.commands[cmd] || schema.commands[canonical])) || null;
    if (!spec) return { ok: false, error: 'Unknown bridge command: ' + cmd, details: { cmd } };

    const checked = Object.assign({}, command, { cmd });
    const methods = Array.isArray(spec.methods) ? spec.methods : [];
    let methodSpec: PiCommandSpec | null = null;
    if (methods.length) {
      const rawMethod = hasValue(checked.method) ? String(checked.method) : spec.defaultMethod;
      if (spec.methodRequired && !hasValue(rawMethod)) return { ok: false, error: cmd + ' requires method', details: { cmd } };
      if (hasValue(rawMethod) && !methods.includes(String(rawMethod))) {
        return { ok: false, error: 'Unsupported method for ' + cmd + ': ' + rawMethod, details: { cmd, method: rawMethod, supported: methods } };
      }
      if (hasValue(rawMethod)) {
        checked.method = String(rawMethod);
        methodSpec = spec.methodSpecs && spec.methodSpecs[String(rawMethod)] || null;
      }
    }

    const missing = missingRequired(checked, spec.required).concat(missingRequired(checked, methodSpec?.required));
    if (missing.length) return { ok: false, error: cmd + ' missing required fields: ' + missing.join(', '), details: { cmd, missing } };

    const anyGroups: string[][] = [];
    if (Array.isArray(spec.requiredAny)) anyGroups.push.apply(anyGroups, spec.requiredAny);
    if (methodSpec && Array.isArray(methodSpec.requiredAny)) anyGroups.push.apply(anyGroups, methodSpec.requiredAny);
    if (!requiredAnySatisfied(checked, anyGroups)) return { ok: false, error: cmd + ' requires one of field groups', details: { cmd, requiredAny: anyGroups } };

    if (spec.tabScoped && !opts.allowMissingTabId && toTabId(checked.tabId) === undefined) {
      return { ok: false, error: cmd + ' requires tabId', details: { cmd, tabId: checked.tabId } };
    }

    return { ok: true, command: checked, spec, canonicalCmd: canonical };
  }

  const protocol = {
    schema,
    aliases: schema.aliases || {},
    commandNames: allCommands(),
    nativeCommands: nativeCommands(),
    nativeCommandMap: nativeCommandMap(),
    canonicalCommand,
    validateCommand
  };
  global.PiNativeProtocol = protocol;
})(typeof self !== 'undefined' ? self : globalThis);
export const PiNativeProtocol = (globalThis as typeof globalThis & { PiNativeProtocol?: unknown }).PiNativeProtocol;
// ESM module metadata
export const __piBridgeModule_protocol = { name: "protocol", symbols: { PiNativeProtocol } };
`;
}

function generateNodeProtocolTs() {
	return `${generatedHeader()}export type BridgeCommand = {
	cmd: string;
	method?: string;
	tabId?: number | string;
	[key: string]: unknown;
};

type CommandSpec = {
	domain?: string;
	tabScoped?: boolean;
	accessMode?: "read" | "write";
	internal?: boolean;
	methods?: string[];
	defaultMethod?: string;
	methodRequired?: boolean;
	required?: string[];
	requiredAny?: string[][];
	methodSpecs?: Record<string, Pick<CommandSpec, "required" | "requiredAny" | "accessMode">>;
	canonical?: string;
	notes?: string;
};

type NativeCommandProtocolSchema = {
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

const schema = ${schemaText} as const satisfies NativeCommandProtocolSchema;

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

function requiredAnySatisfied(command: Record<string, unknown>, groups: string[][] | undefined): boolean {
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
	if (!spec) return { ok: false, error: \`Unknown bridge command: \${cmd}\`, details: { cmd } };

	const checked: BridgeCommand = { ...command, cmd } as BridgeCommand;
	const methods = Array.isArray(spec.methods) ? spec.methods : [];
	let methodSpec: Pick<CommandSpec, "required" | "requiredAny"> | undefined;
	if (methods.length) {
		const rawMethod = hasValue(checked.method) ? String(checked.method) : spec.defaultMethod;
		if (spec.methodRequired && !hasValue(rawMethod)) return { ok: false, error: \`\${cmd} requires method\`, details: { cmd } };
		if (hasValue(rawMethod) && !methods.includes(String(rawMethod))) return { ok: false, error: \`Unsupported method for \${cmd}: \${rawMethod}\`, details: { cmd, method: rawMethod, supported: methods } };
		if (hasValue(rawMethod)) {
			checked.method = String(rawMethod);
			methodSpec = spec.methodSpecs?.[String(rawMethod)];
		}
	}

	const missing = [...missingRequired(checked, spec.required), ...missingRequired(checked, methodSpec?.required)];
	if (missing.length) return { ok: false, error: \`\${cmd} missing required fields: \${missing.join(", ")}\`, details: { cmd, missing } };

	const requiredAny = [...(spec.requiredAny || []), ...(methodSpec?.requiredAny || [])];
	if (!requiredAnySatisfied(checked, requiredAny)) return { ok: false, error: \`\${cmd} requires one of field groups\`, details: { cmd, requiredAny } };

	if (spec.tabScoped && !options.allowMissingTabId && toTabId(checked.tabId) === undefined) return { ok: false, error: \`\${cmd} requires tabId\`, details: { cmd, tabId: checked.tabId } };
	return { ok: true, command: checked, spec, canonicalCmd };
}

export function nativeBridgeCommandNames(currentSchema = getNativeCommandProtocolSchema()): string[] {
	return Object.entries(currentSchema.domains)
		.filter(([domain]) => domain !== "core")
		.flatMap(([, names]) => names);
}
`;
}

function normalizeAction(action) {
	return String(action || "").trim().toLowerCase().replace(/[_.-]/g, "");
}

function generatedNativeActionMetadata() {
	const source = schema.toolMetadata || {};
	const commands = schema.commands || {};
	const nativeActionTools = {};
	for (const [toolName, tool] of Object.entries(source.nativeActionTools || {})) {
		const actionAliases = {};
		// Join each action with its command's param requirements (single source of truth =
		// schema.commands[*].required/requiredAny/notes) so `browser-pilot <tool> --help` can surface
		// per-action --params keys instead of an opaque `<json>`. Derived for EVERY action of every
		// action tool — never hand-listed — so it stays correct and drift-guarded by check:protocol.
		const actions = (tool.actions || []).map((action) => {
			for (const alias of action.aliases || [action.action]) actionAliases[normalizeAction(alias)] = action.command;
			const spec = commands[action.command] || {};
			const enriched = { ...action };
			if (Array.isArray(spec.required) && spec.required.length) enriched.required = spec.required;
			if (Array.isArray(spec.requiredAny) && spec.requiredAny.length) enriched.requiredAny = spec.requiredAny;
			if (typeof spec.notes === "string" && spec.notes) enriched.notes = spec.notes;
			return enriched;
		});
		nativeActionTools[toolName] = { ...tool, actions, actionAliases };
	}
	return {
		nativeActionTools,
		nativeCommandTools: source.nativeCommandTools || {},
		transferTools: source.transferTools || {},
	};
}

function generateNativeActionMetadataTs() {
	const metadataText = JSON.stringify(generatedNativeActionMetadata(), null, 2);
	return `${generatedHeader()}export const nativeToolMetadata = ${metadataText} as const;

export type NativeActionToolName = keyof typeof nativeToolMetadata.nativeActionTools;
export type NativeCommandToolName = keyof typeof nativeToolMetadata.nativeCommandTools;
export type NativeTransferToolName = keyof typeof nativeToolMetadata.transferTools;

export function normalizeNativeToolAction(action: string): string {
	return action.trim().toLowerCase().replace(/[_.-]/g, "");
}

export function commandForNativeToolAction(toolName: NativeActionToolName, action: string): string {
	const metadata = nativeToolMetadata.nativeActionTools[toolName];
	const command = (metadata.actionAliases as Record<string, string>)[normalizeNativeToolAction(action)];
	if (!command) throw new Error(\`Unsupported \${toolName} action: \${action}\`);
	return command;
}

export const nativeCommandToolMetadata = nativeToolMetadata.nativeCommandTools;
export const nativeTransferToolMetadata = nativeToolMetadata.transferTools;

export function metadataForNativeCommandTool(toolName: NativeCommandToolName) {
	return nativeCommandToolMetadata[toolName];
}

export function metadataForNativeTransferTool(toolName: NativeTransferToolName) {
	return nativeTransferToolMetadata[toolName];
}
`;
}

function generateNativeErrorCodesTs() {
	const errorText = JSON.stringify(schema.errorCodes || {}, null, 2);
	return `${generatedHeader()}export const nativeErrorCodes = ${errorText} as const;

export type NativeErrorCode = keyof typeof nativeErrorCodes;

export function isNativeErrorCode(value: string): value is NativeErrorCode {
	return Object.hasOwn(nativeErrorCodes, value);
}

export function normalizeNativeErrorCode(value: unknown, fallback: NativeErrorCode = "INTERNAL_ERROR"): NativeErrorCode {
	return typeof value === "string" && isNativeErrorCode(value) ? value : fallback;
}
`;
}

function escapeCell(value) {
	return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function table(headers, rows) {
	return [
		`| ${headers.join(" | ")} |`,
		`| ${headers.map(() => "---").join(" | ")} |`,
		...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
	].join("\n");
}

function commandRows() {
	return Object.entries(schema.commands || {})
		.filter(([, spec]) => spec.internal !== true)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, spec]) => [
			`\`${name}\``,
			spec.domain || "",
			spec.tabScoped === true ? "yes" : "no",
			Array.isArray(spec.required) ? spec.required.join(", ") : "",
			Array.isArray(spec.requiredAny) ? spec.requiredAny.map((group) => `[${group.join("+")}]`).join(", ") : "",
			spec.canonical || schema.aliases?.[name] || "",
		]);
}

function toolRows() {
	const metadata = generatedNativeActionMetadata();
	const actionRows = Object.entries(metadata.nativeActionTools).map(([name, tool]) => [
		`\`${name}\``, tool.domain, (tool.parameters || []).map((item) => `\`${item}\``).join(", "), tool.actionDescription || "",
	]);
	const commandRows = Object.entries(metadata.nativeCommandTools || {}).map(([name, tool]) => [
		`\`${name}\``, tool.domain, (tool.parameters || []).map((item) => `\`${item}\``).join(", "), tool.command || "",
	]);
	const transferRows = Object.entries(metadata.transferTools).map(([name, tool]) => [
		`\`${name}\``, tool.domain, (tool.parameters || []).map((item) => `\`${item}\``).join(", "), tool.command || "",
	]);
	return [...actionRows, ...commandRows, ...transferRows];
}

function errorRows() {
	return Object.entries(schema.errorCodes || {})
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([code, spec]) => [`\`${code}\``, spec.category || "", spec.retryable === true ? "yes" : "no", spec.summary || ""]);
}

function generateNativeProtocolDocs() {
	const readmeSnippet = "Run `npm run sync:protocol` after editing `bridge/native_command_schema.json`; `npm run check:protocol` fails on generated protocol/tool/error drift.";
	const skillSnippet = "Native browser command behavior is governed by generated protocol metadata; use browser_wait/browser_network actions and browser_download/browser_upload rather than raw transfer.upload.";
	return `# Native Protocol Contract (Generated)\n\n` +
		`Generated by \`scripts/sync-native-protocol.mjs\`. Do not edit by hand.\n\n` +
		`## Source\n\n` +
		`- Single source: \`bridge/native_command_schema.json\` (${schema.name} ${schema.version}).\n` +
		`- Generated runtime/type outputs: \`bridge_src/service_worker/protocol.ts\`, \`src/protocol/nativeProtocol.ts\`, \`src/protocol/nativeActionMetadata.ts\`, \`src/protocol/nativeErrorCodes.ts\`.\n\n` +
		`## Native commands\n\n` +
		table(["Command", "Domain", "Tab scoped", "Required", "Required any", "Canonical"], commandRows()) +
		`\n\n## Tool metadata slice\n\n` +
		table(["Tool", "Domain", "Parameters", "Actions / command"], toolRows()) +
		`\n\n## Error codes\n\n` +
		table(["Code", "Category", "Retryable", "Summary"], errorRows()) +
		`\n\n## README snippet\n\n${readmeSnippet}\n\n` +
		`## Skill snippet\n\n${skillSnippet}\n`;
}

let drift = false;
for (const [target, generator] of outputs) {
	const next = generator();
	if (checkOnly) {
		const current = existsSync(target) ? readFileSync(target, "utf8") : "";
		if (current !== next) {
			console.error(`native protocol generated output is stale: ${path.relative(root, target)}. Run npm run sync:protocol.`);
			drift = true;
		}
	} else {
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, next, "utf8");
	}
}
if (drift) process.exit(1);
console.log(checkOnly ? "native protocol generated outputs ok" : `synced native protocol: ${outputs.map(([target]) => path.relative(root, target)).join(", ")}`);
