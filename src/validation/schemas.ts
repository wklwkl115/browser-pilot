import { z } from 'zod';

/**
 * Validation schemas for runtime type checking.
 * These schemas complement TypeBox schemas used for MCP protocol definitions.
 */

// ============================================================================
// Bridge Command Schema
// ============================================================================

/**
 * Schema for validating bridge commands sent to the browser extension.
 * Replaces broad untyped command input in browser_command.
 */
export const BridgeCommandSchema = z.object({
	cmd: z.string().min(1, { message: 'Command name is required' }),
	method: z.string().optional(),
	action: z.string().optional(),
	params: z.record(z.string(), z.unknown()).optional(),
	// CDP-specific fields
	cdpMethod: z.string().optional(),
	cdpParams: z.record(z.string(), z.unknown()).optional(),
	// Allow additional fields for extensibility
}).passthrough();

export type ValidatedBridgeCommand = z.infer<typeof BridgeCommandSchema>;

// ============================================================================
// HTTP Request Schema
// ============================================================================

/**
 * Schema for validating HTTP request objects.
 * Used in browser_http_replay, browser_fuzz, and other web security tools.
 */
export const HttpRequestSchema = z.object({
	url: z.string().url('Invalid URL format'),
	method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE']).default('GET'),
	headers: z.record(z.string(), z.string()).optional(),
	body: z.string().optional(),
	bodyBase64: z.string().optional(),
}).strict();

export type ValidatedHttpRequest = z.infer<typeof HttpRequestSchema>;

// ============================================================================
// Multipart Schema
// ============================================================================

/**
 * Schema for validating multipart form data.
 * Used in browser_http_replay and browser_fuzz for file uploads.
 */
export const MultipartFieldSchema = z.object({
	name: z.string().min(1, { message: 'Field name is required' }),
	value: z.string(),
	contentType: z.string().optional(),
});

export const MultipartFileSchema = z.object({
	name: z.string().min(1, { message: 'File field name is required' }),
	filename: z.string().min(1, { message: 'Filename is required' }),
	content: z.string().optional(),
	contentBase64: z.string().optional(),
	contentType: z.string().optional(),
}).refine(
	(data) => data.content !== undefined || data.contentBase64 !== undefined,
	{ message: 'Either content or contentBase64 must be provided' }
);

export const MultipartSchema = z.object({
	fields: z.array(MultipartFieldSchema).optional(),
	files: z.array(MultipartFileSchema).optional(),
}).strict();

export type ValidatedMultipart = z.infer<typeof MultipartSchema>;

// ============================================================================
// Fuzz Mutations Schema
// ============================================================================

/**
 * Schema for validating fuzz mutation objects.
 * Used in browser_fuzz for parameter fuzzing.
 */
export const FuzzMutationsSchema = z.object({
	url: z.string().url().optional(),
	method: z.string().optional(),
	headers: z.record(z.string(), z.string()).optional(),
	body: z.string().optional(),
	bodyBase64: z.string().optional(),
	multipart: MultipartSchema.optional(),
}).strict();

export type ValidatedFuzzMutations = z.infer<typeof FuzzMutationsSchema>;

// ============================================================================
// Cookie Schema
// ============================================================================

/**
 * Schema for validating cookie objects.
 * Used in browser_cookie_analyze for cookie parsing and analysis.
 */
export const CookieSchema = z.object({
	name: z.string().min(1, { message: 'Cookie name is required' }),
	value: z.string(),
	domain: z.string().optional(),
	path: z.string().optional(),
	expires: z.union([z.number(), z.string()]).optional(),
	httpOnly: z.boolean().optional(),
	secure: z.boolean().optional(),
	sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
}).passthrough(); // Allow additional browser-specific fields

export const SetCookieSchema = z.string().min(1, { message: 'Set-Cookie header cannot be empty' });

