/**
 * MCP tools/list_changed contract (Residual E / Phase 8).
 *
 * Phase 9 adds an explicit server-side dynamic-list path: compact/minimal MCP
 * visibility exposes browser_tool_discovery, and calling it with revealGroup can
 * change the visible tool set during the session.
 *
 * This contract locks the paired capability + behavior: if the server advertises
 * tools.listChanged:true, it must send notifications/tools/list_changed when the
 * discovery tool reveals a new group. The notification must not be accidental;
 * it is tied to a concrete list transition.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

// ── Source-level contracts ────────────────────────────────────────────────────

const indexSrc = read("mcp/index.ts");
assert(indexSrc.includes("tools: { listChanged: true }") || indexSrc.includes("tools:{listChanged:true}"),
	"mcp/index.ts must declare tools.listChanged:true only after Phase 9 dynamic visibility is implemented");
assert(indexSrc.includes("sendToolListChanged") && indexSrc.includes("notifyToolListChangedIfNeeded"),
	"mcp/index.ts must emit tools/list_changed through an explicit change detector");
assert(!indexSrc.includes("sendResourceListChanged"),
	"Phase 9 dynamic tool list must not imply resources/list_changed");
assert(indexSrc.includes("MCP_DISCOVERY_TOOL_NAME") && indexSrc.includes("revealedToolGroups"),
	"mcp/index.ts must tie dynamic list changes to the discovery tool reveal state");

// ── Behavioral contract: server advertises no listChanged capability ──────────

async function main() {
	let notifications = 0;
	const transport = new StdioClientTransport({
		command: "npx",
		args: ["tsx", path.join(root, "mcp", "index.ts")],
		env: { ...process.env, PI_BROWSER_TOOL_PROFILE: "security", PI_BROWSER_MCP_TOOL_VISIBILITY: "minimal" },
		cwd: root,
	});
	const client = new Client(
		{ name: "mcp-list-changed-contract", version: "1.0.0" },
		{ capabilities: {}, listChanged: { tools: { onChanged: () => { notifications += 1; } } } },
	);
	await client.connect(transport);
	try {
		const caps = client.getServerCapabilities();
		assert(caps?.tools?.listChanged, "server tools capability must advertise listChanged for Phase 9 dynamic visibility");
		assert(caps?.resources != null, "server must advertise resources capability");
		assert(!caps.resources.listChanged, "server resources capability must NOT advertise listChanged");

		const initial = await client.listTools();
		const initialNames = new Set(initial.tools.map((tool) => tool.name));
		assert(initialNames.has("browser_tool_discovery"), "minimal profile must expose browser_tool_discovery");
		assert(!initialNames.has("browser_sqli"), "minimal profile must hide web-security tools before discovery reveal");

		await client.callTool({ name: "browser_tool_discovery", arguments: { revealGroup: "web-security" } });
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert(notifications >= 1, "revealGroup must emit notifications/tools/list_changed");

		const revealed = await client.listTools();
		const revealedNames = new Set(revealed.tools.map((tool) => tool.name));
		assert(revealedNames.has("browser_sqli"), "web-security reveal must make browser_sqli visible");
		console.log("mcp list_changed ok");
	} finally {
		await client.close();
	}
}

main().catch((err) => {
	console.error("mcp list_changed FAILED:", err);
	process.exit(1);
});
