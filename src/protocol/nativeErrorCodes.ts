// Generated from bridge/native_command_schema.json. Do not edit by hand.
export const nativeErrorCodes = {
  "ALREADY_INSTALLED": {
    "category": "runtime.lifecycle",
    "retryable": false,
    "summary": "Requested recorder or hook session is already installed."
  },
  "AMBIGUOUS_DOWNLOAD": {
    "category": "runtime.transfer",
    "retryable": false,
    "summary": "Download click produced multiple possible download events without a precise match."
  },
  "AMBIGUOUS_TAB_ID": {
    "category": "driver.tab",
    "retryable": false,
    "summary": "Multiple connected browsers expose the same numeric tabId."
  },
  "TAB_LEASE_CONFLICT": {
    "category": "driver.lease",
    "retryable": false,
    "summary": "Target tab is leased by another browser session."
  },
  "UI_LOCK_CONFLICT": {
    "category": "driver.lease",
    "retryable": false,
    "summary": "Browser UI is locked by another browser session."
  },
  "BACKGROUND_THROTTLED": {
    "category": "runtime.page",
    "retryable": true,
    "summary": "Background tab throttling affected page-side timing."
  },
  "BODY_UNAVAILABLE": {
    "category": "runtime.network",
    "retryable": false,
    "summary": "Captured network body is unavailable or expired."
  },
  "BRIDGE_CLIENT_DISCONNECTED": {
    "category": "driver.pending",
    "retryable": true,
    "summary": "Extension client disconnected before a pending command completed."
  },
  "BRIDGE_NOT_RUNNING": {
    "category": "driver.lifecycle",
    "retryable": true,
    "summary": "Bridge server is not running."
  },
  "BRIDGE_SEND_FAILED": {
    "category": "driver.pending",
    "retryable": true,
    "summary": "Bridge failed to send a command to the extension client."
  },
  "BRIDGE_START_FAILED": {
    "category": "driver.lifecycle",
    "retryable": true,
    "summary": "Bridge HTTP/WebSocket server failed to start."
  },
  "BRIDGE_STOPPED": {
    "category": "driver.pending",
    "retryable": true,
    "summary": "Bridge stopped while a command was pending."
  },
  "BRIDGE_TIMEOUT": {
    "category": "driver.pending",
    "retryable": true,
    "summary": "Bridge command timed out before a response arrived."
  },
  "BROWSER_COMMAND_FAILED": {
    "category": "driver.command",
    "retryable": false,
    "summary": "Browser command returned a structured failure result."
  },
  "BROWSER_EXECUTION_ERROR": {
    "category": "driver.execution",
    "retryable": false,
    "summary": "Browser execution or page-script evaluation failed."
  },
  "BROWSER_EXTENSION_RECONNECT_TIMEOUT": {
    "category": "driver.lifecycle",
    "retryable": true,
    "summary": "Extension reload did not reconnect before the deadline."
  },
  "BROWSER_NOT_FOUND": {
    "category": "driver.selection",
    "retryable": false,
    "summary": "Requested browser client was not found."
  },
  "QUEUE_FULL": {
    "category": "driver.queue",
    "retryable": true,
    "summary": "Browser command queue reached its configured depth limit."
  },
  "BUFFER_OVERFLOW": {
    "category": "runtime.hook",
    "retryable": false,
    "summary": "Hook buffer overflowed before collection."
  },
  "CANCELLED": {
    "category": "runtime.wait",
    "retryable": true,
    "summary": "Wait, network wait, or subscription was cancelled."
  },
  "CONTENT_EXTRACTION_FAILED": {
    "category": "tool.content",
    "retryable": false,
    "summary": "browser_observe content extraction did not return structured content data."
  },
  "CROSS_ORIGIN_IFRAME": {
    "category": "runtime.frame",
    "retryable": false,
    "summary": "Requested operation cannot cross an iframe origin boundary."
  },
  "DOWNLOAD_TARGET_REQUIRED": {
    "category": "tool.transfer",
    "retryable": false,
    "summary": "browser_download requires selector or url."
  },
  "ELEMENT_NOT_FOUND": {
    "category": "runtime.page",
    "retryable": true,
    "summary": "Page-side selector did not match an element."
  },
  "EVENT_SUBSCRIPTION_FAILED": {
    "category": "runtime.hook",
    "retryable": true,
    "summary": "Page event listener subscription or cleanup failed."
  },
  "FRAME_DETACHED": {
    "category": "runtime.frame",
    "retryable": true,
    "summary": "Target frame detached before command completion."
  },
  "INJECTION_FAILED": {
    "category": "runtime.hook",
    "retryable": true,
    "summary": "Hook dispatcher injection or readiness check failed."
  },
  "INTERNAL_ERROR": {
    "category": "runtime.internal",
    "retryable": false,
    "summary": "Unexpected internal runtime or tool failure."
  },
  "MATURE_BRIDGE_LAUNCHER_NOT_FOUND": {
    "category": "tool.security",
    "retryable": false,
    "summary": "External mature bridge launcher was not found."
  },
  "MATURE_BRIDGE_LAUNCHER_OVERRIDE_REQUIRED": {
    "category": "tool.security",
    "retryable": false,
    "summary": "Explicit mature bridge launcher overrides require an opt-in flag."
  },
  "MATURE_BRIDGE_LAUNCHER_PROBE_TIMEOUT": {
    "category": "tool.security",
    "retryable": true,
    "summary": "External mature bridge launcher probe timed out."
  },
  "MATURE_BRIDGE_LAUNCHER_PROBE_FAILED": {
    "category": "tool.security",
    "retryable": false,
    "summary": "External mature bridge launcher probe failed."
  },
  "MATURE_BRIDGE_LAUNCH_FAILED": {
    "category": "tool.security",
    "retryable": false,
    "summary": "External mature bridge process failed to start."
  },
  "MATURE_BRIDGE_PROCESS_TIMEOUT": {
    "category": "tool.security",
    "retryable": true,
    "summary": "External mature bridge process timed out."
  },
  "MATURE_BRIDGE_TARGET_REQUIRED": {
    "category": "tool.security",
    "retryable": false,
    "summary": "External mature bridge requires an explicit scoped target or request input."
  },
  "MATURE_BRIDGE_TEMPLATE_SELECTION_REQUIRED": {
    "category": "tool.security",
    "retryable": false,
    "summary": "External mature bridge requires explicit template or selector input."
  },
  "INVALID_BROWSER_COMMAND": {
    "category": "driver.command",
    "retryable": false,
    "summary": "Command payload failed native protocol validation."
  },
  "INVALID_BROWSER_ID": {
    "category": "driver.selection",
    "retryable": false,
    "summary": "Browser id is malformed or unsupported."
  },
  "INVALID_RULE": {
    "category": "tool.validation",
    "retryable": false,
    "summary": "Tool rule or mode combination is invalid."
  },
  "INVALID_TIMEOUT": {
    "category": "tool.validation",
    "retryable": false,
    "summary": "Tool timeout parameter is invalid."
  },
  "INVALID_SELECTOR": {
    "category": "runtime.selector",
    "retryable": false,
    "summary": "CSS selector syntax is invalid."
  },
  "INVALID_SESSION": {
    "category": "runtime.session",
    "retryable": false,
    "summary": "Requested session id does not match the installed session."
  },
  "INVALID_TAB_ID": {
    "category": "driver.tab",
    "retryable": false,
    "summary": "tabId is malformed or unsupported."
  },
  "INVALID_TAB_URL": {
    "category": "tool.tabs",
    "retryable": false,
    "summary": "browser_tabs create URL is invalid or blocked."
  },
  "NAVIGATION_TIMEOUT": {
    "category": "runtime.wait",
    "retryable": true,
    "summary": "Navigation wait timed out or failed before target state."
  },
  "PRIVATE_TARGET_BLOCKED": {
    "category": "tool.security",
    "retryable": false,
    "summary": "Private, link-local, or metadata targets require explicit opt-in."
  },
  "NETWORK_IDLE_TIMEOUT": {
    "category": "runtime.wait",
    "retryable": true,
    "summary": "Network idle wait timed out."
  },
  "NETWORK_RECORDER_NOT_STARTED": {
    "category": "runtime.network",
    "retryable": true,
    "summary": "Network recorder session is not started."
  },
  "NETWORK_RECORDER_TIMEOUT": {
    "category": "runtime.network",
    "retryable": true,
    "summary": "Network recorder wait timed out."
  },
  "NOT_INSTALLED": {
    "category": "runtime.session",
    "retryable": true,
    "summary": "Page hook dispatcher is not installed."
  },
  "NO_BROWSER_EXTENSION": {
    "category": "driver.lifecycle",
    "retryable": true,
    "summary": "No browser extension client is connected."
  },
  "NO_SESSION": {
    "category": "runtime.session",
    "retryable": true,
    "summary": "No matching runtime session or tab-scoped dispatcher is available."
  },
  "NO_TAB": {
    "category": "driver.tab",
    "retryable": true,
    "summary": "No usable target tab is available for a tab-scoped command."
  },
  "REQUEST_NOT_FOUND": {
    "category": "runtime.network",
    "retryable": false,
    "summary": "Network request id was not found in recorder state."
  },
  "SAFETY_BLOCKED": {
    "category": "runtime.transfer",
    "retryable": false,
    "summary": "Browser blocked file access or another safety-sensitive operation."
  },
  "SELECTOR_NOT_FOUND": {
    "category": "runtime.selector",
    "retryable": true,
    "summary": "Selector was valid but did not match an element."
  },
  "SELECTOR_TIMEOUT": {
    "category": "runtime.selector",
    "retryable": true,
    "summary": "Selector wait timed out."
  },
  "SESSION_NOT_FOUND": {
    "category": "runtime.session",
    "retryable": true,
    "summary": "Requested runtime session was not found."
  },
  "TAB_CRASHED": {
    "category": "runtime.tab",
    "retryable": true,
    "summary": "Target tab crashed during operation."
  },
  "TAB_ID_CONFLICT": {
    "category": "driver.tab",
    "retryable": false,
    "summary": "Conflicting tab id values were supplied."
  },
  "TAB_ID_REQUIRED": {
    "category": "tool.tabs",
    "retryable": false,
    "summary": "browser_tabs switch/close requires tabId."
  },
  "TAB_NOT_FOUND": {
    "category": "driver.tab",
    "retryable": true,
    "summary": "Target browser tab is not connected."
  },
  "TIMEOUT": {
    "category": "runtime.timeout",
    "retryable": true,
    "summary": "Generic runtime wait or command timeout."
  },
  "WAIT_TIMEOUT": {
    "category": "driver.wait",
    "retryable": true,
    "summary": "Durable browser wait exceeded the total timeout budget."
  },
  "WAIT_STATE_LOST": {
    "category": "driver.wait",
    "retryable": true,
    "summary": "Durable browser wait could not survive browser extension state loss or restart."
  },
  "RUNTIME_STATE_RECOVERED": {
    "category": "runtime.recovery",
    "retryable": true,
    "summary": "Configuration/session metadata was restored without evidence loss."
  },
  "RUNTIME_STATE_RECOVERED_WITH_HISTORY_LOSS": {
    "category": "runtime.recovery",
    "retryable": true,
    "summary": "Configuration/rules were restored, but volatile runtime evidence was lost."
  },
  "RUNTIME_STATE_LOST": {
    "category": "runtime.recovery",
    "retryable": true,
    "summary": "Runtime state cannot be safely reconstructed; caller must rebuild explicitly."
  },
  "WEBSOCKET_INVALID_INPUT": {
    "category": "bridge.ws",
    "retryable": false,
    "summary": "WebSocket command input was invalid or incomplete."
  },
  "WEBSOCKET_SESSION_ALREADY_OPEN": {
    "category": "bridge.ws",
    "retryable": false,
    "summary": "A WebSocket session with the same session id is already open."
  },
  "WEBSOCKET_SESSION_NOT_FOUND": {
    "category": "bridge.ws",
    "retryable": false,
    "summary": "Requested WebSocket session was not found."
  },
  "WEBSOCKET_SESSION_NOT_OPEN": {
    "category": "bridge.ws",
    "retryable": false,
    "summary": "Requested WebSocket session exists but is not open."
  },
  "WEBSOCKET_OPEN_FAILED": {
    "category": "bridge.ws",
    "retryable": true,
    "summary": "WebSocket connection failed during open."
  },
  "WEBSOCKET_OPEN_TIMEOUT": {
    "category": "bridge.ws",
    "retryable": true,
    "summary": "WebSocket open timed out before the connection became ready."
  },
  "WEBSOCKET_SEND_FAILED": {
    "category": "bridge.ws",
    "retryable": true,
    "summary": "WebSocket send failed."
  },
  "WEBSOCKET_INVALID_MATCHER": {
    "category": "bridge.ws",
    "retryable": false,
    "summary": "WebSocket wait matcher was unsafe or invalid."
  },
  "WEBSOCKET_WAIT_TIMEOUT": {
    "category": "bridge.ws",
    "retryable": true,
    "summary": "WebSocket wait timed out before a matching inbound message arrived."
  },
  "WEBSOCKET_WAIT_ABORTED": {
    "category": "bridge.ws",
    "retryable": true,
    "summary": "WebSocket wait aborted because the session closed or errored."
  },
  "UNKNOWN_BROWSER_CLIENT": {
    "category": "driver.selection",
    "retryable": false,
    "summary": "Requested browser client id is unknown."
  },
  "UNSUPPORTED_TARGET": {
    "category": "runtime.transfer",
    "retryable": false,
    "summary": "Target URL, element, or chooser mode is unsupported."
  },
  "UPLOAD_CONFIRMATION_REQUIRED": {
    "category": "tool.transfer",
    "retryable": false,
    "summary": "browser_upload requires confirm:true after user approval."
  },
  "UPLOAD_FILES_LIMIT": {
    "category": "tool.transfer",
    "retryable": false,
    "summary": "browser_upload file count exceeds the supported limit."
  },
  "UPLOAD_FILES_REQUIRED": {
    "category": "tool.transfer",
    "retryable": false,
    "summary": "browser_upload requires at least one file."
  },
  "UPLOAD_FILE_NOT_FOUND": {
    "category": "tool.transfer",
    "retryable": false,
    "summary": "browser_upload file path does not exist."
  },
  "UPLOAD_PATH_NOT_ABSOLUTE": {
    "category": "tool.transfer",
    "retryable": false,
    "summary": "browser_upload requires absolute local file paths."
  },
  "UPLOAD_PATH_NOT_FILE": {
    "category": "tool.transfer",
    "retryable": false,
    "summary": "browser_upload path is not a file."
  },
  "UPLOAD_REQUIRES_BROWSER_UPLOAD": {
    "category": "tool.transfer",
    "retryable": false,
    "summary": "transfer.upload must go through browser_upload validation."
  },
  "UPLOAD_SELECTOR_REQUIRED": {
    "category": "tool.transfer",
    "retryable": false,
    "summary": "browser_upload requires a selector."
  },
  "WORDLIST_PATH_BLOCKED": {
    "category": "tool.security",
    "retryable": false,
    "summary": "Local wordlist paths must stay within allowed roots and bounded size."
  },
  "HTTPS_CERT_GENERATION_FAILED": {
    "category": "tool.security",
    "retryable": false,
    "summary": "Callback HTTPS certificate generation failed or explicit certificate inputs were invalid."
  }
} as const;

export type NativeErrorCode = keyof typeof nativeErrorCodes;

export function isNativeErrorCode(value: string): value is NativeErrorCode {
	return Object.hasOwn(nativeErrorCodes, value);
}

export function normalizeNativeErrorCode(value: unknown, fallback: NativeErrorCode = "INTERNAL_ERROR"): NativeErrorCode {
	return typeof value === "string" && isNativeErrorCode(value) ? value : fallback;
}
