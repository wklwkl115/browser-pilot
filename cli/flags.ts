/**
 * Schema-driven CLI flag generation + argv parsing.
 *
 * A tool's TypeBox parameter schema is introspected into flag specs; argv is
 * collected into a raw object; then validateToolArgs (the shared frontend
 * validator) coerces/validates ("5" -> number, "true" -> boolean, enum/union
 * rejection) — we never re-implement coercion.
 */
import { validateToolArgs } from "../src/frontend/validation.js";

export type FlagKind = "string" | "number" | "boolean" | "enum" | "array" | "json";

export interface FlagSpec {
	name: string; // param name (camelCase), e.g. detailLevel
	flag: string; // --detail-level
	kind: FlagKind;
	choices?: string[];
	description?: string;
	required: boolean;
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
		return { kind: "string" }; // e.g. number|string union — let validateToolArgs coerce
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
export type ParseOutcome = { ok: true; value: ParsedArgs } | { ok: false; error: string };

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
	"--detail-level": "this command has no --detail-level; size output with --limit / --offset / --max-chars",
	// Action tools (wait/network/hook/frame) take per-action keys inside --params, not as flags. `selector`
	// is the one agents most often reach for as a flag (e.g. wait --action selector). Point at the shape.
	"--selector": "action tools (wait/hook/frame) take selector inside --params, e.g. --action selector --params '{\"selector\":\"#id\"}'",
};

/** Collect argv into a raw params object (string/bool/array/json), plus CLI globals. */
export function parseArgs(specs: FlagSpec[], argv: string[]): ParseOutcome {
	const byFlag = new Map<string, FlagSpec>();
	for (const s of specs) byFlag.set(s.flag, s);
	const raw: Record<string, unknown> = {};
	const globals: GlobalFlags = { json: false, text: false, help: false };
	for (let i = 0; i < argv.length; i += 1) {
		let token = argv[i];
		if (token === "--json") { globals.json = true; globals.text = false; continue; }
		if (token === "--text") { globals.text = true; globals.json = false; continue; }
		if (token === "--help" || token === "-h") { globals.help = true; continue; }
		if (!token.startsWith("--")) return { ok: false, error: `unexpected argument "${token}" (expected --flags)` };
		let inlineValue: string | undefined;
		const eq = token.indexOf("=");
		if (eq >= 0) { inlineValue = token.slice(eq + 1); token = token.slice(0, eq); }
		if (token.startsWith("--no-")) {
			const positive = byFlag.get(`--${token.slice(5)}`);
			if (positive?.kind === "boolean") { raw[positive.name] = false; continue; }
		}
		const spec = byFlag.get(token);
		if (!spec) {
			const flags = specs.map((s) => s.flag);
			const suggestion = suggestFlag(token, flags);
			const hint = ABSENT_FLAG_HINTS[token];
			const guidance = hint ? `${hint}. ` : suggestion ? `did you mean "${suggestion}"? ` : "";
			return { ok: false, error: `unknown flag "${token}"; ${guidance}accepted: ${flags.join(", ") || "(none)"}` };
		}
		if (spec.kind === "boolean") { raw[spec.name] = inlineValue === undefined ? true : inlineValue !== "false"; continue; }
		const value = inlineValue !== undefined ? inlineValue : argv[i += 1];
		if (value === undefined) return { ok: false, error: `flag "${spec.flag}" needs a value` };
		if (spec.kind === "enum" && spec.choices && !spec.choices.includes(value)) {
			return { ok: false, error: `flag "${spec.flag}" must be one of: ${spec.choices.join(", ")}` };
		}
		if (spec.kind === "array") {
			const arr = (raw[spec.name] as string[] | undefined) ?? [];
			arr.push(value);
			raw[spec.name] = arr;
		} else if (spec.kind === "json") {
			try { raw[spec.name] = JSON.parse(value); } catch { return { ok: false, error: `flag "${spec.flag}" expects JSON, got: ${value}` }; }
		} else {
			raw[spec.name] = value; // string/number/enum — validateToolArgs coerces below
		}
	}
	return { ok: true, value: { params: raw, globals } };
}

/** Coerce + validate raw params against the tool schema (reuses the frontend validator). */
export function coerceParams(schema: unknown, raw: Record<string, unknown>): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
	return validateToolArgs(schema, raw);
}
