/**
 * MCP end-to-end stdio contract.
 *
 * Spawns the real MCP server (mcp/index.ts) over stdio and drives it with the
 * official MCP SDK Client. This is the only test that exercises the full
 * protocol path — initialize, tools/list, resources/*, and the validation
 * rejection path — rather than matching source strings.
 *
 * Does NOT exercise a successful tools/call (that needs a live browser bridge);
 * it verifies the pre-execute validation path, which is browser-independent.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function main() {
	// Spawn the server in the security profile so all 21 tools register.
	const transport = new StdioClientTransport({
		command: "npx",
		args: ["tsx", path.join(root, "mcp", "index.ts")],
		env: { ...process.env, PI_BROWSER_TOOL_PROFILE: "security" },
		cwd: root,
	});

	const client = new Client({ name: "mcp-e2e-acceptance", version: "1.0.0" }, { capabilities: {} });
	await client.connect(transport);

	try {
		// ── Server capabilities ────────────────────────────────────────────────
		const serverCaps = client.getServerCapabilities();
		assert(serverCaps?.tools != null, "server must advertise tools capability");
		assert(serverCaps?.resources != null, "server must advertise resources capability");

		// ── tools/list ──────────────────────────────────────────────────────────
		const { tools } = await client.listTools();
		const names = new Set(tools.map((t) => t.name));

		// Modern client (declared capabilities) → browser_artifact retired (Phase 8).
		assert(!names.has("browser_artifact"), "browser_artifact must be retired for modern (capability-declaring) clients");

		// Security profile = 21 tools - 1 retired = 20 visible to a modern client.
		assert.equal(tools.length, 20, `modern security-profile client must see 20 tools (21 - browser_artifact), got ${tools.length}`);

		// All 7 security tools present.
		for (const n of ["browser_crawl", "browser_fuzz", "browser_sqli", "browser_template", "browser_callback_oast", "browser_cookie_analyze", "browser_http_replay"]) {
			assert(names.has(n), `security tool must be present: ${n}`);
		}

		// Annotations present and well-formed (Phase 1).
		const sqli = tools.find((t) => t.name === "browser_sqli");
		assert(sqli?.annotations != null, "browser_sqli must carry annotations");
		assert.equal(sqli.annotations.openWorldHint, true, "browser_sqli must declare openWorldHint:true");
		const observe = tools.find((t) => t.name === "browser_observe");
		assert.equal(observe?.annotations?.readOnlyHint, true, "browser_observe must declare readOnlyHint:true");

		// outputSchema present on distiller-backed tools (Phase 3).
		const evidence = tools.find((t) => t.name === "browser_evidence");
		assert(evidence?.outputSchema != null, "browser_evidence must declare outputSchema");
		assert.equal(evidence.outputSchema.type, "object", "outputSchema must be a JSON Schema object");
		const network = tools.find((t) => t.name === "browser_network");
		assert(network?.outputSchema != null, "browser_network must declare outputSchema");
		// Non-distiller tool must NOT declare outputSchema.
		assert(sqli.outputSchema == null, "browser_sqli (no DistillerDefinition) must not declare outputSchema");

		// inputSchema is the TypeBox JSON Schema (additionalProperties:false on strict tools).
		assert(sqli.inputSchema?.type === "object", "browser_sqli inputSchema must be a JSON Schema object");

		// ── resources/templates/list ─────────────────────────────────────────────
		const { resourceTemplates } = await client.listResourceTemplates();
		assert(resourceTemplates.some((t) => t.uriTemplate.startsWith("browser-result://")), "must expose browser-result:// resource template");

		// ── resources/list (empty before any tool runs) ──────────────────────────
		const { resources } = await client.listResources();
		assert(Array.isArray(resources), "resources/list must return an array");

		// ── validation rejection path (no browser needed) ────────────────────────
		// Unknown top-level field must be rejected by the MCP TypeBox guard (Phase 0).
		const badArgs = await client.callTool({
			name: "browser_sqli",
			arguments: { url: "https://example.com", bogusUnknownField: 123 },
		});
		assert.equal(badArgs.isError, true, "unknown top-level field must produce isError:true");
		const badText = (badArgs.content[0]?.text || "").toLowerCase();
		assert(badText.includes("invalid") || badText.includes("additional"), `validation error must mention invalid/additional properties, got: ${badText.slice(0, 120)}`);

		// Unknown tool must produce an error result.
		const unknown = await client.callTool({ name: "browser_does_not_exist", arguments: {} });
		assert.equal(unknown.isError, true, "unknown tool must produce isError:true");

		// ── resources/read of an unknown URI must error ───────────────────────────
		let readThrew = false;
		try {
			await client.readResource({ uri: "browser-result://00000000-0000-0000-0000-000000000000" });
		} catch {
			readThrew = true;
		}
		assert(readThrew, "reading an unknown resource URI must throw/error");

		console.log("mcp e2e ok");
	} finally {
		await client.close();
	}
}

main().catch((err) => {
	console.error("mcp e2e FAILED:", err);
	process.exit(1);
});
