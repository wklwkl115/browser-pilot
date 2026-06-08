import { createSchema, Type } from "./typeboxCompat.js";

/**
 * Validation schemas for runtime type checking.
 * These use TypeBox internally and expose the small safeParse surface consumed by
 * existing tool validators.
 */

export type ValidatedBridgeCommand = {
	cmd: string;
	method?: string;
	action?: string;
	params?: Record<string, unknown>;
	cdpMethod?: string;
	cdpParams?: Record<string, unknown>;
	[key: string]: unknown;
};

export const BridgeCommandSchema = createSchema<ValidatedBridgeCommand>(Type.Object({
	cmd: Type.String({ minLength: 1 }),
	method: Type.Optional(Type.String()),
	action: Type.Optional(Type.String()),
	params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	cdpMethod: Type.Optional(Type.String()),
	cdpParams: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: true }));

const HttpMethodSchema = Type.Union(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "CONNECT", "TRACE"].map((method) => Type.Literal(method)));

export type ValidatedHttpRequest = {
	url: string;
	method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" | "CONNECT" | "TRACE";
	headers?: Record<string, string>;
	body?: string;
	bodyBase64?: string;
};

function validUrl(value: string): boolean {
	try { new URL(value); return true; } catch { return false; }
}

export const HttpRequestSchema = createSchema<ValidatedHttpRequest>(Type.Object({
	url: Type.String(),
	method: Type.Optional(HttpMethodSchema),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	body: Type.Optional(Type.String()),
	bodyBase64: Type.Optional(Type.String()),
}, { additionalProperties: false }), {
	transform: (value) => ({ method: "GET", ...(value as Omit<ValidatedHttpRequest, "method"> & { method?: ValidatedHttpRequest["method"] }) }),
	refinements: [{ check: (value) => validUrl(value.url), message: "Invalid URL format" }],
});

export const MultipartFieldSchema = createSchema(Type.Object({
	name: Type.String({ minLength: 1 }),
	value: Type.String(),
	contentType: Type.Optional(Type.String()),
}, { additionalProperties: false }));

