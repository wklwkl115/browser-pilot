import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "bridge", "browser_bridge_config.json");
const legacyBridgeConfigPath = path.join(root, "bridge", "pi_browser_bridge", "config.js");
const serviceWorkerConfigPath = path.join(root, "bridge_src", "service_worker", "config.ts");
const tsConfigPath = path.join(root, "src", "driver", "browserBridgeConfig.ts");

function assertConfig(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("browser bridge config must be an object");
	const host = String(value.host || "").trim();
	const port = Number(value.port);
	const portRangeEnd = value.portRangeEnd === undefined ? port : Number(value.portRangeEnd);
	const requestElementId = String(value.requestElementId || "").trim();
	if (!host) throw new Error("browser bridge config requires host");
	if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("browser bridge config requires port 1..65535");
	if (!Number.isInteger(portRangeEnd) || portRangeEnd < port || portRangeEnd > 65535) throw new Error("browser bridge config requires portRangeEnd >= port and <= 65535");
	if (!requestElementId) throw new Error("browser bridge config requires requestElementId");
	return { host, port, portRangeEnd, requestElementId };
}

const config = assertConfig(JSON.parse(readFileSync(sourcePath, "utf8")));
const wsUrl = `ws://${config.host}:${config.port}`;
const httpUrl = `http://${config.host}:${config.port}`;

const bridgeConfig = `// Generated from bridge/browser_bridge_config.json. Do not edit by hand.
const TID = ${JSON.stringify(config.requestElementId)};
const PI_BROWSER_BRIDGE_HOST = ${JSON.stringify(config.host)};
const PI_BROWSER_BRIDGE_PORT = ${JSON.stringify(config.port)};
const PI_BROWSER_BRIDGE_PORT_RANGE_END = ${JSON.stringify(config.portRangeEnd)};
const PI_BROWSER_BRIDGE_WS_URL = ${JSON.stringify(wsUrl)};
const PI_BROWSER_BRIDGE_HTTP_URL = ${JSON.stringify(httpUrl)};
`;
writeFileSync(legacyBridgeConfigPath, bridgeConfig, "utf8");

const serviceWorkerConfig = `${bridgeConfig}// ESM module boundary marker for TODO 189
export { TID, PI_BROWSER_BRIDGE_HOST, PI_BROWSER_BRIDGE_PORT, PI_BROWSER_BRIDGE_PORT_RANGE_END, PI_BROWSER_BRIDGE_WS_URL, PI_BROWSER_BRIDGE_HTTP_URL };
export const __piBridgeModule_config = { name: "config", symbols: { TID, PI_BROWSER_BRIDGE_HOST, PI_BROWSER_BRIDGE_PORT, PI_BROWSER_BRIDGE_PORT_RANGE_END, PI_BROWSER_BRIDGE_WS_URL, PI_BROWSER_BRIDGE_HTTP_URL } };
`;
writeFileSync(serviceWorkerConfigPath, serviceWorkerConfig, "utf8");

const tsConfig = `// Generated from bridge/browser_bridge_config.json. Do not edit by hand.
export const DEFAULT_BROWSER_BRIDGE_HOST = ${JSON.stringify(config.host)};
export const DEFAULT_BROWSER_BRIDGE_PORT = ${JSON.stringify(config.port)};
export const DEFAULT_BROWSER_BRIDGE_PORT_RANGE_END = ${JSON.stringify(config.portRangeEnd)};
`;
writeFileSync(tsConfigPath, tsConfig, "utf8");

console.log(`synced browser bridge config: ${path.relative(root, legacyBridgeConfigPath)}, ${path.relative(root, serviceWorkerConfigPath)}, ${path.relative(root, tsConfigPath)}`);
