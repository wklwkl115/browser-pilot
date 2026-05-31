import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	BridgeCommandSchema,
	HttpRequestSchema,
	MultipartSchema,
	FuzzMutationsSchema,
	CookieSchema,
	CookiesInputSchema,
	ClaimMutationsSchema,
	TemplateSchema,
	VariablesSchema,
	JsonValuesSchema,
} from '../../../src/validation/schemas.ts';

describe('BridgeCommandSchema', () => {
	it('validates valid bridge command', () => {
		const valid = {
			cmd: 'tabs',
			method: 'list',
			params: { includeDisconnected: true },
		};
		const result = BridgeCommandSchema.safeParse(valid);
		assert.ok(result.success);
		assert.equal(result.data.cmd, 'tabs');
	});

	it('rejects command without cmd field', () => {
		const invalid = { method: 'list' };
		const result = BridgeCommandSchema.safeParse(invalid);
		assert.ok(!result.success);
	});

	it('rejects empty cmd string', () => {
		const invalid = { cmd: '' };
		const result = BridgeCommandSchema.safeParse(invalid);
		assert.ok(!result.success);
	});

	it('allows additional fields (passthrough)', () => {
		const valid = {
			cmd: 'cdp',
			cdpMethod: 'Page.navigate',
			cdpParams: { url: 'https://example.com' },
			customField: 'allowed',
		};
		const result = BridgeCommandSchema.safeParse(valid);
		assert.ok(result.success);
		assert.equal(result.data.customField, 'allowed');
	});
});

describe('HttpRequestSchema', () => {
	it('validates valid HTTP request', () => {
		const valid = {
			url: 'https://example.com/api',
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{"key":"value"}',
		};
		const result = HttpRequestSchema.safeParse(valid);
		assert.ok(result.success);
	});

	it('rejects invalid URL', () => {
		const invalid = { url: 'not-a-url', method: 'GET' };
		const result = HttpRequestSchema.safeParse(invalid);
		assert.ok(!result.success);
	});

	it('rejects invalid HTTP method', () => {
		const invalid = { url: 'https://example.com', method: 'INVALID' };
		const result = HttpRequestSchema.safeParse(invalid);
		assert.ok(!result.success);
	});

	it('defaults method to GET', () => {
		const valid = { url: 'https://example.com' };
		const result = HttpRequestSchema.safeParse(valid);
		assert.ok(result.success);
		assert.equal(result.data.method, 'GET');
	});

	it('rejects additional fields (strict)', () => {
		const invalid = {
			url: 'https://example.com',
			method: 'GET',
			extraField: 'not-allowed',
		};
		const result = HttpRequestSchema.safeParse(invalid);
		assert.ok(!result.success);
	});
});

describe('MultipartSchema', () => {
	it('validates valid multipart with fields', () => {
		const valid = {
			fields: [
				{ name: 'username', value: 'test' },
				{ name: 'email', value: 'test@example.com' },
			],
		};
		const result = MultipartSchema.safeParse(valid);
		assert.ok(result.success);
	});

	it('validates valid multipart with files', () => {
		const valid = {
			files: [
				{ name: 'upload', filename: 'test.txt', content: 'file content' },
			],
		};
		const result = MultipartSchema.safeParse(valid);
		assert.ok(result.success);
	});

	it('rejects file without content or contentBase64', () => {
		const invalid = {
			files: [{ name: 'upload', filename: 'test.txt' }],
		};
		const result = MultipartSchema.safeParse(invalid);
		assert.ok(!result.success);
	});

	it('accepts file with contentBase64', () => {
		const valid = {
			files: [
				{ name: 'upload', filename: 'test.txt', contentBase64: 'dGVzdA==' },
			],
		};
		const result = MultipartSchema.safeParse(valid);
		assert.ok(result.success);
	});
});

describe('FuzzMutationsSchema', () => {
	it('validates valid fuzz mutations', () => {
		const valid = {
			url: 'https://example.com/api',
			method: 'POST',
			headers: { 'X-Custom': 'value' },
			body: 'mutated body',
		};
		const result = FuzzMutationsSchema.safeParse(valid);
		assert.ok(result.success);
	});

	it('allows empty mutations object', () => {
		const valid = {};
		const result = FuzzMutationsSchema.safeParse(valid);
		assert.ok(result.success);
	});

	it('rejects invalid URL in mutations', () => {
		const invalid = { url: 'not-a-url' };
		const result = FuzzMutationsSchema.safeParse(invalid);
		assert.ok(!result.success);
	});
});

