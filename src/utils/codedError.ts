import { suppressErrorStack } from "./errors.js";

export type CodedError<Code extends string = string> = Error & {
	code: Code;
	details: Record<string, unknown>;
};

export function createCodedError<Code extends string>(options: {
	name: string;
	code: Code;
	message: string;
	details?: Record<string, unknown>;
	suppressStack?: boolean;
}): CodedError<Code> {
	const error = new Error(options.message) as CodedError<Code>;
	error.name = options.name;
	error.code = options.code;
	error.details = options.details || {};
	return options.suppressStack === false ? error : suppressErrorStack(error);
}