const MultipartFieldType = MultipartFieldSchema.schema;
const MultipartFileType = Type.Object({
	name: Type.String({ minLength: 1 }),
	filename: Type.String({ minLength: 1 }),
	content: Type.Optional(Type.String()),
	contentBase64: Type.Optional(Type.String()),
	contentType: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const MultipartFileSchema = createSchema(MultipartFileType, {
	refinements: [{ check: (value: Record<string, unknown>) => value.content !== undefined || value.contentBase64 !== undefined, message: "Either content or contentBase64 must be provided" }],
});

export type ValidatedMultipart = {
	fields?: Array<{ name: string; value: string; contentType?: string }>;
	files?: Array<{ name: string; filename: string; content?: string; contentBase64?: string; contentType?: string }>;
};

export const MultipartSchema = createSchema<ValidatedMultipart>(Type.Object({
	fields: Type.Optional(Type.Array(MultipartFieldType)),
	files: Type.Optional(Type.Array(MultipartFileType)),
}, { additionalProperties: false }), {
	refinements: [{
		check: (value) => (value.files ?? []).every((file) => file.content !== undefined || file.contentBase64 !== undefined),
		message: "Either content or contentBase64 must be provided",
	}],
});

export type ValidatedFuzzMutations = {
	url?: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	bodyBase64?: string;
	multipart?: ValidatedMultipart;
};

export const FuzzMutationsSchema = createSchema<ValidatedFuzzMutations>(Type.Object({
	url: Type.Optional(Type.String()),
	method: Type.Optional(Type.String()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	body: Type.Optional(Type.String()),
	bodyBase64: Type.Optional(Type.String()),
	multipart: Type.Optional(MultipartSchema.schema),
}, { additionalProperties: false }), {
	refinements: [{ check: (value) => value.url === undefined || validUrl(value.url), message: "Invalid URL format" }],
});

export type ValidatedCookie = {
	name: string;
	value: string;
	domain?: string;
	path?: string;
	expires?: number | string;
	httpOnly?: boolean;
	secure?: boolean;
	sameSite?: "Strict" | "Lax" | "None";
	[key: string]: unknown;
};

const CookieType = Type.Object({
	name: Type.String({ minLength: 1 }),
	value: Type.String(),
	domain: Type.Optional(Type.String()),
	path: Type.Optional(Type.String()),
	expires: Type.Optional(Type.Union([Type.Number(), Type.String()])),
	httpOnly: Type.Optional(Type.Boolean()),
	secure: Type.Optional(Type.Boolean()),
	sameSite: Type.Optional(Type.Union([Type.Literal("Strict"), Type.Literal("Lax"), Type.Literal("None")])),
}, { additionalProperties: true });

export const CookieSchema = createSchema<ValidatedCookie>(CookieType);
export const SetCookieSchema = createSchema<string>(Type.String({ minLength: 1 }));
export const CookiesInputSchema = createSchema<string | string[] | ValidatedCookie[] | Record<string, string>>(Type.Union([
	Type.String(),
	Type.Array(Type.String()),
	Type.Array(CookieType),
	Type.Record(Type.String(), Type.String()),
]));

export type ValidatedClaimMutations = Record<string, unknown>;
export const ClaimMutationsSchema = createSchema<ValidatedClaimMutations>(Type.Record(Type.String(), Type.Unknown()), {
	refinements: [{ check: (value) => Object.keys(value).length > 0, message: "Claim mutations cannot be empty" }],
});

const TemplateMatcherType = Type.Object({
	type: Type.Union([Type.Literal("status"), Type.Literal("regex"), Type.Literal("word"), Type.Literal("dsl")]),
	status: Type.Optional(Type.Array(Type.Number())),
	regex: Type.Optional(Type.Array(Type.String())),
	words: Type.Optional(Type.Array(Type.String())),
	condition: Type.Optional(Type.Union([Type.Literal("and"), Type.Literal("or")])),
	part: Type.Optional(Type.Union([Type.Literal("body"), Type.Literal("header"), Type.Literal("all")])),
	negative: Type.Optional(Type.Boolean()),
}, { additionalProperties: true });

export const TemplateMatcherSchema = createSchema(TemplateMatcherType);

const TemplateExtractorType = Type.Object({
	type: Type.Union([Type.Literal("regex"), Type.Literal("kval"), Type.Literal("json"), Type.Literal("xpath")]),
	name: Type.Optional(Type.String()),
	regex: Type.Optional(Type.Array(Type.String())),
	group: Type.Optional(Type.Number()),
	kval: Type.Optional(Type.Array(Type.String())),
	json: Type.Optional(Type.Array(Type.String())),
	xpath: Type.Optional(Type.Array(Type.String())),
	part: Type.Optional(Type.Union([Type.Literal("body"), Type.Literal("header"), Type.Literal("all")])),
	internal: Type.Optional(Type.Boolean()),
}, { additionalProperties: true });

export const TemplateExtractorSchema = createSchema(TemplateExtractorType);

const TemplateType = Type.Object({
	id: Type.String({ minLength: 1 }),
	info: Type.Optional(Type.Object({
		name: Type.Optional(Type.String()),
		author: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
		severity: Type.Optional(Type.Union([Type.Literal("info"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")])),
		description: Type.Optional(Type.String()),
		tags: Type.Optional(Type.Array(Type.String())),
	}, { additionalProperties: false })),
	requests: Type.Optional(Type.Array(Type.Object({
		method: Type.Optional(Type.String()),
		path: Type.Optional(Type.Array(Type.String())),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		body: Type.Optional(Type.String()),
		matchers: Type.Optional(Type.Array(TemplateMatcherType)),
		extractors: Type.Optional(Type.Array(TemplateExtractorType)),
	}, { additionalProperties: true }))),
}, { additionalProperties: true });

export type ValidatedTemplate = Record<string, unknown> & { id: string };
export const TemplateSchema = createSchema<ValidatedTemplate>(TemplateType);
const TemplatesInputType = Type.Union([
	TemplateType,
	Type.Array(TemplateType),
	Type.Object({ templates: Type.Array(TemplateType) }, { additionalProperties: false }),
]);
export const TemplatesInputSchema = createSchema<ValidatedTemplate | ValidatedTemplate[] | { templates: ValidatedTemplate[] }>(TemplatesInputType);
export const TemplatesSchema = TemplatesInputSchema;

export type ValidatedVariables = Record<string, string | number | boolean | null>;
export const VariablesSchema = createSchema<ValidatedVariables>(Type.Record(Type.String(), Type.Union([
	Type.String(),
	Type.Number(),
	Type.Boolean(),
	Type.Null(),
])));

export type ValidatedJsonValues = Record<string, unknown>;
export const JsonValuesSchema = createSchema<ValidatedJsonValues>(Type.Record(Type.String(), Type.Unknown()));
export const TechHintsSchema = createSchema<Record<string, unknown>>(Type.Record(Type.String(), Type.Unknown()));
