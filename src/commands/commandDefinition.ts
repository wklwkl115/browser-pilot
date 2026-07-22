export type BrowserCommandResult = {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
	isError?: boolean;
	terminate?: boolean;
};

export type BrowserCommandUpdate = BrowserCommandResult;

export type BrowserCommandExecuteContext = {
	cwd?: string;
	omitTransportDetails?: boolean;
};

export interface ValidationIssue {
	code: string;
	path: string;
	message: string;
}

export type BrowserCommandDefinition = {
	name: string;
	label?: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: unknown;
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
