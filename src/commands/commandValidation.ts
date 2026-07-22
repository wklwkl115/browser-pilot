import { validateCommandArgs } from "../validation/commandArgs.js";
import { isRecord } from "../utils/records.js";
import type { BrowserCommandDefinition, ValidationIssue } from "./commandDefinition.js";

export type BrowserCommandValidationResult =
	| { ok: true; args: Record<string, unknown> }
	| { ok: false; error: string; issues: ValidationIssue[] };

const DEFAULT_REMOVED_ARGUMENTS = new Set([
	"browserSessionId",
	"detailLevel",
	"maxChars",
	"timeoutMs",
	"outputPath",
	"maxBodyBytes",
	"maxDepth",
	"maxPages",
	"maxCases",
	"maxCandidates",
	"maxTemplates",
	"rateLimitPerSecond",
	"timeoutSeconds",
	"harMaxEntries",
	"followRedirects",
	"maxRedirects",
	"defaultScheme",
	"cookieMode",
	"redact",
	"monitor",
]);

const DEFAULT_INTERNAL_ARGUMENTS = new Set(["modeExplicit", "operationId", "toolCallId"]);

function jsonPointer(key: string): string {
	return `/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

function schemaProperties(schema: unknown): Set<string> {
	if (!isRecord(schema) || !isRecord(schema.properties)) return new Set();
	return new Set(Object.keys(schema.properties));
}

function keyIssues(definition: BrowserCommandDefinition, args: Record<string, unknown>): ValidationIssue[] {
	const accepted = schemaProperties(definition.parameters);
	const removed = new Set([...DEFAULT_REMOVED_ARGUMENTS, ...(definition.removedArguments ?? [])]);
	const internal = new Set([...DEFAULT_INTERNAL_ARGUMENTS, ...(definition.internalArguments ?? [])]);
	const issues: ValidationIssue[] = [];
	for (const key of Object.keys(args)) {
		if (accepted.has(key)) continue;
		const path = jsonPointer(key);
		if (internal.has(key)) {
			issues.push({ code: "INTERNAL_ARGUMENT", path, message: `Argument "${key}" is internal and cannot be supplied` });
		} else if (removed.has(key)) {
			issues.push({ code: "REMOVED_ARGUMENT", path, message: `Argument "${key}" has been removed` });
		} else {
			issues.push({ code: "UNKNOWN_ARGUMENT", path, message: `Unknown argument "${key}"` });
		}
	}
	return issues;
}

export function formatValidationIssues(issues: readonly ValidationIssue[]): string {
	return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

function failure(issues: ValidationIssue[]): BrowserCommandValidationResult {
	return { ok: false, issues, error: `Invalid parameters — ${formatValidationIssues(issues)}` };
}

/**
 * Shared pure validation pipeline used by MCP and daemon invocation.
 * every remaining normalization step is command-owned and side-effect free.
 */
export function validateBrowserCommandArguments(definition: BrowserCommandDefinition, rawArgs: unknown): BrowserCommandValidationResult {
	if (!isRecord(rawArgs)) return failure([{ code: "ARGUMENTS_OBJECT_REQUIRED", path: "/", message: "Command arguments must be an object" }]);
	const keyValidation = keyIssues(definition, rawArgs);
	if (keyValidation.length) return failure(keyValidation);

	let normalized = structuredClone(rawArgs);
	try {
		if (definition.coerceArguments) normalized = definition.coerceArguments(normalized);
	} catch (error) {
		return failure([{ code: "ARGUMENT_COERCION_FAILED", path: "/", message: error instanceof Error ? error.message : String(error) }]);
	}
	if (!isRecord(normalized)) return failure([{ code: "ARGUMENT_COERCION_FAILED", path: "/", message: "Canonical argument coercion must return an object" }]);

	const schema = validateCommandArgs(definition.parameters, normalized);
	if (!schema.ok) return { ok: false, error: schema.error, issues: schema.issues };
	const semanticIssues = definition.validateArguments?.(schema.args) ?? [];
	return semanticIssues.length ? failure(semanticIssues) : { ok: true, args: schema.args };
}
