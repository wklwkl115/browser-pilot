// Generated from bridge/native_command_schema.json. Do not edit by hand.
(function installPiNativeProtocol(global) {
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
      "contentSettings"
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
    "hook": [
      "hook.list_sessions",
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
      "hook.getPerformanceEntries"
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
    ]
  },
  "commands": {
    "bridge_wake": {
      "domain": "core",
      "tabScoped": false
    },
    "tabs": {
      "domain": "core",
      "tabScoped": false,
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
          ]
        },
        "close": {
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
      "methods": [
        "list",
        "reload",
        "disable",
        "enable"
      ],
      "methodSpecs": {
        "disable": {
          "required": [
            "extId"
          ]
        },
        "enable": {
          "required": [
            "extId"
          ]
        }
      }
    },
    "cookies": {
      "domain": "core",
      "tabScoped": false
    },
    "cdp": {
      "domain": "core",
      "tabScoped": true,
      "required": [
        "method"
      ]
    },
    "persistent_cdp": {
      "domain": "core",
      "tabScoped": true
    },
    "batch": {
      "domain": "core",
      "tabScoped": false,
      "required": [
        "commands"
      ]
    },
    "contentSettings": {
      "domain": "core",
      "tabScoped": false
    },
    "wait.navigate": {
      "domain": "wait",
      "tabScoped": true,
      "required": [
        "url"
      ]
    },
    "wait.navigateAndWait": {
      "domain": "wait",
      "tabScoped": true,
      "required": [
        "url"
      ]
    },
    "wait.navigation": {
      "domain": "wait",
      "tabScoped": true
    },
    "wait.loadState": {
      "domain": "wait",
      "tabScoped": true
    },
    "wait.networkIdle": {
      "domain": "wait",
      "tabScoped": true
    },
    "wait.selector": {
      "domain": "wait",
      "tabScoped": true,
      "required": [
        "selector"
      ]
    },
    "wait.any": {
      "domain": "wait",
      "tabScoped": true
    },
    "wait.all": {
      "domain": "wait",
      "tabScoped": true
    },
    "wait.cancel": {
      "domain": "wait",
      "tabScoped": true
    },
    "wait.diagnose": {
      "domain": "wait",
      "tabScoped": true
    },
    "network.start": {
      "domain": "network",
      "tabScoped": true
    },
    "network.stop": {
      "domain": "network",
      "tabScoped": true
    },
    "network.status": {
      "domain": "network",
      "tabScoped": true
    },
    "network.clear": {
      "domain": "network",
      "tabScoped": true
    },
    "network.list": {
      "domain": "network",
      "tabScoped": true
    },
    "network.get": {
      "domain": "network",
      "tabScoped": true
    },
    "network.body": {
      "domain": "network",
      "tabScoped": true
    },
    "network.exportHar": {
      "domain": "network",
      "tabScoped": true
    },
    "network.wait": {
      "domain": "network",
      "tabScoped": true
    },
    "hook.list_sessions": {
      "domain": "hook",
      "tabScoped": false
    },
    "hook.install": {
      "domain": "hook",
      "tabScoped": true
    },
    "hook.status": {
      "domain": "hook",
      "tabScoped": true
    },
    "hook.collect": {
      "domain": "hook",
      "tabScoped": true
    },
    "hook.clear": {
      "domain": "hook",
      "tabScoped": true,
      "canonical": "hook.clear_buffer"
    },
    "hook.clear_buffer": {
      "domain": "hook",
      "tabScoped": true
    },
    "hook.pause": {
      "domain": "hook",
      "tabScoped": true
    },
    "hook.resume": {
      "domain": "hook",
      "tabScoped": true
    },
    "hook.uninstall": {
      "domain": "hook",
      "tabScoped": true
    },
    "hook.evaluate": {
      "domain": "hook",
      "tabScoped": true,
      "required": [
        "expression"
      ]
    },
    "hook.addEventListener": {
      "domain": "hook",
      "tabScoped": true,
      "required": [
        "eventType"
      ]
    },
    "hook.removeEventListener": {
      "domain": "hook",
      "tabScoped": true,
      "required": [
        "listenerId"
      ]
    },
    "hook.getPerformanceEntries": {
      "domain": "hook",
      "tabScoped": true
    },
    "frame.list": {
      "domain": "frame",
      "tabScoped": true
    },
    "frame.evaluate": {
      "domain": "frame",
      "tabScoped": true,
      "required": [
        "frameId",
        "expression"
      ]
    },
    "frame.addNewDocumentScript": {
      "domain": "frame",
      "tabScoped": true,
      "required": [
        "source"
      ]
    },
    "frame.removeNewDocumentScript": {
      "domain": "frame",
      "tabScoped": true,
      "required": [
        "identifier"
      ]
    },
    "html.get": {
      "domain": "html",
      "tabScoped": true
    },
    "screenshot.capture": {
      "domain": "screenshot",
      "tabScoped": true
    },
    "evidence.collect": {
      "domain": "evidence",
      "tabScoped": true
    },
    "transfer.download": {
      "domain": "transfer",
      "tabScoped": true,
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
      "required": [
        "selector",
        "files"
      ]
    }
  }
};

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function hasValue(value) {
    return value !== undefined && value !== null && value !== '';
  }

  function toTabId(value) {
    const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }

  function allCommands() {
    return Object.keys(schema.commands || {});
  }

  function nativeCommands() {
    const domains = schema.domains || {};
    const out = [];
    for (const [domain, names] of Object.entries(domains)) {
      if (domain === 'core' || !Array.isArray(names)) continue;
      for (const name of names) out.push(name);
    }
    return out;
  }

  function canonicalCommand(cmd) {
    const direct = schema.commands && schema.commands[cmd];
    if (direct && direct.canonical) return direct.canonical;
    return (schema.aliases && schema.aliases[cmd]) || cmd;
  }

  function nativeCommandMap() {
    const out = {};
    for (const cmd of nativeCommands()) out[cmd] = canonicalCommand(cmd);
    for (const [alias, target] of Object.entries(schema.aliases || {})) {
      if (out[target] || (schema.commands && schema.commands[target] && schema.commands[target].domain !== 'core')) out[alias] = target;
    }
    return out;
  }

  function missingRequired(command, required) {
    return (required || []).filter((field) => !hasValue(command[field]));
  }

  function requiredAnySatisfied(command, groups) {
    if (!Array.isArray(groups) || groups.length === 0) return true;
    return groups.some((group) => Array.isArray(group) && group.every((field) => hasValue(command[field])));
  }

  function validateCommand(command, options) {
    const opts = options || {};
    if (!isObject(command)) return { ok: false, error: 'Bridge command must be an object', details: { commandType: typeof command } };
    if (typeof command.cmd !== 'string' || !command.cmd.trim()) return { ok: false, error: 'Bridge command requires string cmd', details: { cmd: command.cmd } };

    const cmd = command.cmd.trim();
    const canonical = canonicalCommand(cmd);
    const spec = (schema.commands && (schema.commands[cmd] || schema.commands[canonical])) || null;
    if (!spec) return { ok: false, error: 'Unknown bridge command: ' + cmd, details: { cmd } };

    const checked = Object.assign({}, command, { cmd });
    const methods = Array.isArray(spec.methods) ? spec.methods : [];
    let methodSpec = null;
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

    const missing = missingRequired(checked, spec.required).concat(missingRequired(checked, methodSpec && methodSpec.required));
    if (missing.length) return { ok: false, error: cmd + ' missing required fields: ' + missing.join(', '), details: { cmd, missing } };

    const anyGroups = [];
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