describe('CookieSchema', () => {
	it('validates valid cookie object', () => {
		const valid = {
			name: 'session',
			value: 'abc123',
			domain: '.example.com',
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'Lax',
		};
		const result = CookieSchema.safeParse(valid);
		assert.ok(result.success);
	});

	it('rejects cookie without name', () => {
		const invalid = { value: 'abc123' };
		const result = CookieSchema.safeParse(invalid);
		assert.ok(!result.success);
	});

	it('rejects empty cookie name', () => {
		const invalid = { name: '', value: 'abc123' };
		const result = CookieSchema.safeParse(invalid);
		assert.ok(!result.success);
	});

	it('allows additional browser-specific fields', () => {
		const valid = {
			name: 'session',
			value: 'abc123',
			priority: 'High',
			partitionKey: 'key',
		};
		const result = CookieSchema.safeParse(valid);
		assert.ok(result.success);
	});
});

describe('CookiesInputSchema', () => {
	it('validates cookie header string', () => {
		const valid = 'session=abc123; token=xyz789';
		const result = CookiesInputSchema.safeParse(valid);
		assert.ok(result.success);
	});

	it('validates array of cookie strings', () => {
		const valid = ['session=abc123', 'token=xyz789'];
		const result = CookiesInputSchema.safeParse(valid);
		assert.ok(result.success);
	});

	it('validates array of cookie objects', () => {
		const valid = [
			{ name: 'session', value: 'abc123' },
			{ name: 'token', value: 'xyz789' },
		];
		const result = CookiesInputSchema.safeParse(valid);
		assert.ok(result.success);
	});

	it('validates name-value object', () => {
		const valid = { session: 'abc123', token: 'xyz789' };
		const result = CookiesInputSchema.safeParse(valid);
		assert.ok(result.success);
	});
});

describe('ClaimMutationsSchema', () => {
	it('validates valid claim mutations', () => {
		const valid = { sub: 'admin', role: 'superuser', exp: 9999999999 };
		const result = ClaimMutationsSchema.safeParse(valid);
		assert.ok(result.success);
	});

	it('rejects empty claim mutations', () => {
		const invalid = {};
		const result = ClaimMutationsSchema.safeParse(invalid);
		assert.ok(!result.success);
	});

	it('allows any value types', () => {
		const valid = {
			string: 'value',
			number: 123,
			boolean: true,
			null: null,
			array: [1, 2, 3],
			object: { nested: 'value' },
		};
		const result = ClaimMutationsSchema.safeParse(valid);
		assert.ok(result.success);
	});
});

describe('TemplateSchema', () => {
	it('validates valid template', () => {
		const valid = {
			id: 'test-template',
			info: {
				name: 'Test Template',
				severity: 'medium',
				tags: ['test', 'example'],
			},
			requests: [
				{
					method: 'GET',
					path: ['/api/test'],
					matchers: [
						{ type: 'status', status: [200] },
					],
				},
			],
		};
		const result = TemplateSchema.safeParse(valid);
		assert.ok(result.success);
	});

	it('rejects template without id', () => {
		const invalid = { info: { name: 'Test' } };
		const result = TemplateSchema.safeParse(invalid);
		assert.ok(!result.success);
	});

	it('rejects empty template id', () => {
		const invalid = { id: '' };
		const result = TemplateSchema.safeParse(invalid);
		assert.ok(!result.success);
	});

	it('validates minimal template', () => {
		const valid = { id: 'minimal-template' };
		const result = TemplateSchema.safeParse(valid);
		assert.ok(result.success);
	});
});

describe('VariablesSchema', () => {
	it('validates valid variables', () => {
		const valid = {
			baseUrl: 'https://example.com',
			port: 8080,
			enabled: true,
			optional: null,
		};
		const result = VariablesSchema.safeParse(valid);
		assert.ok(result.success);
	});

	it('rejects variables with complex types', () => {
		const invalid = {
			array: [1, 2, 3],
			object: { nested: 'value' },
		};
		const result = VariablesSchema.safeParse(invalid);
		assert.ok(!result.success);
	});

	it('allows empty variables object', () => {
		const valid = {};
		const result = VariablesSchema.safeParse(valid);
		assert.ok(result.success);
	});
});

describe('JsonValuesSchema', () => {
	it('validates any record of unknown values', () => {
		const valid = {
			string: 'value',
			number: 123,
			boolean: true,
			null: null,
			array: [1, 2, 3],
			object: { nested: 'value' },
		};
		const result = JsonValuesSchema.safeParse(valid);
		assert.ok(result.success);
	});

	it('allows empty object', () => {
		const valid = {};
		const result = JsonValuesSchema.safeParse(valid);
		assert.ok(result.success);
	});
});
