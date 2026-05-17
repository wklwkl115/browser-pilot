import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "bridge", "native_command_schema.json");
const bridgeSchemaPath = path.join(root, "bridge", "pi_browser_bridge", "native_command_schema.json");
const protocolPath = path.join(root, "bridge", "pi_browser_bridge", "protocol.js");

const schema = JSON.parse(readFileSync(sourcePath, "utf8"));
const schemaText = JSON.stringify(schema, null, 2) + "\n";
writeFileSync(bridgeSchemaPath, schemaText, "utf8");

const protocol = `// Generated from bridge/native_command_schema.json. Do not edit by hand.
(function installPiNativeProtocol(global) {
  'use strict';
  const schema = ${JSON.stringify(schema, null, 2)};

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
`;
writeFileSync(protocolPath, protocol, "utf8");
console.log(`synced native protocol: ${path.relative(root, bridgeSchemaPath)}, ${path.relative(root, protocolPath)}`);
