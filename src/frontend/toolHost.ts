export type BrowserToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details?: Record<string, unknown>;
	terminate?: boolean;
};

export type BrowserToolUpdate = BrowserToolResult;

export type BrowserToolExecuteContext = {
	cwd?: string;
	hasUI?: boolean;
	omitTransportDetails?: boolean;
};

export type BrowserToolDefinition = {
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
		onUpdate?: (update: BrowserToolUpdate) => void | Promise<void>,
		ctx?: BrowserToolExecuteContext,
	) => Promise<BrowserToolResult> | BrowserToolResult;
};

export type BrowserToolHost = {
	registerTool(definition: BrowserToolDefinition): void;
};
