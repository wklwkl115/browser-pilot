/**
 * MCP tools/list_changed contract (Residual E / Phase 8).
 *
 * Phase 8 retires browser_artifact DETERMINISTICALLY per client: visibility is
 * decided at each tools/list from getClientCapabilities(). A given client always
 * sees the same tool set within a session — the list never changes mid-session —
 * so no tools/list_changed notification is owed. Declaring listChanged:true would
 * be a FALSE capability (plan §4: "不能只为标准化虚报 capability").
 *
 * This contract locks that decision: we must NOT declare listChanged and must NOT
 * emit the notification. A future dynamic-list feature (Phase 9 stretch) must add
 * the capability AND the notification together — deliberately, not by accident.
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
assert(!indexSrc.includes("listChanged: true") && !indexSrc.includes("listChanged:true"),
	"mcp/index.ts must NOT declare listChanged:true (retirement is deterministic per client — declaring it would be a false capability)");
assert(!indexSrc.includes("sendToolListChanged") && !indexSrc.includes("sendResourceListChanged"),
	"mcp/index.ts must NOT emit list_changed notifications (the tool set is stable per session)");
// The capability object must still declare tools and resources (without listChanged).
assert(indexSrc.includes("tools: {}") && indexSrc.includes("resources: {}"),
	"mcp/index.ts must declare tools:{} and resources:{} (no listChanged sub-flag)");

// ── Behavioral contract: server advertises no listChanged capability ──────────

async function main() {
	const transport = new StdioClientTransport({
		command: "npx",
		args: ["tsx", path.join(root, "mcp", "index.ts")],
		env: { ...process.env, PI_BROWSER_TOOL_PROFILE: "security" },
		cwd: root,
	});
	const client = new Client({ name: "mcp-list-changed-contract", version: "1.0.0" }, { capabilities: {} });
	await client.connect(transport);
	try {
		const caps = client.getServerCapabilities();
		assert(caps?.tools != null, "server must advertise tools capability");
		assert(!caps.tools.listChanged, "server tools capability must NOT advertise listChanged");
		assert(caps?.resources != null, "server must advertise resources capability");
		assert(!caps.resources.listChanged, "server resources capability must NOT advertise listChanged");
		console.log("mcp list_changed ok");
	} finally {
		await client.close();
	}
}

main().catch((err) => {
	console.error("mcp list_changed FAILED:", err);
	process.exit(1);
});
