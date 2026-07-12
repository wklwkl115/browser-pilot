export type BrowserCommandResult = {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
	terminate?: boolean;
};

export type BrowserCommandUpdate = BrowserCommandResult;

export type BrowserCommandExecuteContext = {
	cwd?: string;
	hasUI?: boolean;
	omitTransportDetails?: boolean;
	operationOwnerId?: string;
};

export interface ValidationIssue {
	code: string;
	path: string;
	message: string;
}

export type CommandOwnedActionMetadata = {
	/** Raw JSON action value. */
	action: string;
	/** Canonical kebab-case CLI token. Derived from action when omitted. */
	cliAction?: string;
	/** Stable command-layer schema reference included in the command contract hash. */
	schemaRef: string;
	required?: readonly string[];
	requiredAny?: readonly (readonly string[])[];
};

export type BrowserCommandDefinition = {
	name: string;
	label?: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: unknown;
	actionMetadata?: readonly CommandOwnedActionMetadata[];
	/** Explicit, command-owned canonical normalization; never removes unknown keys. */
	coerceArguments?: (args: Record<string, unknown>) => Record<string, unknown>;
	removedArguments?: readonly string[];
	internalArguments?: readonly string[];
	validateArguments?: (args: Record<string, unknown>) => ValidationIssue[];
	execute: (
		toolCallId: string,
		params: any,
		signal?: AbortSignal,
		onUpdate?: (update: BrowserCommandUpdate) => void | Promise<void>,
		ctx?: BrowserCommandExecuteContext,
	) => Promise<BrowserCommandResult> | BrowserCommandResult;
};

export type BrowserCommandSink = {
	define(definition: BrowserCommandDefinition): void;
};
