declare module "@earendil-works/pi-coding-agent" {
  export type ExtensionToolResult = {
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
    terminate?: boolean;
  };

  export type ExtensionToolUpdate = ExtensionToolResult;

  export type ExtensionCommandContext = {
    cwd?: string;
    hasUI?: boolean;
    ui: {
      setStatus(key: string, value?: string): void;
      notify(message: string, level?: "info" | "warning" | "error"): void;
      setEditorText(text: string): void;
      getEditorText?(): string | undefined;
    };
  };

  export type ExtensionToolExecuteContext = {
    cwd?: string;
    hasUI?: boolean;
  };

  export type ExtensionAPI = {
    on(event: string, handler: (...args: any[]) => void | Promise<void>): void;
    registerTool(definition: {
      name: string;
      label?: string;
      description?: string;
      promptSnippet?: string;
      promptGuidelines?: string[];
      parameters?: unknown;
      execute: (
        toolCallId: string,
        params: any,
        signal?: AbortSignal,
        onUpdate?: (update: ExtensionToolUpdate) => void | Promise<void>,
        ctx?: ExtensionToolExecuteContext,
      ) => Promise<ExtensionToolResult> | ExtensionToolResult;
    }): void;
    registerCommand(name: string, definition: {
      description?: string;
      handler: (args: unknown, ctx: ExtensionCommandContext) => void | Promise<void>;
    }): void;
  };
}
