/**
 * Schema-driven CLI flag generation + argv parsing.
 *
 * A tool's TypeBox parameter schema is introspected into flag specs; argv is
 * collected into a raw object; then validateCommandArgs (the shared frontend
 * validator) coerces/validates ("5" -> number, "true" -> boolean, enum/union
 * rejection) — we never re-implement coercion.
 */
import { validateCommandArgs } from "../../validation/commandArgs.js";
import { readFileSync } from "node:fs";
import path from "node:path";

export type FlagKind = "string" | "number" | "boolean" | "enum" | "array" | "json";

export interface FlagSpec {
	name: string; // param name (camelCase), e.g. detailLevel
	flag: string; // --detail-level
	kind: FlagKind;
	choices?: string[];
	description?: string;
	required: boolean;
	split?: "comma";
	valueReferences?: boolean;
}

export interface GlobalFlags {
	json: boolean;
	text: boolean;
	help: boolean;
}

interface JsonSchemaProp {
	type?: string;
	anyOf?: Array<{ const?: unknown; type?: string }>;
	description?: string;
}

function kebab(name: string): string {
	return name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function schemaParts(schema: unknown): { properties: Record<string, JsonSchemaProp>; required: string[] } {
	const s = (schema && typeof schema === "object" ? schema : {}) as { properties?: Record<string, JsonSchemaProp>; required?: unknown };
	return { properties: s.properties ?? {}, required: Array.isArray(s.required) ? (s.required as string[]) : [] };
}

function flagKind(prop: JsonSchemaProp): { kind: FlagKind; choices?: string[] } {
	if (prop.type === "boolean") return { kind: "boolean" };
	if (prop.type === "number" || prop.type === "integer") return { kind: "number" };
	if (prop.type === "array") return { kind: "array" };
	if (prop.type === "object") return { kind: "json" };
	if (Array.isArray(prop.anyOf) && prop.anyOf.length) {
		const consts = prop.anyOf.map((m) => m.const).filter((c) => c !== undefined);
		if (consts.length === prop.anyOf.length) return { kind: "enum", choices: consts.map((c) => String(c)) };
		return { kind: "string" }; // e.g. number|string union — let validateCommandArgs coerce
	}
	return { kind: "string" };
}

export function buildFlagSpecs(schema: unknown): FlagSpec[] {
	const { properties, required } = schemaParts(schema);
	return Object.entries(properties).map(([name, prop]) => {
		const { kind, choices } = flagKind(prop);
		return { name, flag: `--${kebab(name)}`, kind, choices, description: prop.description, required: required.includes(name) };
	});
}

export interface ParsedArgs {
	params: Record<string, unknown>;
	globals: GlobalFlags;
}
export type ParseOutcome = { ok: true; value: ParsedArgs } | { ok: false; error: string; globals: GlobalFlags };

export function wantsJson(argv: string[]): boolean {
	let json = false;
	for (const token of argv) {
		if (token === "--json") json = true;
		if (token === "--text") json = false;
	}
	return json;
}

function readValueReference(value: string, cwd = process.cwd()): { ok: true; value: string } | { ok: false; error: string } {
	if (value === "-") {
		try {
			return { ok: true, value: readFileSync(0, "utf8") };
		} catch (error) {
			return { ok: false, error: `cannot read stdin: ${error instanceof Error ? error.message : String(error)}` };
		}
	}
	if (!value.startsWith("@") || value === "@") return { ok: true, value };
	const filePath = path.resolve(cwd, value.slice(1));
	try {
		return { ok: true, value: readFileSync(filePath, "utf8") };
	} catch (error) {
		return { ok: false, error: `cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function parseArrayValue(text: string): unknown[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith("[")) {
		const parsed = JSON.parse(trimmed) as unknown;
		if (!Array.isArray(parsed)) throw new Error("expected JSON array");
		return parsed;
	}
	return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function resolveParamValueReferences(
	specs: FlagSpec[],
	raw: Record<string, unknown>,
	cwd = process.cwd(),
): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
	const byName = new Map(specs.map((spec) => [spec.name, spec]));
	const params: Record<string, unknown> = { ...raw };
	for (const [name, value] of Object.entries(raw)) {
		if (typeof value !== "string" || (value !== "-" && !value.startsWith("@"))) continue;
		const spec = byName.get(name);
		if (!spec || !["json", "array", "string"].includes(spec.kind) || spec.valueReferences === false) continue;
		const parsedValue = parseFlagValue(spec, value, cwd);
		if (!parsedValue.ok) return { ok: false, error: parsedValue.error };
		params[name] = parsedValue.value;
	}
	return { ok: true, params };
}

function parseFlagValue(spec: FlagSpec, value: string, cwd = process.cwd()): { ok: true; value: unknown } | { ok: false; error: string } {
	const referenced = readValueReference(value, cwd);
	if (!referenced.ok) return referenced;
	const resolved = referenced.value;
	if (spec.kind === "json") {
		try {
			return { ok: true, value: JSON.parse(resolved) };
		} catch {
			return { ok: false, error: `flag "${spec.flag}" expects JSON, got: ${value}` };
		}
	}
	if (spec.kind === "array" && (value === "-" || value.startsWith("@"))) {
		try {
			return { ok: true, value: parseArrayValue(resolved) };
		} catch (error) {
			return { ok: false, error: `flag "${spec.flag}" expects a JSON array or newline list, got ${value}: ${error instanceof Error ? error.message : String(error)}` };
		}
	}
	return { ok: true, value: resolved };
}

function normalizeFlag(flag: string): string { return flag.replace(/[^a-z0-9]/gi, "").toLowerCase(); }

function editDistance(a: string, b: string): number {
	const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i += 1) {
		let diag = prev[0];
		prev[0] = i;
		for (let j = 1; j <= b.length; j += 1) {
			const tmp = prev[j];
			prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
			diag = tmp;
		}
	}
	return prev[b.length];
}

/** Suggest the closest valid flag for a typo: exact match on the normalized form catches
 *  camelCase↔kebab (e.g. --jsonPath → --json-path), then nearest by edit distance ≤ 2. */
function suggestFlag(token: string, flags: string[]): string | undefined {
	const norm = normalizeFlag(token);
	const exact = flags.find((flag) => normalizeFlag(flag) === norm);
	if (exact) return exact;
	let best: string | undefined;
	let bestDistance = 3;
	for (const flag of flags) {
		const distance = editDistance(norm, normalizeFlag(flag));
		if (distance < bestDistance) { bestDistance = distance; best = flag; }
	}
	return bestDistance <= 2 ? best : undefined;
}

// Common flags some commands legitimately do NOT accept — point at the right knob instead of just
// dumping the accepted list (e.g. browser_artifact has no --detail-level; it sizes with --limit/etc).
const ABSENT_FLAG_HINTS: Record<string, string> = {
	"--browser-session-id": "browserSessionId is managed internally; use browser-pilot tabs for session management.",
	"--detail-level": "detailLevel is internal now; request narrower artifact reads with --limit / --offset / --max-chars / --json-path.",
	"--max-chars": "maxChars is internal now; request narrower artifact reads with --limit / --offset / --json-path.",
	"--timeout-ms": "timeoutMs is internal now; use operator config/env for global timeout changes.",
	"--output-path": "outputPath is internal now; read saved.path from the result.",
	"--max-body-bytes": "maxBodyBytes is internal now; inspect saved artifacts for full bounded evidence.",
	"--max-depth": "maxDepth is internal now; use the tool's scoped target parameters instead.",
	"--max-pages": "maxPages is internal now; use the tool's scoped target parameters instead.",
	"--max-cases": "maxCases is internal now; use the tool's scoped target parameters instead.",
	"--max-candidates": "maxCandidates is internal now; use the tool's scoped target parameters instead.",
	"--max-templates": "maxTemplates is internal now; use the tool's scoped target parameters instead.",
	"--rate-limit-per-second": "rateLimitPerSecond is internal now; use operator config/env for global rate changes.",
	"--timeout-seconds": "timeoutSeconds is internal now; use operator config/env for global timeout changes.",
	"--har-max-entries": "harMaxEntries is internal now; narrow the HAR source with --har-entry-index or --har-url-pattern.",
	"--follow-redirects": "followRedirects is internal now; use the tool's default replay/crawl behavior.",
	"--max-redirects": "maxRedirects is internal now; use the tool's default replay/crawl behavior.",
	"--default-scheme": "defaultScheme is internal now; pass an absolute http:// or https:// URL when the scheme matters.",
	"--cookie-mode": "cookieMode is internal now; bindBrowserSession merges browser cookies by default.",
	// Action tools (wait/network/hook/frame) take per-action keys inside --params, not as flags. `selector`
	// is the one agents most often reach for as a flag (e.g. wait --action selector). Point at the shape.
	"--selector": "action tools (wait/hook/frame) take selector inside --params, e.g. --action selector --params '{\"selector\":\"#id\"}'",
};

function unknownFlagError(token: string, specs: FlagSpec[]): string {
	const flags = specs.map((spec) => spec.flag);
	const suggestion = suggestFlag(token, flags);
	const guidance = ABSENT_FLAG_HINTS[token] ? `${ABSENT_FLAG_HINTS[token]}. ` : suggestion ? `did you mean "${suggestion}"? ` : "";
	return `unknown flag "${token}"; ${guidance}accepted: ${flags.join(", ") || "(none)"}`;
}

function assignFlagValue(raw: Record<string, unknown>, spec: FlagSpec, value: string, cwd: string): { ok: true } | { ok: false; error: string } {
	if (spec.kind === "enum" && spec.choices && !spec.choices.includes(value)) return { ok: false, error: `flag "${spec.flag}" must be one of: ${spec.choices.join(", ")}` };
	if (spec.kind === "json" && spec.valueReferences === false && (value === "-" || value.startsWith("@"))) return { ok: false, error: `flag "${spec.flag}" expects inline JSON; file references are not supported for this flag` };
	const parsed = parseFlagValue(spec, value, cwd);
	if (!parsed.ok) return parsed;
	if (spec.kind !== "array") {
		raw[spec.name] = parsed.value;
		return { ok: true };
	}
	const array = (raw[spec.name] as unknown[] | undefined) ?? [];
	const isReference = value === "-" || value.startsWith("@");
	if (Array.isArray(parsed.value) && isReference) array.push(...parsed.value);
	else if (spec.split === "comma") array.push(...String(parsed.value).split(",").map((item) => item.trim()).filter(Boolean));
	else array.push(String(parsed.value));
	raw[spec.name] = array;
	return { ok: true };
}

/** Collect argv into a raw params object (string/bool/array/json), plus CLI globals. */
export function parseArgs(specs: FlagSpec[], argv: string[], cwd = process.cwd()): ParseOutcome {
	const byFlag = new Map(specs.map((spec) => [spec.flag, spec]));
	const raw: Record<string, unknown> = {};
	const globals: GlobalFlags = { json: false, text: false, help: false };
	const fail = (error: string): ParseOutcome => ({ ok: false, error, globals: { ...globals } });
	for (let i = 0; i < argv.length; i += 1) {
		let token = argv[i];
		if (token === "--json") { globals.json = true; globals.text = false; continue; }
		if (token === "--text") { globals.text = true; globals.json = false; continue; }
		if (token === "--help" || token === "-h") { globals.help = true; continue; }
		if (!token.startsWith("--")) return fail(`unexpected argument "${token}" (expected --flags)`);
		let inlineValue: string | undefined;
		const eq = token.indexOf("=");
		if (eq >= 0) { inlineValue = token.slice(eq + 1); token = token.slice(0, eq); }
		if (token.startsWith("--no-")) {
			const positive = byFlag.get(`--${token.slice(5)}`);
			if (positive?.kind === "boolean") { raw[positive.name] = false; continue; }
		}
		const spec = byFlag.get(token);
		if (!spec) return fail(unknownFlagError(token, specs));
		if (spec.kind === "boolean") { raw[spec.name] = inlineValue === undefined ? true : inlineValue !== "false"; continue; }
		const value = inlineValue !== undefined ? inlineValue : argv[i += 1];
		if (value === undefined) return fail(`flag "${spec.flag}" needs a value`);
		const assigned = assignFlagValue(raw, spec, value, cwd);
		if (!assigned.ok) return fail(assigned.error);
	}
	return { ok: true, value: { params: raw, globals } };
}

/** Coerce + validate raw params against the command schema (reuses the command validator). */
export function coerceParams(schema: unknown, raw: Record<string, unknown>): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
	return validateCommandArgs(schema, raw);
}
