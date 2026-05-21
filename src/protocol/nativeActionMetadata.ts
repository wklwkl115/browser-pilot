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

export function commandForNativeToolAction(toolName: NativeActionToolName, action: string): string {
	const metadata = nativeToolMetadata.nativeActionTools[toolName];
	const command = (metadata.actionAliases as Record<string, string>)[normalizeNativeToolAction(action)];
	if (!command) throw new Error(`Unsupported ${toolName} action: ${action}`);
	return command;
}

export const nativeTransferToolMetadata = nativeToolMetadata.transferTools;
