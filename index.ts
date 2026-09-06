/**
 * Library entry point. Most users run the `browser-pilot-mcp` binary; these exports are for
 * embedding Browser Pilot in another Node process (a custom MCP host, a test harness, or a CLI)
 * without going through stdio.
 *
 *   - Tools:     define the five browser_* tools against any BrowserCommandSink.
 *   - MCP:       build the MCP server or call tools / read resources in-process.
 *   - Daemon:    start, find, or reuse the user-local daemon that owns the browser bridge.
 *   - Bridge:    host the WebSocket bridge directly when no daemon is wanted.
 *   - Operator:  install the extension and diagnose the local setup.
 */

// Tools
export { defineBrowserCommands } from "./src/commands/defineBrowserCommands.js";
export { browserCommandDefinitions } from "./src/commands/commandDefinitions.js";
export { CommandManifestIndex, type CommandDefinition } from "./src/commands/commandManifestIndex.js";
export type {
	BrowserCommandDefinition,
	BrowserCommandExecuteContext,
	BrowserCommandResult,
	BrowserCommandSink,
	ValidationIssue,
} from "./src/commands/commandDefinition.js";
export { validateBrowserCommandArguments } from "./src/commands/commandValidation.js";
export type { BrowserCommandRuntimePort } from "./src/ports/BrowserCommandRuntimePort.js";

// MCP
export {
	callMcpTool,
	createMcpServer,
	mcpResources,
	mcpResourceTemplates,
	mcpTools,
	readMcpResource,
	runMcpServer,
} from "./src/apps/mcp/server.js";

// Daemon
export { startDaemon, type DaemonHandle, type StartDaemonOptions } from "./src/apps/daemon/server.js";
export {
	ensureDaemon,
	findDaemon,
	pingStatus,
	stateDir,
	type DaemonInfo,
	type DaemonStatus,
	type FoundDaemon,
} from "./src/apps/daemon/daemonControl.js";

// Bridge
export { BrowserBridgeServer } from "./src/bridge/server/BrowserBridgeServer.js";

// Operator
export { installBrowserExtension, type BrowserName } from "./src/apps/mcp/install.js";
export { collectStatus, renderStatus, type StatusCheck, type StatusReport } from "./src/apps/mcp/status.js";

// Protocol
export {
	getNativeCommandProtocolSchema,
	validateBridgeCommand,
	type BridgeCommand,
	type CommandSpec,
} from "./src/types/nativeProtocol.js";
export {
	coreNativeCommandNames,
	nativeCommandTier,
	publicNativeCommandNames,
} from "./src/commands/nativeCommandAccess.js";
