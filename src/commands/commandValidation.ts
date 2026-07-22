import { validateCommandArgs } from "../validation/commandArgs.js";
import { isRecord } from "../utils/records.js";
import type { BrowserCommandDefinition, ValidationIssue } from "./commandDefinition.js";

export type BrowserCommandValidationResult =
	| { ok: true; args: Record<string, unknown> }
	| { ok: false; error: string; issues: ValidationIssue[] };

function jsonPointer(key: string): string {
	return `/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

function schemaProperties(schema: unknown): Set<string> {
	if (!isRecord(schema) || !isRecord(schema.properties)) return new Set();
	return new Set(Object.keys(schema.properties));
}

function keyIssues(definition: BrowserCommandDefinition, args: Record<string, unknown>): ValidationIssue[] {
	const accepted = schemaProperties(definition.parameters);
	const issues: ValidationIssue[] = [];
	for (const key of Object.keys(args)) {
		if (accepted.has(key)) continue;
		const path = jsonPointer(key);
		issues.push({ code: "UNKNOWN_ARGUMENT", path, message: `Unknown argument "${key}"` });
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
 * Validation is side-effect free and never strips unknown keys.
 */
export function validateBrowserCommandArguments(definition: BrowserCommandDefinition, rawArgs: unknown): BrowserCommandValidationResult {
	if (!isRecord(rawArgs)) return failure([{ code: "ARGUMENTS_OBJECT_REQUIRED", path: "/", message: "Command arguments must be an object" }]);
	const keyValidation = keyIssues(definition, rawArgs);
	if (keyValidation.length) return failure(keyValidation);

	const schema = validateCommandArgs(definition.parameters, rawArgs);
	if (!schema.ok) return { ok: false, error: schema.error, issues: schema.issues };
	const semanticIssues = definition.validateArguments?.(schema.args) ?? [];
	return semanticIssues.length ? failure(semanticIssues) : { ok: true, args: schema.args };
}
