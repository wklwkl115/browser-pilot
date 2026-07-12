// Generated from src/bridge/protocol/native-command.schema.json. Do not edit by hand.
export const nativeToolMetadata = {
  "nativeActionTools": {
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
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {
              "maxEntries": {
                "type": "number"
              },
              "maxAgeMs": {
                "type": "number"
              },
              "maxBodyBytes": {
                "type": "number"
              },
              "maxPostDataBytes": {
                "type": "number"
              },
              "maxFrames": {
                "type": "number"
              },
              "maxFrameBytes": {
                "type": "number"
              },
              "maxSseEvents": {
                "type": "number"
              },
              "captureBodies": {
                "type": "boolean"
              },
              "captureRequestPostData": {
                "type": "boolean"
              },
              "includeWebSocketFrames": {
                "type": "boolean"
              },
              "includeSse": {
                "type": "boolean"
              },
              "bodyTimeoutMs": {
                "type": "number"
              },
              "bodyMimeAllow": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "includeUrls": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "excludeUrls": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "resourceTypes": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "methods": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "statuses": {
                "type": "array",
                "items": {
                  "type": "number"
                }
              },
              "clear": {
                "type": "boolean"
              },
              "storeHeaders": {
                "type": "boolean"
              },
              "reconfigure": {
                "type": "boolean"
              }
            },
            "additionalProperties": false
          }
        },
        {
          "action": "stop",
          "command": "network.stop",
          "aliases": [
            "stop"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {
              "keepBuffer": {
                "type": "boolean"
              },
              "clear": {
                "type": "boolean"
              },
              "reason": {
                "type": "string"
              },
              "remove": {
                "type": "boolean"
              }
            },
            "additionalProperties": false
          }
        },
        {
          "action": "status",
          "command": "network.status",
          "aliases": [
            "status"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": false
          }
        },
        {
          "action": "clear",
          "command": "network.clear",
          "aliases": [
            "clear"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": false
          }
        },
        {
          "action": "list",
          "command": "network.list",
          "aliases": [
            "list"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {
              "limit": {
                "type": "number"
              },
              "offset": {
                "type": "number"
              },
              "sinceSeq": {
                "type": "number"
              },
              "requestId": {
                "type": "string"
              },
              "url": {
                "type": "string"
              },
              "urlContains": {
                "type": "string"
              },
              "urlPattern": {
                "type": "string"
              },
              "method": {
                "type": "string"
              },
              "type": {
                "type": "string"
              },
              "mime": {
                "type": "string"
              },
              "status": {
                "type": "number"
              },
              "includeUrls": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "excludeUrls": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "includeDetails": {
                "type": "boolean"
              },
              "includeBody": {
                "type": "boolean"
              }
            },
            "additionalProperties": false
          }
        },
        {
          "action": "get",
          "command": "network.get",
          "aliases": [
            "get"
          ],
          "required": [
            "requestId"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {
              "requestId": {
                "type": "string"
              },
              "includeBody": {
                "type": "boolean"
              }
            },
            "required": [
              "requestId"
            ],
            "additionalProperties": false
          }
        },
        {
          "action": "body",
          "command": "network.body",
          "aliases": [
            "body"
          ],
          "requiredAny": [
            [
              "bodyRef"
            ],
            [
              "requestId"
            ]
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {
              "bodyRef": {
                "type": "string"
              },
              "requestId": {
                "type": "string"
              },
              "maxBytes": {
                "type": "number"
              }
            },
            "requiredAny": [
              [
                "bodyRef"
              ],
              [
                "requestId"
              ]
            ],
            "anyOf": [
              {
                "required": [
                  "bodyRef"
                ]
              },
              {
                "required": [
                  "requestId"
                ]
              }
            ],
            "additionalProperties": false
          }
        },
        {
          "action": "exportHar",
          "command": "network.exportHar",
          "aliases": [
            "exportHar",
            "export"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {
              "format": {
                "enum": [
                  "har",
                  "json"
                ]
              },
              "includeBody": {
                "type": "boolean"
              },
              "sinceSeq": {
                "type": "number"
              },
              "url": {
                "type": "string"
              },
              "urlContains": {
                "type": "string"
              },
              "urlPattern": {
                "type": "string"
              },
              "method": {
                "type": "string"
              },
              "type": {
                "type": "string"
              },
              "mime": {
                "type": "string"
              },
              "status": {
                "type": "number"
              },
              "includeUrls": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "excludeUrls": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            },
            "additionalProperties": false
          }
        },
        {
          "action": "wait",
          "command": "network.wait",
          "aliases": [
            "wait"
          ]
        }
      ],
      "actionAliases": {
        "start": "network.start",
        "stop": "network.stop",
        "status": "network.status",
        "clear": "network.clear",
        "list": "network.list",
        "get": "network.get",
        "body": "network.body",
        "exporthar": "network.exportHar",
        "export": "network.exportHar",
        "wait": "network.wait"
      }
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
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": false
          }
        },
        {
          "action": "installTargets",
          "command": "hook.install_targets",
          "aliases": [
            "installTargets",
            "targetInstall"
          ],
          "required": [
            "targets"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {
              "targets": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "minItems": 1
              },
              "options": {
                "type": "object"
              },
              "bufferSize": {
                "type": "number"
              },
              "force": {
                "type": "boolean"
              },
              "expectedVersion": {
                "type": "string"
              },
              "installFingerprint": {
                "type": "string"
              }
            },
            "required": [
              "targets"
            ],
            "additionalProperties": false
          }
        },
        {
          "action": "listSessions",
          "command": "hook.list_sessions",
          "aliases": [
            "listSessions",
            "sessions"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": false
          }
        },
        {
          "action": "install",
          "command": "hook.install",
          "aliases": [
            "install"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {
              "targets": {
                "anyOf": [
                  {
                    "type": "array",
                    "items": {
                      "type": "string"
                    }
                  },
                  {
                    "type": "object"
                  }
                ]
              },
              "options": {
                "type": "object"
              },
              "bufferSize": {
                "type": "number"
              },
              "force": {
                "type": "boolean"
              },
              "expectedVersion": {
                "type": "string"
              },
              "installFingerprint": {
                "type": "string"
              }
            },
            "additionalProperties": false
          }
        },
        {
          "action": "status",
          "command": "hook.status",
          "aliases": [
            "status"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": false
          }
        },
        {
          "action": "collect",
          "command": "hook.collect",
          "aliases": [
            "collect"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {
              "sinceSeq": {
                "type": "number"
              },
              "limit": {
                "type": "number"
              },
              "eventTypes": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "minCount": {
                "type": "number"
              }
            },
            "additionalProperties": false
          }
        },
        {
          "action": "clearBuffer",
          "command": "hook.clear_buffer",
          "aliases": [
            "clearBuffer"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": false
          }
        },
        {
          "action": "pause",
          "command": "hook.pause",
          "aliases": [
            "pause"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": false
          }
        },
        {
          "action": "resume",
          "command": "hook.resume",
          "aliases": [
            "resume"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": false
          }
        },
        {
          "action": "uninstall",
          "command": "hook.uninstall",
          "aliases": [
            "uninstall"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": false
          }
        },
        {
          "action": "evaluate",
          "command": "hook.evaluate",
          "aliases": [
            "evaluate"
          ],
          "required": [
            "expression"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {
              "expression": {
                "type": "string"
              },
              "awaitPromise": {
                "type": "boolean"
              }
            },
            "required": [
              "expression"
            ],
            "additionalProperties": false
          }
        },
        {
          "action": "addEventListener",
          "command": "hook.addEventListener",
          "aliases": [
            "addEventListener"
          ],
          "required": [
            "eventType"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {
              "eventType": {
                "type": "string"
              },
              "listenerId": {
                "type": "string"
              },
              "selector": {
                "type": "string"
              },
              "diagnostics": {
                "type": "object"
              }
            },
            "required": [
              "eventType"
            ],
            "additionalProperties": false
          }
        },
        {
          "action": "removeEventListener",
          "command": "hook.removeEventListener",
          "aliases": [
            "removeEventListener"
          ],
          "required": [
            "listenerId"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {
              "listenerId": {
                "type": "string"
              }
            },
            "required": [
              "listenerId"
            ],
            "additionalProperties": false
          }
        },
        {
          "action": "performance",
          "command": "hook.getPerformanceEntries",
          "aliases": [
            "performance",
            "getPerformanceEntries"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {
              "entryType": {
                "type": "string"
              },
              "nameContains": {
                "type": "string"
              }
            },
            "additionalProperties": false
          }
        },
        {
          "action": "getNodeListeners",
          "command": "hook.getNodeListeners",
          "aliases": [
            "getNodeListeners",
            "listeners"
          ],
          "required": [
            "selector"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {
              "selector": {
                "type": "string"
              },
              "maxListeners": {
                "type": "number"
              }
            },
            "required": [
              "selector"
            ],
            "additionalProperties": false
          }
        },
        {
          "action": "getListenerChain",
          "command": "hook.getListenerChain",
          "aliases": [
            "getListenerChain",
            "listenerChain"
          ],
          "required": [
            "selector"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {
              "selector": {
                "type": "string"
              },
              "maxListeners": {
                "type": "number"
              }
            },
            "required": [
              "selector"
            ],
            "additionalProperties": false
          }
        },
        {
          "action": "getSinkHints",
          "command": "hook.getSinkHints",
          "aliases": [
            "getSinkHints",
            "sinkHints"
          ],
          "required": [
            "selector"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {
              "selector": {
                "type": "string"
              }
            },
            "required": [
              "selector"
            ],
            "additionalProperties": false
          }
        }
      ],
      "actionAliases": {
        "listtargets": "hook.list_targets",
        "targets": "hook.list_targets",
        "targetlist": "hook.list_targets",
        "installtargets": "hook.install_targets",
        "targetinstall": "hook.install_targets",
        "listsessions": "hook.list_sessions",
        "sessions": "hook.list_sessions",
        "install": "hook.install",
        "status": "hook.status",
        "collect": "hook.collect",
        "clearbuffer": "hook.clear_buffer",
        "pause": "hook.pause",
        "resume": "hook.resume",
        "uninstall": "hook.uninstall",
        "evaluate": "hook.evaluate",
        "addeventlistener": "hook.addEventListener",
        "removeeventlistener": "hook.removeEventListener",
        "performance": "hook.getPerformanceEntries",
        "getperformanceentries": "hook.getPerformanceEntries",
        "getnodelisteners": "hook.getNodeListeners",
        "listeners": "hook.getNodeListeners",
        "getlistenerchain": "hook.getListenerChain",
        "listenerchain": "hook.getListenerChain",
        "getsinkhints": "hook.getSinkHints",
        "sinkhints": "hook.getSinkHints"
      }
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
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {
              "options": {
                "type": "object"
              }
            },
            "additionalProperties": false
          }
        },
        {
          "action": "evaluate",
          "command": "frame.evaluate",
          "aliases": [
            "evaluate"
          ],
          "required": [
            "frameId",
            "expression"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {
              "frameId": {
                "type": "string"
              },
              "expression": {
                "type": "string"
              },
              "awaitPromise": {
                "type": "boolean"
              },
              "grantUniversalAccess": {
                "type": "boolean"
              },
              "returnByValue": {
                "type": "boolean"
              },
              "userGesture": {
                "type": "boolean"
              },
              "worldName": {
                "type": "string"
              },
              "options": {
                "type": "object"
              }
            },
            "required": [
              "frameId",
              "expression"
            ],
            "additionalProperties": false
          }
        },
        {
          "action": "addNewDocumentScript",
          "command": "frame.addNewDocumentScript",
          "aliases": [
            "addNewDocumentScript",
            "addScript"
          ],
          "required": [
            "source"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {
              "source": {
                "type": "string"
              },
              "runImmediately": {
                "type": "boolean"
              },
              "worldName": {
                "type": "string"
              },
              "includeCommandLineAPI": {
                "type": "boolean"
              },
              "options": {
                "type": "object"
              }
            },
            "required": [
              "source"
            ],
            "additionalProperties": false
          }
        },
        {
          "action": "removeNewDocumentScript",
          "command": "frame.removeNewDocumentScript",
          "aliases": [
            "removeNewDocumentScript",
            "removeScript"
          ],
          "required": [
            "identifier"
          ],
          "paramsSchema": {
            "type": "object",
            "properties": {
              "identifier": {
                "type": "string"
              },
              "options": {
                "type": "object"
              }
            },
            "required": [
              "identifier"
            ],
            "additionalProperties": false
          }
        }
      ],
      "actionAliases": {
        "list": "frame.list",
        "frames": "frame.list",
        "evaluate": "frame.evaluate",
        "addnewdocumentscript": "frame.addNewDocumentScript",
        "addscript": "frame.addNewDocumentScript",
        "removenewdocumentscript": "frame.removeNewDocumentScript",
        "removescript": "frame.removeNewDocumentScript"
      }
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
} as const;

export type NativeActionToolName = keyof typeof nativeToolMetadata.nativeActionTools;

export function normalizeNativeToolAction(action: string): string {
	return action.trim().toLowerCase().replace(/[_.-]/g, "");
}

export function commandForNativeToolAction(commandName: NativeActionToolName, action: string): string {
	const metadata = nativeToolMetadata.nativeActionTools[commandName];
	const command = (metadata.actionAliases as Record<string, string>)[normalizeNativeToolAction(action)];
	if (!command) throw new Error(`Unsupported ${commandName} action: ${action}`);
	return command;
}

export const nativeCommandToolMetadata = nativeToolMetadata.nativeCommandTools;
export const nativeTransferToolMetadata = nativeToolMetadata.transferTools;
