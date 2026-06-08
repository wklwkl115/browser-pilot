import * as T from "typebox";
import { Value } from "typebox/value";

export type ValidationIssue = { path: Array<string | number>; message: string };
export type SafeParseResult<TValue> =
	| { success: true; data: TValue }
	| { success: false; error: { issues: ValidationIssue[] } };

export type ValidationSchema<TValue> = {
	readonly schema: T.TSchema;
	safeParse(value: unknown): SafeParseResult<TValue>;
};

type Transform<TValue> = (value: unknown) => TValue;
type Refinement<TValue> = { check: (value: TValue) => boolean; message: string };

function issuePath(error: { path?: string; params?: { missingProperty?: string } }): Array<string | number> {
	const parts = typeof error.path === "string" && error.path ? error.path.split("/").filter(Boolean) : [];
	const out = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : part));
	const missing = error.params?.missingProperty;
	if (typeof missing === "string" && missing) out.push(missing);
	return out;
}

function issueMessage(error: { message?: string; params?: { missingProperty?: string } }): string {
	const missing = error.params?.missingProperty;
	if (typeof missing === "string" && missing) return `${missing}: Required`;
	return typeof error.message === "string" && error.message ? error.message : "Invalid value";
}

export function createSchema<TValue>(schema: T.TSchema, options: { transform?: Transform<TValue>; refinements?: Refinement<TValue>[]; defaultValue?: unknown } = {}): ValidationSchema<TValue> {
	return {
		schema,
		safeParse(value: unknown): SafeParseResult<TValue> {
			const withDefaults = value === undefined && options.defaultValue !== undefined ? options.defaultValue : Value.Default(schema as never, value);
			const issues = [...Value.Errors(schema as never, withDefaults)].map((error) => ({
				path: issuePath(error as { path?: string; params?: { missingProperty?: string } }),
				message: issueMessage(error as { message?: string; params?: { missingProperty?: string } }),
			}));
			if (issues.length) return { success: false, error: { issues } };
			const data = (options.transform ? options.transform(withDefaults) : withDefaults) as TValue;
			for (const refinement of options.refinements ?? []) {
				if (!refinement.check(data)) return { success: false, error: { issues: [{ path: [], message: refinement.message }] } };
			}
			return { success: true, data };
		},
	};
}

export const Type = T;
