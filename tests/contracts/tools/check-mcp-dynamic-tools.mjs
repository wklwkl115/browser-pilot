import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function main() {
	let notifications = 0;
	const transport = new StdioClientTransport({
		command: "npx",
		args: ["tsx", path.join(root, "mcp", "index.ts")],
		env: { ...process.env, PI_BROWSER_TOOL_PROFILE: "security", PI_BROWSER_MCP_TOOL_VISIBILITY: "compact" },
		cwd: root,
	});
	const client = new Client(
		{ name: "mcp-dynamic-tools-contract", version: "1.0.0" },
		{ capabilities: {}, listChanged: { tools: { debounceMs: 0, onChanged: () => { notifications += 1; } } } },
	);
	await client.connect(transport);
	try {
		assert(client.getServerCapabilities()?.tools?.listChanged, "dynamic tools contract requires tools.listChanged");
		const initial = await client.listTools();
		const initialNames = new Set(initial.tools.map((tool) => tool.name));
		assert(initialNames.has("browser_tool_discovery"), "compact profile must include discovery helper");
		assert(initialNames.has("browser_tabs"), "compact profile must keep core state tools");
		assert(!initialNames.has("browser_sqli"), "compact profile must hide web-security tools until reveal");

		const discovery = await client.callTool({ name: "browser_tool_discovery", arguments: { group: "web-security", revealGroup: "web-security", includeDescriptions: true } });
		const discoveryText = discovery.content[0]?.type === "text" ? discovery.content[0].text : "";
		assert(discoveryText.includes("browser_sqli"), "discovery result must list hidden web-security tools");
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert(notifications >= 1, "revealGroup must send tools/list_changed");

		const revealed = await client.listTools();
		const revealedNames = new Set(revealed.tools.map((tool) => tool.name));
		assert(revealedNames.has("browser_sqli"), "revealed list must include browser_sqli");
		assert(revealedNames.has("browser_http_replay"), "revealed list must include browser_http_replay");
		assert(!revealedNames.has("browser_artifact"), "browser_artifact remains retired for modern clients after reveal");
		console.log("mcp dynamic tools ok");
	} finally {
		await client.close();
	}
}

main().catch((err) => {
	console.error("mcp dynamic tools FAILED:", err);
	process.exit(1);
});
