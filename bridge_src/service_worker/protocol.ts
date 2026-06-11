// Generated from bridge/native_command_schema.json. Do not edit by hand.
import type { JsonRecord, PiBridgeCommand } from "./types";

type PiCommandSpec = JsonRecord & {
  domain?: string;
  tabScoped?: boolean;
  accessMode?: 'read' | 'write';
  internal?: boolean;
  methods?: string[];
  defaultMethod?: string;
  methodRequired?: boolean;
  required?: string[];
  requiredAny?: string[][];
  methodSpecs?: Record<string, PiCommandSpec>;
  canonical?: string;
};
type PiProtocolSchema = JsonRecord & {
  aliases: Record<string, string>;
  domains: Record<string, string[]>;
  commands: Record<string, PiCommandSpec>;
};

(function installPiNativeProtocol(global: typeof globalThis & { PiNativeProtocol?: unknown }) {
  'use strict';
  const schema = {
  "name": "pi-browser-native-commands",
  "version": "0.2.0",
  "transport": "Pi Browser Bridge WebSocket command envelope",
  "envelope": {
    "type": "object",
    "required": [
      "cmd"
    ],
    "properties": {
      "cmd": {
        "type": "string"
      },
      "tabId": {
        "type": "integer"
      },
      "sessionId": {
        "type": "string"
      },
      "timeoutMs": {
        "type": "integer"
      }
    },
    "additionalProperties": true
  },
  "aliases": {
    "hook.clear": "hook.clear_buffer",
    "hook.ping": "hook.status"
  },
  "domains": {
    "core": [
      "bridge_wake",
      "tabs",
      "management",
      "cookies",
      "cdp",
      "persistent_cdp",
      "batch",
      "content.fingerprint",
      "contentSettings"
    ],
    "input": [
      "input.pointer",
      "input.keys",
      "input.touch"
    ],
    "wait": [
      "wait.navigate",
      "wait.navigateAndWait",
      "wait.navigation",
      "wait.loadState",
      "wait.networkIdle",
      "wait.selector",
      "wait.any",
      "wait.all",
      "wait.cancel",
      "wait.diagnose"
    ],
    "network": [
      "network.start",
      "network.stop",
      "network.status",
      "network.clear",
      "network.list",
      "network.get",
      "network.body",
      "network.exportHar",
      "network.wait"
    ],
    "intercept": [
      "intercept.install",
      "intercept.uninstall",
      "intercept.status",
      "intercept.listRules",
      "intercept.addRule",
      "intercept.removeRule",
      "intercept.collect",
      "intercept.pause",
      "intercept.continue",
      "intercept.fail",
      "intercept.fulfill"
    ],
    "hook": [
      "hook.list_sessions",
      "hook.list_targets",
      "hook.install_targets",
      "hook.install",
      "hook.status",
      "hook.collect",
      "hook.clear",
      "hook.clear_buffer",
      "hook.pause",
      "hook.resume",
      "hook.uninstall",
      "hook.evaluate",
      "hook.addEventListener",
      "hook.removeEventListener",
      "hook.getPerformanceEntries",
      "hook.getNodeListeners",
      "hook.getListenerChain",
      "hook.getSinkHints"
    ],
    "frame": [
      "frame.list",
      "frame.evaluate",
      "frame.addNewDocumentScript",
      "frame.removeNewDocumentScript"
    ],
    "transfer": [
      "transfer.download",
      "transfer.upload"
    ],
    "html": [
      "html.get"
    ],
    "screenshot": [
      "screenshot.capture"
    ],
    "evidence": [
      "evidence.collect"
    ],
    "ws": [
      "ws.open",
      "ws.status",
      "ws.send",
      "ws.replay",
      "ws.wait",
      "ws.collect",
      "ws.close"
    ]
  },
  "commands": {
    "bridge_wake": {
      "domain": "core",
      "tabScoped": false,
      "accessMode": "read"
    },
    "content.fingerprint": {
      "domain": "core",
      "tabScoped": true,
      "accessMode": "read",
      "internal": true,
      "notes": "Internal page fingerprint signal used by execute/observe effect collection."
    },
    "tabs": {
      "domain": "core",
      "tabScoped": false,
      "accessMode": "read",
      "methods": [
        "list",
        "switch",
        "create",
        "close"
      ],
      "defaultMethod": "list",
      "methodSpecs": {
        "switch": {
          "required": [
            "tabId"
          ],
          "accessMode": "write"
        },
        "create": {
          "accessMode": "write"
        },
        "close": {
          "accessMode": "write",
          "requiredAny": [
            [
              "targetTabId"
            ],
            [
              "closeTabId"
            ],
            [
              "tabId"
            ]
          ]
        }
      }
    },
    "management": {
      "domain": "core",
      "tabScoped": false,
      "accessMode": "read",
      "methods": [
        "list",
        "reload",
        "disable",
        "enable"
      ],
      "methodSpecs": {
        "reload": {
          "accessMode": "write"
        },
        "disable": {
          "required": [
            "extId"
          ],
          "accessMode": "write"
        },
        "enable": {
          "required": [
            "extId"
          ],
          "accessMode": "write"
        }
      }
    },
    "cookies": {
      "domain": "core",
      "tabScoped": false,
      "accessMode": "read"
    },
    "cdp": {
      "domain": "core",
      "tabScoped": true,
      "accessMode": "write",
      "required": [
        "method"
      ]
    },
    "persistent_cdp": {
      "domain": "core",
      "tabScoped": true,
      "accessMode": "write"
    },
    "input.pointer": {
      "domain": "input",
      "tabScoped": true,
      "accessMode": "write",
      "required": [
        "gesture",
        "x",
        "y"
      ]
    },
    "input.keys": {
      "domain": "input",
      "tabScoped": true,
      "accessMode": "write",
      "requiredAny": [
        [
          "text"
        ],
        [
          "keys"
        ]
      ]
    },
    "input.touch": {
      "domain": "input",
      "tabScoped": true,
      "accessMode": "write",
      "required": [
        "gesture",
        "x",
        "y"
      ]
    },
    "batch": {
      "domain": "core",
      "tabScoped": false,
      "accessMode": "write",
      "required": [
        "commands"
      ]
    },
    "contentSettings": {
      "domain": "core",
      "tabScoped": false,
      "accessMode": "read"
    },
    "wait.navigate": {
      "domain": "wait",
      "tabScoped": true,
      "accessMode": "write",
      "required": [
        "url"
      ]
    },
    "wait.navigateAndWait": {
      "domain": "wait",
      "tabScoped": true,
      "accessMode": "write",
      "required": [
        "url"
      ]
    },
    "wait.navigation": {
      "domain": "wait",
      "tabScoped": true,
      "accessMode": "read"
    },
    "wait.loadState": {
      "domain": "wait",
      "tabScoped": true,
      "accessMode": "read"
    },
    "wait.networkIdle": {
      "domain": "wait",
      "tabScoped": true,
      "accessMode": "read"
    },
    "wait.selector": {
      "domain": "wait",
      "tabScoped": true,
      "accessMode": "read",
      "required": [
        "selector"
      ]
    },
    "wait.any": {
      "domain": "wait",
      "tabScoped": true,
      "accessMode": "read"
    },
    "wait.all": {
      "domain": "wait",
      "tabScoped": true,
      "accessMode": "read"
    },
    "wait.cancel": {
      "domain": "wait",
      "tabScoped": true,
      "accessMode": "write"
    },
    "wait.diagnose": {
      "domain": "wait",
      "tabScoped": true,
      "accessMode": "read"
    },
    "network.start": {
      "domain": "network",
      "tabScoped": true,
      "accessMode": "write"
    },
    "network.stop": {
      "domain": "network",
      "tabScoped": true,
      "accessMode": "write"
    },
    "network.status": {
      "domain": "network",
      "tabScoped": true,
      "accessMode": "read"
    },
    "network.clear": {
      "domain": "network",
      "tabScoped": true,
      "accessMode": "write"
    },
    "network.list": {
      "domain": "network",
      "tabScoped": true,
      "accessMode": "read"
    },
    "network.get": {
      "domain": "network",
      "tabScoped": true,
      "accessMode": "read"
    },
    "network.body": {
      "domain": "network",
      "tabScoped": true,
      "accessMode": "read"
    },
    "network.exportHar": {
      "domain": "network",
      "tabScoped": true,
      "accessMode": "read"
    },
    "network.wait": {
      "domain": "network",
      "tabScoped": true,
      "accessMode": "read"
    },
    "intercept.install": {
      "domain": "intercept",
      "tabScoped": true,
      "accessMode": "write",
      "notes": "optional stages/requestStages may restrict Fetch.enable patterns to request and/or response interception for bounded fixtures"
    },
    "intercept.uninstall": {
      "domain": "intercept",
      "tabScoped": true,
      "accessMode": "write"
    },
    "intercept.status": {
      "domain": "intercept",
      "tabScoped": true,
      "accessMode": "read"
    },
    "intercept.listRules": {
      "domain": "intercept",
      "tabScoped": true,
      "accessMode": "read"
    },
    "intercept.addRule": {
      "domain": "intercept",
      "tabScoped": true,
      "accessMode": "write",
      "required": [
        "action"
      ]
    },
    "intercept.removeRule": {
      "domain": "intercept",
      "tabScoped": true,
      "accessMode": "write",
      "required": [
        "ruleId"
      ]
    },
    "intercept.collect": {
      "domain": "intercept",
      "tabScoped": true,
      "accessMode": "read"
    },
    "intercept.pause": {
      "domain": "intercept",
      "tabScoped": true,
      "accessMode": "write",
      "required": [
        "params"
      ]
    },
    "intercept.continue": {
      "domain": "intercept",
      "tabScoped": true,
      "accessMode": "write",
      "required": [
        "requestId"
      ],
      "notes": "patch may mutate url, method, headers, postData/body before send; body strings are UTF-8 base64-encoded for CDP Fetch.continueRequest.postData"
    },
    "intercept.fail": {
      "domain": "intercept",
      "tabScoped": true,
      "accessMode": "write",
      "required": [
        "requestId"
      ]
    },
    "intercept.fulfill": {
      "domain": "intercept",
      "tabScoped": true,
      "accessMode": "write",
      "required": [
        "requestId"
      ]
    },
    "hook.list_sessions": {
      "domain": "hook",
      "tabScoped": false,
      "accessMode": "read"
    },
    "hook.install": {
      "domain": "hook",
      "tabScoped": true,
      "accessMode": "write"
    },
    "hook.status": {
      "domain": "hook",
      "tabScoped": true,
      "accessMode": "read"
    },
    "hook.collect": {
      "domain": "hook",
      "tabScoped": true,
      "accessMode": "read"
    },
    "hook.clear": {
      "domain": "hook",
      "tabScoped": true,
      "accessMode": "write",
      "canonical": "hook.clear_buffer"
    },
    "hook.clear_buffer": {
      "domain": "hook",
      "tabScoped": true,
      "accessMode": "write"
    },
    "hook.pause": {
      "domain": "hook",
      "tabScoped": true,
      "accessMode": "write"
    },
    "hook.resume": {
      "domain": "hook",
      "tabScoped": true,
      "accessMode": "write"
    },
    "hook.uninstall": {
      "domain": "hook",
      "tabScoped": true,
      "accessMode": "write"
    },
    "hook.evaluate": {
      "domain": "hook",
      "tabScoped": true,
      "accessMode": "read",
      "required": [
        "expression"
      ]
    },
    "hook.addEventListener": {
      "domain": "hook",
      "tabScoped": true,
      "accessMode": "write",
      "required": [
        "eventType"
      ]
    },
    "hook.removeEventListener": {
      "domain": "hook",
      "tabScoped": true,
      "accessMode": "write",
      "required": [
        "listenerId"
      ]
    },
    "hook.getPerformanceEntries": {
      "domain": "hook",
      "tabScoped": true,
      "accessMode": "read"
    },
    "hook.getNodeListeners": {
      "domain": "hook",
      "tabScoped": true,
      "accessMode": "read",
      "required": [
        "selector"
      ]
    },
    "hook.getListenerChain": {
      "domain": "hook",
      "tabScoped": true,
      "accessMode": "read",
      "required": [
        "selector"
      ]
    },
    "hook.getSinkHints": {
      "domain": "hook",
      "tabScoped": true,
      "accessMode": "read",
      "required": [
        "selector"
      ]
    },
    "frame.list": {
      "domain": "frame",
      "tabScoped": true,
      "accessMode": "read"
    },
    "frame.evaluate": {
      "domain": "frame",
      "tabScoped": true,
      "accessMode": "write",
      "required": [
        "frameId",
        "expression"
      ]
    },
    "frame.addNewDocumentScript": {
      "domain": "frame",
      "tabScoped": true,
      "accessMode": "write",
      "required": [
        "source"
      ]
    },
    "frame.removeNewDocumentScript": {
      "domain": "frame",
      "tabScoped": true,
      "accessMode": "write",
      "required": [
        "identifier"
      ]
    },
    "html.get": {
      "domain": "html",
      "tabScoped": true,
      "accessMode": "read"
    },
    "screenshot.capture": {
      "domain": "screenshot",
      "tabScoped": true,
      "accessMode": "read"
    },
    "evidence.collect": {
      "domain": "evidence",
      "tabScoped": true,
      "accessMode": "read"
    },
    "ws.open": {
      "domain": "ws",
      "tabScoped": true,
      "accessMode": "write",
      "required": [
        "url"
      ]
    },
    "ws.status": {
      "domain": "ws",
      "tabScoped": true,
      "accessMode": "read"
    },
    "ws.send": {
      "domain": "ws",
      "tabScoped": true,
      "accessMode": "write",
      "requiredAny": [
        [
          "text"
        ],
        [
          "message"
        ]
      ]
    },
    "ws.replay": {
      "domain": "ws",
      "tabScoped": true,
      "accessMode": "write",
      "required": [
        "steps"
      ]
    },
    "ws.wait": {
      "domain": "ws",
      "tabScoped": true,
      "accessMode": "read"
    },
    "ws.collect": {
      "domain": "ws",
      "tabScoped": true,
      "accessMode": "read"
    },
    "ws.close": {
      "domain": "ws",
      "tabScoped": true,
      "accessMode": "write"
    },
    "transfer.download": {
      "domain": "transfer",
      "tabScoped": true,
      "accessMode": "write",
      "requiredAny": [
        [
          "selector"
        ],
        [
          "url"
        ]
      ]
    },
    "transfer.upload": {
      "domain": "transfer",
      "tabScoped": true,
      "accessMode": "write",
      "required": [
        "selector",
        "files"
      ]
    },
    "hook.list_targets": {
      "domain": "hook",
      "tabScoped": false,
      "accessMode": "read"
    },
    "hook.install_targets": {
      "domain": "hook",
      "tabScoped": true,
      "accessMode": "write",
      "required": [
        "targets"
      ]
    }
  },
  "errorCodes": {
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
    "REF_NOT_FOUND": {
      "category": "abml.ref",
      "retryable": true,
      "summary": "ABML ref was not found."
    },
    "REF_STALE": {
      "category": "abml.ref",
      "retryable": true,
      "summary": "ABML ref is stale."
    },
    "REF_AMBIGUOUS": {
      "category": "abml.ref",
      "retryable": true,
      "summary": "ABML ref resolved ambiguously."
    },
    "REF_SCOPE_VIOLATION": {
      "category": "abml.session",
      "retryable": true,
      "summary": "ABML ref scope does not match the current session, tab, or origin."
    },
    "HANDLE_NOT_FOUND": {
      "category": "abml.ref",
      "retryable": true,
      "summary": "Referenced handle was not found."
    },
    "HANDLE_EXPIRED": {
      "category": "abml.ref",
      "retryable": true,
      "summary": "Referenced handle expired."
    },
    "HANDLE_KIND_MISMATCH": {
      "category": "abml.input",
      "retryable": false,
      "summary": "Referenced handle kind does not match the expected kind."
    },
    "HANDLE_ETAG_MISMATCH": {
      "category": "abml.ref",
      "retryable": true,
      "summary": "Referenced handle etag does not match the current artifact."
    },
    "PRIVACY_BLOCKED": {
      "category": "abml.privacy",
      "retryable": false,
      "summary": "Requested access is blocked by ABML privacy policy."
    },
    "ACTIONABILITY_TIMEOUT": {
      "category": "abml.actionability",
      "retryable": true,
      "summary": "Target did not satisfy actionability predicates before timeout."
    },
    "TARGET_OCCLUDED": {
      "category": "abml.actionability",
      "retryable": true,
      "summary": "Target is occluded and cannot receive events."
    },
    "TARGET_DISABLED": {
      "category": "abml.actionability",
      "retryable": true,
      "summary": "Target is disabled."
    },
    "TARGET_NOT_EDITABLE": {
      "category": "abml.actionability",
      "retryable": false,
      "summary": "Target is not editable."
    },
    "BACKEND_UNAVAILABLE": {
      "category": "abml.backend",
      "retryable": true,
      "summary": "Required backend is unavailable."
    },
    "CROSS_ORIGIN_BLOCKED": {
      "category": "abml.backend",
      "retryable": false,
      "summary": "Requested operation is blocked by cross-origin frame boundaries."
    },
    "VERIFY_FAILED": {
      "category": "abml.verification",
      "retryable": true,
      "summary": "Post-action verification failed."
    },
    "VERIFY_INCONCLUSIVE": {
      "category": "abml.verification",
      "retryable": true,
      "summary": "Post-action verification was inconclusive."
    },
    "INVALID_INPUT": {
      "category": "abml.input",
      "retryable": false,
      "summary": "Input is invalid."
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
    },
    "MEMORY_ACTION_UNSUPPORTED": {
      "category": "tool.memory",
      "retryable": false,
      "summary": "browser_memory action is unsupported."
    },
    "UNSUPPORTED_SCOPE_KIND": {
      "category": "tool.memory",
      "retryable": false,
      "summary": "browser_memory scopeKind is unsupported."
    },
    "MEMORY_SCOPE_REQUIRED": {
      "category": "tool.memory",
      "retryable": false,
      "summary": "browser_memory requires scopeKey or url for the selected scope."
    },
    "MEMORY_EVIDENCE_REQUIRED": {
      "category": "tool.memory",
      "retryable": false,
      "summary": "browser_memory requires at least one durable readable evidence reference."
    },
    "MEMORY_EVIDENCE_UNREADABLE": {
      "category": "tool.memory",
      "retryable": false,
      "summary": "browser_memory evidence could not be read."
    },
    "MEMORY_EVIDENCE_STALE": {
      "category": "tool.memory",
      "retryable": false,
      "summary": "browser_memory evidence is stale."
    },
    "MEMORY_EVIDENCE_UNRESOLVABLE": {
      "category": "tool.memory",
      "retryable": false,
      "summary": "browser_memory evidence handle could not be resolved."
    },
    "MEMORY_SECRET_DETECTED": {
      "category": "tool.memory",
      "retryable": false,
      "summary": "browser_memory payload contains blocked or sensitive content."
    },
    "MEMORY_SCHEMA_INVALID": {
      "category": "tool.memory",
      "retryable": false,
      "summary": "browser_memory payload or persisted entry schema is invalid."
    },
    "MEMORY_ENTRY_NOT_FOUND": {
      "category": "tool.memory",
      "retryable": false,
      "summary": "Requested browser_memory entry was not found."
    },
    "MEMORY_RESOURCE_STALE": {
      "category": "tool.memory",
      "retryable": false,
      "summary": "browser-memory resource is stale."
    },
    "RESOURCE_NOT_FOUND": {
      "category": "abml.ref",
      "retryable": false,
      "summary": "Referenced browser-result resource was not found."
    },
    "RESOURCE_STALE": {
      "category": "abml.ref",
      "retryable": true,
      "summary": "Referenced browser-result resource is stale; re-capture to mint a fresh handle."
    },
    "RESOURCE_READ_ERROR": {
      "category": "abml.ref",
      "retryable": false,
      "summary": "Failed to read the referenced browser-result resource."
    }
  },
  "toolMetadata": {
    "nativeActionTools": {
      "browser_wait": {
        "domain": "wait",
        "parameters": [
          "action",
          "params",
          "tabId",
          "detailLevel",
          "outputPath",
          "timeoutMs",
          "maxChars",
          "sessionId"
        ],
        "actionDescription": "navigate | navigateAndWait | navigation | loadState | networkIdle | selector | any | all (non-empty waits/conditions) | cancel | diagnose",
        "actions": [
          {
            "action": "navigate",
            "command": "wait.navigate",
            "aliases": [
              "navigate"
            ]
          },
          {
            "action": "navigateAndWait",
            "command": "wait.navigateAndWait",
            "aliases": [
              "navigateAndWait"
            ]
          },
          {
            "action": "navigation",
            "command": "wait.navigation",
            "aliases": [
              "waitForNavigation",
              "navigation"
            ]
          },
          {
            "action": "loadState",
            "command": "wait.loadState",
            "aliases": [
              "loadState",
              "waitForLoadState"
            ]
          },
          {
            "action": "networkIdle",
            "command": "wait.networkIdle",
            "aliases": [
              "networkIdle",
              "waitForNetworkIdle"
            ]
          },
          {
            "action": "selector",
            "command": "wait.selector",
            "aliases": [
              "selector",
              "waitForSelector"
            ]
          },
          {
            "action": "any",
            "command": "wait.any",
            "aliases": [
              "any",
              "waitForAny"
            ]
          },
          {
            "action": "all",
            "command": "wait.all",
            "aliases": [
              "all",
              "waitForAll"
            ]
          },
          {
            "action": "cancel",
            "command": "wait.cancel",
            "aliases": [
              "cancel",
              "cancelWait"
            ]
          },
          {
            "action": "diagnose",
            "command": "wait.diagnose",
            "aliases": [
              "diagnose"
            ]
          }
        ]
      },
      "browser_network": {
        "domain": "network",
        "parameters": [
          "action",
          "params",
          "tabId",
          "detailLevel",
          "outputPath",
          "timeoutMs",
          "maxChars",
          "sessionId"
        ],
        "actionDescription": "start | stop | status | clear | list | get | body | exportHar | wait",
        "actions": [
          {
            "action": "start",
            "command": "network.start",
            "aliases": [
              "start"
            ]
          },
          {
            "action": "stop",
            "command": "network.stop",
            "aliases": [
              "stop"
            ]
          },
          {
            "action": "status",
            "command": "network.status",
            "aliases": [
              "status"
            ]
          },
          {
            "action": "clear",
            "command": "network.clear",
            "aliases": [
              "clear"
            ]
          },
          {
            "action": "list",
            "command": "network.list",
            "aliases": [
              "list"
            ]
          },
          {
            "action": "get",
            "command": "network.get",
            "aliases": [
              "get"
            ]
          },
          {
            "action": "body",
            "command": "network.body",
            "aliases": [
              "body"
            ]
          },
          {
            "action": "exportHar",
            "command": "network.exportHar",
            "aliases": [
              "exportHar",
              "export"
            ]
          },
          {
            "action": "wait",
            "command": "network.wait",
            "aliases": [
              "wait"
            ]
          }
        ]
      },
      "browser_hook": {
        "domain": "hook",
        "parameters": [
          "action",
          "params",
          "tabId",
          "detailLevel",
          "outputPath",
          "timeoutMs",
          "maxChars",
          "sessionId"
        ],
        "actionDescription": "listTargets | installTargets | install | collect | status | clear | pause | resume | uninstall | evaluate | addEventListener | removeEventListener | performance | listSessions | getNodeListeners | getListenerChain | getSinkHints",
        "actions": [
          {
            "action": "listTargets",
            "command": "hook.list_targets",
            "aliases": [
              "listTargets",
              "targets",
              "targetList"
            ]
          },
          {
            "action": "installTargets",
            "command": "hook.install_targets",
            "aliases": [
              "installTargets",
              "targetInstall"
            ]
          },
          {
            "action": "listSessions",
            "command": "hook.list_sessions",
            "aliases": [
              "listSessions",
              "sessions"
            ]
          },
          {
            "action": "install",
            "command": "hook.install",
            "aliases": [
              "install"
            ]
          },
          {
            "action": "status",
            "command": "hook.status",
            "aliases": [
              "status"
            ]
          },
          {
            "action": "collect",
            "command": "hook.collect",
            "aliases": [
              "collect"
            ]
          },
          {
            "action": "clear",
            "command": "hook.clear",
            "aliases": [
              "clear"
            ]
          },
          {
            "action": "clearBuffer",
            "command": "hook.clear_buffer",
            "aliases": [
              "clearBuffer"
            ]
          },
          {
            "action": "pause",
            "command": "hook.pause",
            "aliases": [
              "pause"
            ]
          },
          {
            "action": "resume",
            "command": "hook.resume",
            "aliases": [
              "resume"
            ]
          },
          {
            "action": "uninstall",
            "command": "hook.uninstall",
            "aliases": [
              "uninstall"
            ]
          },
          {
            "action": "evaluate",
            "command": "hook.evaluate",
            "aliases": [
              "evaluate"
            ]
          },
          {
            "action": "addEventListener",
            "command": "hook.addEventListener",
            "aliases": [
              "addEventListener"
            ]
          },
          {
            "action": "removeEventListener",
            "command": "hook.removeEventListener",
            "aliases": [
              "removeEventListener"
            ]
          },
          {
            "action": "performance",
            "command": "hook.getPerformanceEntries",
            "aliases": [
              "performance",
              "getPerformanceEntries"
            ]
          },
          {
            "action": "getNodeListeners",
            "command": "hook.getNodeListeners",
            "aliases": [
              "getNodeListeners",
              "listeners"
            ]
          },
          {
            "action": "getListenerChain",
            "command": "hook.getListenerChain",
            "aliases": [
              "getListenerChain",
              "listenerChain"
            ]
          },
          {
            "action": "getSinkHints",
            "command": "hook.getSinkHints",
            "aliases": [
              "getSinkHints",
              "sinkHints"
            ]
          }
        ]
      },
      "browser_frame": {
        "domain": "frame",
        "parameters": [
          "action",
          "params",
          "tabId",
          "detailLevel",
          "outputPath",
          "timeoutMs",
          "maxChars"
        ],
        "actionDescription": "list | evaluate | addNewDocumentScript | removeNewDocumentScript",
        "actions": [
          {
            "action": "list",
            "command": "frame.list",
            "aliases": [
              "list",
              "frames"
            ]
          },
          {
            "action": "evaluate",
            "command": "frame.evaluate",
            "aliases": [
              "evaluate"
            ]
          },
          {
            "action": "addNewDocumentScript",
            "command": "frame.addNewDocumentScript",
            "aliases": [
              "addNewDocumentScript",
              "addScript"
            ]
          },
          {
            "action": "removeNewDocumentScript",
            "command": "frame.removeNewDocumentScript",
            "aliases": [
              "removeNewDocumentScript",
              "removeScript"
            ]
          }
        ]
      }
    },
    "nativeCommandTools": {
      "browser_evidence": {
        "domain": "evidence",
        "command": "evidence.collect",
        "parameters": [
          "params",
          "tabId",
          "detailLevel",
          "outputPath",
          "timeoutMs",
          "maxChars",
          "sessionId",
          "eventTypes",
          "includeHook",
          "includeNetwork",
          "includePerformance"
        ],
        "artifactPrefix": "evidence"
      },
      "browser_screenshot": {
        "domain": "screenshot",
        "command": "screenshot.capture",
        "parameters": [
          "tabId",
          "outputPath",
          "timeoutMs",
          "maxChars",
          "format",
          "quality",
          "captureBeyondViewport",
          "fallback"
        ],
        "artifactPrefix": "screenshot"
      },
      "browser_observe_html": {
        "domain": "html",
        "displayName": "browser_observe (mode=html)",
        "command": "html.get",
        "parameters": [
          "selector",
          "htmlMode",
          "params",
          "tabId",
          "detailLevel",
          "outputPath",
          "timeoutMs",
          "maxChars"
        ],
        "artifactPrefix": "observe-html"
      }
    },
    "transferTools": {
      "browser_download": {
        "domain": "transfer",
        "command": "transfer.download",
        "parameters": [
          "tabId",
          "detailLevel",
          "outputPath",
          "timeoutMs",
          "maxChars",
          "selector",
          "url",
          "mode",
          "index",
          "filename",
          "conflictAction",
          "saveAs"
        ],
        "artifactPrefix": "download"
      },
      "browser_upload": {
        "domain": "transfer",
        "command": "transfer.upload",
        "parameters": [
          "tabId",
          "detailLevel",
          "outputPath",
          "timeoutMs",
          "maxChars",
          "selector",
          "files",
          "index",
          "confirm"
        ],
        "artifactPrefix": "upload"
      }
    }
  }
} as PiProtocolSchema;

  function isObject(value: unknown): value is PiBridgeCommand {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function hasValue(value: unknown): boolean {
    return value !== undefined && value !== null && value !== '';
  }

  function toTabId(value: unknown): number | undefined {
    const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }

  function allCommands(): string[] {
    return Object.keys(schema.commands || {});
  }

  function nativeCommands(): string[] {
    const domains = schema.domains || {};
    const out: string[] = [];
    for (const [domain, names] of Object.entries(domains)) {
      if (domain === 'core' || !Array.isArray(names)) continue;
      for (const name of names) out.push(name);
    }
    return out;
  }

  function canonicalCommand(cmd: unknown): string {
    const key = String(cmd || '');
    const direct = schema.commands && schema.commands[key];
    if (direct && direct.canonical) return direct.canonical;
    return (schema.aliases && schema.aliases[key]) || key;
  }

  function nativeCommandMap(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const cmd of nativeCommands()) out[cmd] = canonicalCommand(cmd);
    for (const [alias, target] of Object.entries(schema.aliases || {})) {
      if (out[target] || (schema.commands && schema.commands[target] && schema.commands[target].domain !== 'core')) out[alias] = target;
    }
    return out;
  }

  function missingRequired(command: JsonRecord, required?: string[]): string[] {
    return (required || []).filter((field) => !hasValue(command[field]));
  }

  function requiredAnySatisfied(command: JsonRecord, groups?: string[][]): boolean {
    if (!Array.isArray(groups) || groups.length === 0) return true;
    return groups.some((group) => Array.isArray(group) && group.every((field) => hasValue(command[field])));
  }

  function validateCommand(command: unknown, options?: { allowMissingTabId?: boolean }) {
    const opts = options || {};
    if (!isObject(command)) return { ok: false, error: 'Bridge command must be an object', details: { commandType: typeof command } };
    if (typeof command.cmd !== 'string' || !command.cmd.trim()) return { ok: false, error: 'Bridge command requires string cmd', details: { cmd: command.cmd } };

    const cmd = command.cmd.trim();
    const canonical = canonicalCommand(cmd);
    const spec = (schema.commands && (schema.commands[cmd] || schema.commands[canonical])) || null;
    if (!spec) return { ok: false, error: 'Unknown bridge command: ' + cmd, details: { cmd } };

    const checked = Object.assign({}, command, { cmd });
    const methods = Array.isArray(spec.methods) ? spec.methods : [];
    let methodSpec: PiCommandSpec | null = null;
    if (methods.length) {
      const rawMethod = hasValue(checked.method) ? String(checked.method) : spec.defaultMethod;
      if (spec.methodRequired && !hasValue(rawMethod)) return { ok: false, error: cmd + ' requires method', details: { cmd } };
      if (hasValue(rawMethod) && !methods.includes(String(rawMethod))) {
        return { ok: false, error: 'Unsupported method for ' + cmd + ': ' + rawMethod, details: { cmd, method: rawMethod, supported: methods } };
      }
      if (hasValue(rawMethod)) {
        checked.method = String(rawMethod);
        methodSpec = spec.methodSpecs && spec.methodSpecs[String(rawMethod)] || null;
      }
    }

    const missing = missingRequired(checked, spec.required).concat(missingRequired(checked, methodSpec?.required));
    if (missing.length) return { ok: false, error: cmd + ' missing required fields: ' + missing.join(', '), details: { cmd, missing } };

    const anyGroups: string[][] = [];
    if (Array.isArray(spec.requiredAny)) anyGroups.push.apply(anyGroups, spec.requiredAny);
    if (methodSpec && Array.isArray(methodSpec.requiredAny)) anyGroups.push.apply(anyGroups, methodSpec.requiredAny);
    if (!requiredAnySatisfied(checked, anyGroups)) return { ok: false, error: cmd + ' requires one of field groups', details: { cmd, requiredAny: anyGroups } };

    if (spec.tabScoped && !opts.allowMissingTabId && toTabId(checked.tabId) === undefined) {
      return { ok: false, error: cmd + ' requires tabId', details: { cmd, tabId: checked.tabId } };
    }

    return { ok: true, command: checked, spec, canonicalCmd: canonical };
  }

  const protocol = {
    schema,
    aliases: schema.aliases || {},
    commandNames: allCommands(),
    nativeCommands: nativeCommands(),
    nativeCommandMap: nativeCommandMap(),
    canonicalCommand,
    validateCommand
  };
  global.PiNativeProtocol = protocol;
})(typeof self !== 'undefined' ? self : globalThis);
export const PiNativeProtocol = (globalThis as typeof globalThis & { PiNativeProtocol?: unknown }).PiNativeProtocol;
// ESM module metadata
export const __piBridgeModule_protocol = { name: "protocol", symbols: { PiNativeProtocol } };
