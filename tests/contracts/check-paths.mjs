import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserBridgeServer } from "../../src/driver/BrowserBridgeServer.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const bridge = path.join(root, "bridge", "pi_browser_bridge");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
assert.equal(existsSync(path.join(bridge, "manifest.json")), true, "native bridge manifest must exist");
assert.equal(path.win32.isAbsolute("D:\\Pi\\agent\\extensions\\pi-browser-tools\\bridge\\pi_browser_bridge"), true, "Windows bridge path must be absolute");
assert.equal(path.posix.normalize("/opt/pi-browser-tools/bridge/pi_browser_bridge"), "/opt/pi-browser-tools/bridge/pi_browser_bridge", "Linux bridge path must normalize");

const sourceConfig = JSON.parse(read("bridge/browser_bridge_config.json"));
const bridgeConfig = read("bridge/pi_browser_bridge/config.js");
const tsConfig = read("src/driver/browserBridgeConfig.ts");
assert.equal(sourceConfig.host, "127.0.0.1", "source bridge config host drifted");
assert.equal(sourceConfig.port, 18765, "source bridge config port drifted");
assert.equal(bridgeConfig.includes(`PI_BROWSER_BRIDGE_HOST = ${JSON.stringify(sourceConfig.host)}`), true, "bridge config.js host must be generated from source config");
assert.equal(bridgeConfig.includes(`PI_BROWSER_BRIDGE_PORT = ${JSON.stringify(sourceConfig.port)}`), true, "bridge config.js port must be generated from source config");
assert.equal(bridgeConfig.includes(`ws://${sourceConfig.host}:${sourceConfig.port}`), true, "bridge config.js ws URL must be generated from source config");
assert.equal(bridgeConfig.includes(`http://${sourceConfig.host}:${sourceConfig.port}`), true, "bridge config.js http URL must be generated from source config");
assert.equal(tsConfig.includes(`DEFAULT_BROWSER_BRIDGE_HOST = ${JSON.stringify(sourceConfig.host)}`), true, "TypeScript bridge config host must be generated from source config");
assert.equal(tsConfig.includes(`DEFAULT_BROWSER_BRIDGE_PORT = ${JSON.stringify(sourceConfig.port)}`), true, "TypeScript bridge config port must be generated from source config");
assert.equal(read("bridge/pi_browser_bridge/transport.js").includes("127.0.0.1:18765"), false, "transport.js must not hardcode bridge port");
assert.equal(read("src/driver/BrowserBridgeServer.ts").includes("const DEFAULT_PORT = 18765"), false, "BrowserBridgeServer must not hardcode bridge port");

const oldHost = process.env.PI_BROWSER_BRIDGE_HOST;
const oldPort = process.env.PI_BROWSER_BRIDGE_PORT;
try {
	process.env.PI_BROWSER_BRIDGE_HOST = "0.0.0.0";
	process.env.PI_BROWSER_BRIDGE_PORT = "18888";
	const configured = new BrowserBridgeServer();
	assert.equal(configured.host, "0.0.0.0");
	assert.equal(configured.port, 18888);

	process.env.PI_BROWSER_BRIDGE_PORT = "not-a-port";
	const fallback = new BrowserBridgeServer();
	assert.equal(fallback.port, sourceConfig.port);
} finally {
	if (oldHost === undefined) delete process.env.PI_BROWSER_BRIDGE_HOST;
	else process.env.PI_BROWSER_BRIDGE_HOST = oldHost;
	if (oldPort === undefined) delete process.env.PI_BROWSER_BRIDGE_PORT;
	else process.env.PI_BROWSER_BRIDGE_PORT = oldPort;
}

console.log("path and port contract ok");
