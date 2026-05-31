import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	validateParams,
	safeRecordValue,
	validateOptionalParams,
	validateArray,
	createValidator,
	validateParamsWithMessage,
	isValidParams,
	tryValidateParams,
} from '../../../src/validation/middleware.ts';
import { BridgeCommandSchema, HttpRequestSchema } from '../../../src/validation/schemas.ts';
import { z } from 'zod';

describe('validateParams', () => {
	it('validates valid parameters', () => {
		const valid = { cmd: 'tabs', method: 'list' };
		const result = validateParams(BridgeCommandSchema, valid);
		assert.equal(result.cmd, 'tabs');
		assert.equal(result.method, 'list');
	});

	it('throws BrowserBridgeError on validation failure', () => {
		const invalid = { method: 'list' }; // missing cmd
		assert.throws(
			() => validateParams(BridgeCommandSchema, invalid),
			(err: any) => {
				assert.equal(err.code, 'INVALID_BROWSER_COMMAND');
				assert.ok(err.message.includes('Parameter validation failed'));
				assert.ok(err.details.validationErrors);
				return true;
			}
		);
	});

	it('includes validation errors in error details', () => {
		const invalid = { cmd: '', method: 'list' }; // empty cmd
		assert.throws(
			() => validateParams(BridgeCommandSchema, invalid),
			(err: any) => {
				assert.ok(err.details.validationErrors);
				assert.ok(Array.isArray(err.details.validationErrors));
				return true;
			}
		);
	});

	it('includes received params in error details', () => {
		const invalid = { method: 'list' };
		assert.throws(
			() => validateParams(BridgeCommandSchema, invalid),
			(err: any) => {
				assert.deepEqual(err.details.received, invalid);
				return true;
			}
		);
	});
});

describe('safeRecordValue', () => {
	it('validates and returns typed value', () => {
		const value = { cmd: 'tabs', method: 'list' };
		const result = safeRecordValue(value, BridgeCommandSchema);
		assert.equal(result.cmd, 'tabs');
	});

	it('throws on invalid value', () => {
		const invalid = { method: 'list' };
		assert.throws(
			() => safeRecordValue(invalid, BridgeCommandSchema),
			(err: any) => err.code === 'INVALID_BROWSER_COMMAND'
		);
	});
});

describe('validateOptionalParams', () => {
	it('returns undefined for null', () => {
		const result = validateOptionalParams(BridgeCommandSchema, null);
		assert.equal(result, undefined);
	});

	it('returns undefined for undefined', () => {
		const result = validateOptionalParams(BridgeCommandSchema, undefined);
		assert.equal(result, undefined);
	});

	it('returns undefined for empty string', () => {
		const result = validateOptionalParams(BridgeCommandSchema, '');
		assert.equal(result, undefined);
	});

	it('validates non-empty value', () => {
		const valid = { cmd: 'tabs' };
		const result = validateOptionalParams(BridgeCommandSchema, valid);
		assert.ok(result);
		assert.equal(result.cmd, 'tabs');
	});

	it('throws on invalid non-empty value', () => {
		const invalid = { method: 'list' };
		assert.throws(
			() => validateOptionalParams(BridgeCommandSchema, invalid),
			(err: any) => err.code === 'INVALID_BROWSER_COMMAND'
		);
	});
});

describe('validateArray', () => {
	const schema = z.object({ cmd: z.string() });

	it('validates array of valid items', () => {
		const items = [{ cmd: 'tabs' }, { cmd: 'execute' }];
		const result = validateArray(schema, items);
		assert.equal(result.length, 2);
		assert.equal(result[0].cmd, 'tabs');
		assert.equal(result[1].cmd, 'execute');
	});

	it('throws on any invalid item', () => {
		const items = [{ cmd: 'tabs' }, { invalid: 'field' }, { cmd: 'execute' }];
		assert.throws(
			() => validateArray(schema, items),
			(err: any) => {
				assert.equal(err.code, 'INVALID_BROWSER_COMMAND');
				assert.ok(err.message.includes('Array validation failed'));
				assert.ok(err.message.includes('[1]')); // index of invalid item
				return true;
			}
		);
	});

	it('collects all validation errors', () => {
		const items = [{ invalid: 'a' }, { invalid: 'b' }];
		assert.throws(
			() => validateArray(schema, items),
			(err: any) => {
				assert.ok(err.message.includes('[0]'));
				assert.ok(err.message.includes('[1]'));
				return true;
			}
		);
	});

	it('validates empty array', () => {
		const result = validateArray(schema, []);
		assert.equal(result.length, 0);
	});
});

