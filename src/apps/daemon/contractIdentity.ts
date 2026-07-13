import { createHash } from "node:crypto";
import { defineBrowserCommands } from "../../commands/defineBrowserCommands.js";
import { defineAgentFacadeCommands } from "../../commands/agent/defineAgentFacadeCommands.js";
import { CommandManifestIndex, type CommandDefinition } from "../../commands/commandManifestIndex.js";
import { contractActionMetadata } from "../../commands/publicActionCatalog.js";
import { BROWSER_OPERATION_OUTCOME_CONTRACT, BROWSER_OPERATION_SCHEMA } from "../../kernels/session/browserOperation.js";
import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { getNativeCommandProtocolSchema } from "../../types/nativeProtocol.js";
import { COMMAND_CONTRACT_VERSION, DAEMON_PROTOCOL_VERSION, packageVersion } from "./packageInfo.js";
import { PAGE_WORLD_SCAN_BUNDLE_JSON_SCHEMA, PAGE_WORLD_SCAN_SCHEMA } from "../../kernels/abml/pageWorldScan.js";
import { COMMAND_CATALOG_V3_JSON_SCHEMA, COMMAND_SCHEMA_V3_JSON_SCHEMA } from "../../commands/publicContractSchemas.js";
import { PAGE_OBSERVATION_SCHEMA_V3, PAGE_OBSERVATION_V3_JSON_SCHEMA } from "../../kernels/abml/pageObservation.js";

export interface DaemonContractIdentity {
	packageVersion: string;
	daemonProtocolVersion: number;
	commandContractVersion: 3;
	commandContractHash: string;
	toolCount: number;
}

export const DAEMON_CONTRACT_IDENTITY_FIELDS = [
	"packageVersion",
	"daemonProtocolVersion",
	"commandContractVersion",
	"commandContractHash",
	"toolCount",
] as const satisfies readonly (keyof DaemonContractIdentity)[];

export type DaemonContractMismatch = {
	field: keyof DaemonContractIdentity;
	local: unknown;
	daemon: unknown;
	source?: "daemon" | "lock";
};

export type DaemonContractCheck = {
	ok: boolean;
	code: "DAEMON_CONTRACT_MATCH" | "DAEMON_CONTRACT_MISMATCH";
	reason: "match" | "daemon_missing" | "identity_missing" | "field_mismatch";
	mismatches: DaemonContractMismatch[];
};

type JsonPrimitive = null | boolean | number | string;
type CanonicalJson = JsonPrimitive | CanonicalJson[] | { [key: string]: CanonicalJson };

const NON_CONTRACT_SCHEMA_KEYS = new Set(["$comment", "description", "examples", "title"]);
const SCHEMA_MAP_KEYS = new Set(["$defs", "definitions", "dependentSchemas", "patternProperties", "properties"]);
const SCHEMA_LITERAL_KEYS = new Set(["const", "default", "enum", "examples"]);

/**
 * Convert arbitrary JSON-like data into a canonicalizable value. Annotation
 * removal is performed separately and only while walking schema objects.
 */
function contractJson(value: unknown, seen = new WeakSet<object>()): CanonicalJson {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("command contract contains a non-finite number");
		return value;
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) throw new TypeError("command contract contains a cycle");
		seen.add(value);
		const result = value.map((item) => contractJson(item === undefined ? null : item, seen));
		seen.delete(value);
		return result;
	}
	if (typeof value === "object") {
		if (seen.has(value)) throw new TypeError("command contract contains a cycle");
		seen.add(value);
		const result: Record<string, CanonicalJson> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const child = (value as Record<string, unknown>)[key];
			if (child === undefined || typeof child === "function" || typeof child === "symbol" || typeof child === "bigint") continue;
			result[key] = contractJson(child, seen);
		}
		seen.delete(value);
		return result;
	}
	throw new TypeError(`unsupported command contract value: ${typeof value}`);
}

/**
 * Remove JSON Schema prose annotations without dropping a behavioral property
 * merely because it is itself named `description` or `title`.
 */
function contractSchema(value: unknown, role: "schema" | "schema-map" | "literal" = "schema"): unknown {
	if (Array.isArray(value)) return value.map((item) => contractSchema(item, role === "literal" ? "literal" : "schema"));
	if (!value || typeof value !== "object") return value;
	const source = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(source)) {
		if (role === "schema" && NON_CONTRACT_SCHEMA_KEYS.has(key)) continue;
		const nextRole = role === "literal"
			? "literal"
			: role === "schema-map"
				? "schema"
				: SCHEMA_MAP_KEYS.has(key)
					? "schema-map"
					: SCHEMA_LITERAL_KEYS.has(key)
						? "literal"
						: "schema";
		result[key] = contractSchema(source[key], nextRole);
	}
	return result;
}

