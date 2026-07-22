import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "bridge", "browser_bridge_config.json");
const serviceWorkerConfigPath = path.join(root, "src/bridge/extension", "service_worker", "config.ts");
const tsConfigPath = path.join(root, "src", "bridge", "server", "browserBridgeConfig.ts");
const manifestPath = path.join(root, "src", "bridge", "extension", "static", "manifest.json");

function assertConfig(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("browser bridge config must be an object");
	const host = String(value.host || "").trim();
	const port = Number(value.port);
	const portRangeEnd = value.portRangeEnd === undefined ? port : Number(value.portRangeEnd);
	if (!host) throw new Error("browser bridge config requires host");
	if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("browser bridge config requires port 1..65535");
	if (!Number.isInteger(portRangeEnd) || portRangeEnd < port || portRangeEnd > 65535) throw new Error("browser bridge config requires portRangeEnd >= port and <= 65535");
	return { host, port, portRangeEnd };
}

const config = assertConfig(JSON.parse(readFileSync(sourcePath, "utf8")));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (typeof manifest.key !== "string" || !manifest.key) throw new Error("extension manifest requires a stable public key");
const extensionHash = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16);
const extensionId = Array.from(extensionHash, (byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join("");
const wsUrl = `ws://${config.host}:${config.port}`;
const httpUrl = `http://${config.host}:${config.port}`;

const bridgeConfig = `// Generated from bridge/browser_bridge_config.json. Do not edit by hand.
const BROWSER_PILOT_BRIDGE_HOST = ${JSON.stringify(config.host)};
const BROWSER_PILOT_BRIDGE_PORT = ${JSON.stringify(config.port)};
const BROWSER_PILOT_BRIDGE_PORT_RANGE_END = ${JSON.stringify(config.portRangeEnd)};
const BROWSER_PILOT_BRIDGE_WS_URL = ${JSON.stringify(wsUrl)};
const BROWSER_PILOT_BRIDGE_HTTP_URL = ${JSON.stringify(httpUrl)};
`;
const serviceWorkerConfig = `${bridgeConfig}export { BROWSER_PILOT_BRIDGE_HOST, BROWSER_PILOT_BRIDGE_PORT, BROWSER_PILOT_BRIDGE_PORT_RANGE_END, BROWSER_PILOT_BRIDGE_WS_URL, BROWSER_PILOT_BRIDGE_HTTP_URL };
`;
writeFileSync(serviceWorkerConfigPath, serviceWorkerConfig, "utf8");

const tsConfig = `// Generated from bridge/browser_bridge_config.json. Do not edit by hand.
export const DEFAULT_BROWSER_BRIDGE_HOST = ${JSON.stringify(config.host)};
export const DEFAULT_BROWSER_BRIDGE_PORT = ${JSON.stringify(config.port)};
export const DEFAULT_BROWSER_BRIDGE_PORT_RANGE_END = ${JSON.stringify(config.portRangeEnd)};
export const BROWSER_PILOT_EXTENSION_ID = ${JSON.stringify(extensionId)};
`;
writeFileSync(tsConfigPath, tsConfig, "utf8");

console.log(`synced browser bridge config: ${path.relative(root, serviceWorkerConfigPath)}, ${path.relative(root, tsConfigPath)}`);
