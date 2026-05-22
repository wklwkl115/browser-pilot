import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "bridge", "browser_bridge_config.json");
const bridgeConfigPath = path.join(root, "bridge_src", "service_worker", "config.ts");
const tsConfigPath = path.join(root, "src", "driver", "browserBridgeConfig.ts");

function assertConfig(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("browser bridge config must be an object");
	const host = String(value.host || "").trim();
	const port = Number(value.port);
	const requestElementId = String(value.requestElementId || "").trim();
	if (!host) throw new Error("browser bridge config requires host");
	if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("browser bridge config requires port 1..65535");
	if (!requestElementId) throw new Error("browser bridge config requires requestElementId");
	return { host, port, requestElementId };
}

const config = assertConfig(JSON.parse(readFileSync(sourcePath, "utf8")));
const wsUrl = `ws://${config.host}:${config.port}`;
const httpUrl = `http://${config.host}:${config.port}`;

const bridgeConfig = `// Generated from bridge/browser_bridge_config.json. Do not edit by hand.
const TID = ${JSON.stringify(config.requestElementId)};
const PI_BROWSER_BRIDGE_HOST = ${JSON.stringify(config.host)};
const PI_BROWSER_BRIDGE_PORT = ${JSON.stringify(config.port)};
const PI_BROWSER_BRIDGE_WS_URL = ${JSON.stringify(wsUrl)};
const PI_BROWSER_BRIDGE_HTTP_URL = ${JSON.stringify(httpUrl)};
const PI_BROWSER_MANAGED_PROFILE_B64 = String((globalThis as { __PI_BROWSER_MANAGED_PROFILE_B64__?: string }).__PI_BROWSER_MANAGED_PROFILE_B64__ || "__PI_BROWSER_MANAGED_PROFILE_B64__");
const PI_BROWSER_MANAGED_PROFILE = PI_BROWSER_MANAGED_PROFILE_B64 === "__PI_BROWSER_MANAGED_PROFILE_B64__" ? null : JSON.parse(atob(PI_BROWSER_MANAGED_PROFILE_B64));
// ESM module boundary marker for TODO 189
export { TID, PI_BROWSER_BRIDGE_HOST, PI_BROWSER_BRIDGE_PORT, PI_BROWSER_BRIDGE_WS_URL, PI_BROWSER_BRIDGE_HTTP_URL, PI_BROWSER_MANAGED_PROFILE };
export const __piBridgeModule_config = { name: "config", symbols: { TID, PI_BROWSER_BRIDGE_HOST, PI_BROWSER_BRIDGE_PORT, PI_BROWSER_BRIDGE_WS_URL, PI_BROWSER_BRIDGE_HTTP_URL, PI_BROWSER_MANAGED_PROFILE } };
`;
writeFileSync(bridgeConfigPath, bridgeConfig, "utf8");

const tsConfig = `// Generated from bridge/browser_bridge_config.json. Do not edit by hand.
export const DEFAULT_BROWSER_BRIDGE_HOST = ${JSON.stringify(config.host)};
export const DEFAULT_BROWSER_BRIDGE_PORT = ${JSON.stringify(config.port)};
`;
writeFileSync(tsConfigPath, tsConfig, "utf8");

console.log(`synced browser bridge config: ${path.relative(root, bridgeConfigPath)}, ${path.relative(root, tsConfigPath)}`);