describe('createValidator', () => {
	it('creates reusable validator function', () => {
		const validateCommand = createValidator(BridgeCommandSchema);
		const valid = { cmd: 'tabs' };
		const result = validateCommand(valid);
		assert.equal(result.cmd, 'tabs');
	});

	it('created validator throws on invalid input', () => {
		const validateCommand = createValidator(BridgeCommandSchema);
		const invalid = { method: 'list' };
		assert.throws(
			() => validateCommand(invalid),
			(err: any) => err.code === 'INVALID_BROWSER_COMMAND'
		);
	});
});

describe('validateParamsWithMessage', () => {
	it('validates with custom error message', () => {
		const valid = { cmd: 'tabs' };
		const result = validateParamsWithMessage(
			BridgeCommandSchema,
			valid,
			'Custom error'
		);
		assert.equal(result.cmd, 'tabs');
	});

	it('includes custom message in error', () => {
		const invalid = { method: 'list' };
		assert.throws(
			() => validateParamsWithMessage(
				BridgeCommandSchema,
				invalid,
				'Custom error'
			),
			(err: any) => {
				assert.ok(err.message.includes('Custom error'));
				return true;
			}
		);
	});
});

describe('isValidParams', () => {
	it('returns true for valid params', () => {
		const valid = { cmd: 'tabs' };
		assert.ok(isValidParams(BridgeCommandSchema, valid));
	});

	it('returns false for invalid params', () => {
		const invalid = { method: 'list' };
		assert.ok(!isValidParams(BridgeCommandSchema, invalid));
	});

	it('does not throw on invalid params', () => {
		const invalid = { method: 'list' };
		assert.doesNotThrow(() => isValidParams(BridgeCommandSchema, invalid));
	});

	it('acts as type guard', () => {
		const value: unknown = { cmd: 'tabs' };
		if (isValidParams(BridgeCommandSchema, value)) {
			// TypeScript should narrow type here
			assert.equal(value.cmd, 'tabs');
		}
	});
});

describe('tryValidateParams', () => {
	it('returns success result for valid params', () => {
		const valid = { cmd: 'tabs' };
		const result = tryValidateParams(BridgeCommandSchema, valid);
		assert.ok(result.success);
		if (result.success) {
			assert.equal(result.data.cmd, 'tabs');
		}
	});

	it('returns error result for invalid params', () => {
		const invalid = { method: 'list' };
		const result = tryValidateParams(BridgeCommandSchema, invalid);
		assert.ok(!result.success);
		if (!result.success) {
			assert.ok(result.error);
			assert.ok(result.details);
		}
	});

	it('does not throw on invalid params', () => {
		const invalid = { method: 'list' };
		assert.doesNotThrow(() => tryValidateParams(BridgeCommandSchema, invalid));
	});

	it('includes error message in failure result', () => {
		const invalid = { cmd: '' };
		const result = tryValidateParams(BridgeCommandSchema, invalid);
		assert.ok(!result.success);
		if (!result.success) {
			assert.ok(result.error.length > 0);
		}
	});
});

describe('integration: complex validation scenarios', () => {
	it('validates nested HTTP request with all fields', () => {
		const request = {
			url: 'https://api.example.com/users',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': 'Bearer token123',
			},
			body: JSON.stringify({ name: 'test', email: 'test@example.com' }),
		};
		const result = validateParams(HttpRequestSchema, request);
		assert.equal(result.url, request.url);
		assert.equal(result.method, 'POST');
		assert.deepEqual(result.headers, request.headers);
	});

	it('validates HTTP request with minimal fields', () => {
		const request = { url: 'https://example.com' };
		const result = validateParams(HttpRequestSchema, request);
		assert.equal(result.url, request.url);
		assert.equal(result.method, 'GET'); // default
	});

	it('rejects HTTP request with invalid URL format', () => {
		const invalid = { url: 'not-a-valid-url', method: 'GET' };
		assert.throws(
			() => validateParams(HttpRequestSchema, invalid),
			(err: any) => {
				assert.ok(err.message.includes('Invalid URL format'));
				return true;
			}
		);
	});

	it('validates bridge command with CDP params', () => {
		const command = {
			cmd: 'cdp',
			cdpMethod: 'Network.enable',
			cdpParams: { maxTotalBufferSize: 10000000 },
		};
		const result = validateParams(BridgeCommandSchema, command);
		assert.equal(result.cmd, 'cdp');
		assert.equal(result.cdpMethod, 'Network.enable');
	});
});
