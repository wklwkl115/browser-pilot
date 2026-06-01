import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function main() {
	const transport = new StdioClientTransport({
		command: "npx",
		args: ["tsx", path.join(root, "mcp", "index.ts")],
		env: { ...process.env, PI_BROWSER_TOOL_PROFILE: "security" },
		cwd: root,
	});
	const client = new Client({ name: "mcp-prompts-contract", version: "1.0.0" }, { capabilities: {} });
	await client.connect(transport);
	try {
		const caps = client.getServerCapabilities();
		assert(caps?.prompts != null, "server must advertise prompts capability");
		assert(!caps.prompts.listChanged, "prompt catalog is static and must not advertise prompts.listChanged");

		const { prompts } = await client.listPrompts();
		const names = new Set(prompts.map((prompt) => prompt.name));
		for (const name of ["browser-first-observe", "browser-evidence-capture", "browser-web-security-scope", "browser-artifact-read"]) {
			assert(names.has(name), `missing prompt: ${name}`);
		}
		for (const prompt of prompts) {
			assert(prompt.description && prompt.description.length > 20, `${prompt.name} must have a useful description`);
		}

		const security = await client.getPrompt({ name: "browser-web-security-scope", arguments: { target: "https://example.test", check: "sqli" } });
		const text = security.messages.map((message) => message.content.type === "text" ? message.content.text : "").join("\n");
		assert(text.includes("https://example.test"), "prompt arguments must be interpolated");
		assert(text.includes("browser_sqli"), "web-security prompt must mention concrete tools");
		assert(!text.includes("automatically call"), "prompts must not encode hidden workflow execution");

		let threw = false;
		try {
			await client.getPrompt({ name: "missing-prompt" });
		} catch {
			threw = true;
		}
		assert(threw, "unknown prompt must throw");
		console.log("mcp prompts ok");
	} finally {
		await client.close();
	}
}

main().catch((err) => {
	console.error("mcp prompts FAILED:", err);
	process.exit(1);
});
