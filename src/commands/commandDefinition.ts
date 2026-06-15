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
};

export type BrowserCommandDefinition = {
	name: string;
	label?: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: unknown;
	prepareArguments?: (args: any) => any;
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
