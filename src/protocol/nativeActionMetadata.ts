// Generated from bridge/native_command_schema.json. Do not edit by hand.
export const nativeToolMetadata = {
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
      ],
      "actionAliases": {
        "navigate": "wait.navigate",
        "navigateandwait": "wait.navigateAndWait",
        "waitfornavigation": "wait.navigation",
        "navigation": "wait.navigation",
        "loadstate": "wait.loadState",
        "waitforloadstate": "wait.loadState",
        "networkidle": "wait.networkIdle",
        "waitfornetworkidle": "wait.networkIdle",
        "selector": "wait.selector",
        "waitforselector": "wait.selector",
        "any": "wait.any",
        "waitforany": "wait.any",
        "all": "wait.all",
        "waitforall": "wait.all",
        "cancel": "wait.cancel",
        "cancelwait": "wait.cancel",
        "diagnose": "wait.diagnose"
      }
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
      "actionDescription": "listTargets | installTargets | install | collect | status | clear | pause | resume | uninstall | evaluate | addEventListener | removeEventListener | performance | listSessions",
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
        "clear": "hook.clear",
        "clearbuffer": "hook.clear_buffer",
        "pause": "hook.pause",
        "resume": "hook.resume",
        "uninstall": "hook.uninstall",
        "evaluate": "hook.evaluate",
        "addeventlistener": "hook.addEventListener",
        "removeeventlistener": "hook.removeEventListener",
        "performance": "hook.getPerformanceEntries",
        "getperformanceentries": "hook.getPerformanceEntries"
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
export type NativeCommandToolName = keyof typeof nativeToolMetadata.nativeCommandTools;
export type NativeTransferToolName = keyof typeof nativeToolMetadata.transferTools;

export function normalizeNativeToolAction(action: string): string {
	return action.trim().toLowerCase().replace(/[_.-]/g, "");
}

export function commandForNativeToolAction(toolName: NativeActionToolName, action: string): string {
	const metadata = nativeToolMetadata.nativeActionTools[toolName];
	const command = (metadata.actionAliases as Record<string, string>)[normalizeNativeToolAction(action)];
	if (!command) throw new Error(`Unsupported ${toolName} action: ${action}`);
	return command;
}

export const nativeCommandToolMetadata = nativeToolMetadata.nativeCommandTools;
export const nativeTransferToolMetadata = nativeToolMetadata.transferTools;

export function metadataForNativeCommandTool(toolName: NativeCommandToolName) {
	return nativeCommandToolMetadata[toolName];
}

export function metadataForNativeTransferTool(toolName: NativeTransferToolName) {
	return nativeTransferToolMetadata[toolName];
}