/** Stable key-sorted JSON used for both the native hash and outer contract hash. */
export function canonicalContractJson(value: unknown): string {
	return JSON.stringify(contractJson(value));
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function nativeProtocolContractPayload(): Record<string, unknown> {
	const schema = getNativeCommandProtocolSchema() as unknown as Record<string, unknown>;
	const commands = Object.fromEntries(Object.entries((schema.commands ?? {}) as Record<string, Record<string, unknown>>).map(([name, spec]) => {
		const { notes: _notes, ...behavior } = spec;
		return [name, behavior];
	}));
	const errorCodes = Object.fromEntries(Object.entries((schema.errorCodes ?? {}) as Record<string, Record<string, unknown>>).map(([name, spec]) => {
		const { summary: _summary, ...behavior } = spec;
		return [name, behavior];
	}));
	return {
		name: schema.name,
		version: schema.version,
		envelope: contractSchema(schema.envelope),
		domains: schema.domains,
		aliases: schema.aliases,
		commands,
		errorCodes,
	};
}

export function nativeProtocolContractHash(): string {
	return sha256(canonicalContractJson(nativeProtocolContractPayload()));
}

export type CommandContractPayload = {
	commands: Array<{ name: string; parameters: unknown }>;
	actions: Array<Record<string, unknown>>;
	operationResult: {
		schema: typeof BROWSER_OPERATION_SCHEMA;
		outcomes: typeof BROWSER_OPERATION_OUTCOME_CONTRACT;
	};
	daemonProtocolVersion: number;
	nativeProtocolHash: string;
	publicSchemaHashes: {
		catalogV3: string;
		commandSchemaV3: string;
		pageScanV1: string;
		pageObservationV3: string;
	};
};

export function commandContractPayload(definitions: readonly CommandDefinition[]): CommandContractPayload {
	const commands = definitions
		.map((definition) => ({ name: definition.name, parameters: contractSchema(definition.parameters ?? null) }))
		.sort((left, right) => left.name.localeCompare(right.name));
	const nativeProtocolHash = nativeProtocolContractHash();
	return {
		commands,
		actions: contractActionMetadata(definitions),
		operationResult: { schema: BROWSER_OPERATION_SCHEMA, outcomes: BROWSER_OPERATION_OUTCOME_CONTRACT },
		daemonProtocolVersion: DAEMON_PROTOCOL_VERSION,
		nativeProtocolHash,
		publicSchemaHashes: {
			catalogV3: sha256(canonicalContractJson(contractSchema(COMMAND_CATALOG_V3_JSON_SCHEMA))),
			commandSchemaV3: sha256(canonicalContractJson(contractSchema(COMMAND_SCHEMA_V3_JSON_SCHEMA))),
			pageScanV1: sha256(canonicalContractJson({ schema: PAGE_WORLD_SCAN_SCHEMA, definition: contractSchema(PAGE_WORLD_SCAN_BUNDLE_JSON_SCHEMA) })),
			pageObservationV3: sha256(canonicalContractJson({ schema: PAGE_OBSERVATION_SCHEMA_V3, definition: contractSchema(PAGE_OBSERVATION_V3_JSON_SCHEMA) })),
		},
	};
}

export function commandContractHash(payload: CommandContractPayload): string {
	return sha256(canonicalContractJson(payload));
}

export function createDaemonContractIdentity(definitions: readonly CommandDefinition[]): DaemonContractIdentity {
	const payload = commandContractPayload(definitions);
	return {
		packageVersion: packageVersion(),
		daemonProtocolVersion: DAEMON_PROTOCOL_VERSION,
		commandContractVersion: COMMAND_CONTRACT_VERSION,
		commandContractHash: commandContractHash(payload),
		toolCount: definitions.length,
	};
}

// Registration is metadata-only. Command execute closures capture this placeholder
// but are never called while calculating the local contract identity.
const placeholderRuntime = {} as BrowserCommandRuntimePort;
const noopEnsureStarted = async () => placeholderRuntime;
let cachedLocalIdentity: DaemonContractIdentity | undefined;

export function localDaemonContractIdentity(): DaemonContractIdentity {
	if (cachedLocalIdentity) return { ...cachedLocalIdentity };
	const commands = new CommandManifestIndex();
	defineBrowserCommands(commands, placeholderRuntime, noopEnsureStarted);
	defineAgentFacadeCommands({ commands, ensureStarted: noopEnsureStarted });
	cachedLocalIdentity = createDaemonContractIdentity(commands.getCommands());
	return { ...cachedLocalIdentity };
}

function hasDaemonContractIdentityShape(value: unknown): value is Record<keyof DaemonContractIdentity, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Partial<DaemonContractIdentity>;
	return typeof candidate.packageVersion === "string"
		&& typeof candidate.daemonProtocolVersion === "number"
		&& Number.isInteger(candidate.daemonProtocolVersion)
		&& typeof candidate.commandContractVersion === "number"
		&& Number.isInteger(candidate.commandContractVersion)
		&& typeof candidate.commandContractHash === "string"
		&& /^[a-f0-9]{64}$/.test(candidate.commandContractHash)
		&& typeof candidate.toolCount === "number"
		&& Number.isInteger(candidate.toolCount)
		&& candidate.toolCount >= 0;
}

export function compareDaemonContractIdentity(
	local: DaemonContractIdentity,
	daemon: unknown,
): DaemonContractCheck {
	if (daemon === null) return { ok: false, code: "DAEMON_CONTRACT_MISMATCH", reason: "daemon_missing", mismatches: [] };
	if (!hasDaemonContractIdentityShape(daemon)) return { ok: false, code: "DAEMON_CONTRACT_MISMATCH", reason: "identity_missing", mismatches: [] };
	const mismatches = DAEMON_CONTRACT_IDENTITY_FIELDS.flatMap((field): DaemonContractMismatch[] => (
		Object.is(local[field], daemon[field]) ? [] : [{ field, local: local[field], daemon: daemon[field] }]
	));
	return mismatches.length === 0
		? { ok: true, code: "DAEMON_CONTRACT_MATCH", reason: "match", mismatches }
		: { ok: false, code: "DAEMON_CONTRACT_MISMATCH", reason: "field_mismatch", mismatches };
}