export const CookiesInputSchema = z.union([
	z.string(), // Cookie header string
	z.array(z.string()), // Array of cookie strings
	z.array(CookieSchema), // Array of cookie objects
	z.record(z.string(), z.string()), // Object with name-value pairs
]);

export type ValidatedCookie = z.infer<typeof CookieSchema>;

// ============================================================================
// JWT/Claim Mutations Schema
// ============================================================================

/**
 * Schema for validating JWT claim mutations.
 * Used in browser_cookie_analyze for JWT manipulation.
 */
export const ClaimMutationsSchema = z.record(z.string(), z.unknown()).refine(
	(data) => Object.keys(data).length > 0,
	{ message: 'Claim mutations cannot be empty' }
);

export type ValidatedClaimMutations = z.infer<typeof ClaimMutationsSchema>;

// ============================================================================
// Template Schema
// ============================================================================

/**
 * Schema for validating template objects.
 * Used in browser_template for custom template checks.
 */
export const TemplateMatcherSchema = z.object({
	type: z.enum(['status', 'regex', 'word', 'dsl']),
	status: z.array(z.number()).optional(),
	regex: z.array(z.string()).optional(),
	words: z.array(z.string()).optional(),
	condition: z.enum(['and', 'or']).optional(),
	part: z.enum(['body', 'header', 'all']).optional(),
	negative: z.boolean().optional(),
}).passthrough();

export const TemplateExtractorSchema = z.object({
	type: z.enum(['regex', 'kval', 'json', 'xpath']),
	name: z.string().optional(),
	regex: z.array(z.string()).optional(),
	group: z.number().optional(),
	kval: z.array(z.string()).optional(),
	json: z.array(z.string()).optional(),
	xpath: z.array(z.string()).optional(),
	part: z.enum(['body', 'header', 'all']).optional(),
	internal: z.boolean().optional(),
}).passthrough();

export const TemplateSchema = z.object({
	id: z.string().min(1, { message: 'Template ID is required' }),
	info: z.object({
		name: z.string().optional(),
		author: z.union([z.string(), z.array(z.string())]).optional(),
		severity: z.enum(['info', 'low', 'medium', 'high', 'critical']).optional(),
		description: z.string().optional(),
		tags: z.array(z.string()).optional(),
	}).optional(),
	requests: z.array(z.object({
		method: z.string().optional(),
		path: z.array(z.string()).optional(),
		headers: z.record(z.string(), z.string()).optional(),
		body: z.string().optional(),
		matchers: z.array(TemplateMatcherSchema).optional(),
		extractors: z.array(TemplateExtractorSchema).optional(),
	}).passthrough()).optional(),
	// Allow additional nuclei-specific fields
}).passthrough();

export const TemplatesInputSchema = z.union([
	TemplateSchema, // Single template
	z.array(TemplateSchema), // Array of templates
	z.object({ templates: z.array(TemplateSchema) }), // Wrapped in object
]);

export type ValidatedTemplate = z.infer<typeof TemplateSchema>;

// ============================================================================
// Variables Schema
// ============================================================================

/**
 * Schema for validating template variables.
 * Used in browser_template and browser_http_replay for variable substitution.
 */
export const VariablesSchema = z.record(z.string(), z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.null(),
]));

export type ValidatedVariables = z.infer<typeof VariablesSchema>;

// ============================================================================
// JSON Values Schema
// ============================================================================

/**
 * Schema for validating JSON values for parameter fuzzing.
 * Used in browser_fuzz for JSON parameter injection.
 */
export const JsonValuesSchema = z.record(z.string(), z.unknown());

export type ValidatedJsonValues = z.infer<typeof JsonValuesSchema>;

// ============================================================================
// Aliases for Web Security Tools
// ============================================================================

/**
 * Alias for TemplatesInputSchema - used in browser_template
 */
export const TemplatesSchema = TemplatesInputSchema;

/**
 * Schema for technology hints - used in browser_template
 */
export const TechHintsSchema = z.record(z.string(), z.unknown());
