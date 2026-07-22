import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { agentTokenPath, resolvePairingToken } from "../../src/apps/mcp/auth.ts";
import { callMcpTool, mcpProjectRoot, mcpResources, mcpTools, readMcpResource } from "../../src/apps/mcp/server.ts";
import { ENV_AUTH_STATE_DIR, ENV_PAIRING_TOKEN } from "../../src/apps/daemon/authTypes.ts";

function firstText(result: Awaited<ReturnType<typeof callMcpTool>>): string {
	return result.content.find((item) => item.type === "text")?.text ?? "";
}

function resourceText(resource: Awaited<ReturnType<typeof readMcpResource>>): string {
	const content = resource.contents[0];
	return content && "text" in content ? content.text : "";
}

test("MCP publishes the command catalog as tools", () => {
	const tools = mcpTools();
	assert.deepEqual(tools.map((tool) => tool.name), [
		"browser_tabs", "browser_command", "browser_execute", "browser_observe",
		"browser_screenshot", "browser_artifact",
		"browser_pair",
	]);
	assert.ok(tools.every((tool) => tool.inputSchema.type === "object"));
	const tabs = tools.find((tool) => tool.name === "browser_tabs")!;
	const tabProperties = tabs.inputSchema.properties as Record<string, Record<string, unknown>>;
	assert.ok((tabProperties.action.enum as string[]).includes("selectSession"));
	assert.ok("browserSessionId" in tabProperties);
	assert.match(tabs.description ?? "", /Start automation with browser_tabs list/);
	const native = tools.find((tool) => tool.name === "browser_command")!;
	const nativeProperties = native.inputSchema.properties as Record<string, Record<string, unknown>>;
	const commandProperties = nativeProperties.command.properties as Record<string, Record<string, unknown>>;
		assert.ok((commandProperties.cmd.enum as string[]).includes("network.list"));
		assert.ok((commandProperties.cmd.enum as string[]).includes("transfer.download"));
		assert.ok((commandProperties.cmd.enum as string[]).includes("transfer.upload"));
		assert.equal((commandProperties.cmd.enum as string[]).includes("tabs"), false);
		assert.equal((commandProperties.cmd.enum as string[]).includes("batch"), false);
});

test("MCP pairing tokens are client/project-scoped and pinned for the process", async () => {
	const previousStateDir = process.env[ENV_AUTH_STATE_DIR];
	const previousToken = process.env[ENV_PAIRING_TOKEN];
	const root = await mkdtemp(path.join(os.tmpdir(), "browser-pilot-mcp-auth-"));
	process.env[ENV_AUTH_STATE_DIR] = path.join(root, "auth");
	delete process.env[ENV_PAIRING_TOKEN];
	try {
		const projectA = path.join(root, "project-a");
		const projectB = path.join(root, "project-b");
		const tokenA = agentTokenPath(projectA, "client-a");
		const tokenB = agentTokenPath(projectB, "client-a");
		assert.notEqual(tokenA, tokenB);
		assert.notEqual(tokenA, agentTokenPath(projectA, "client-b"));
		await mkdir(path.dirname(tokenA), { recursive: true });
		await writeFile(tokenA, JSON.stringify({ token: "token-a" }));
		await writeFile(tokenB, JSON.stringify({ token: "token-b" }));
		assert.equal(resolvePairingToken(projectA, "client-a"), "token-a");
		assert.equal(resolvePairingToken(projectB, "client-a"), "token-b");
		await writeFile(tokenA, JSON.stringify({ token: "overwritten" }));
		assert.equal(resolvePairingToken(projectA, "client-a"), "token-a");
	} finally {
		if (previousStateDir === undefined) delete process.env[ENV_AUTH_STATE_DIR];
		else process.env[ENV_AUTH_STATE_DIR] = previousStateDir;
		if (previousToken === undefined) delete process.env[ENV_PAIRING_TOKEN];
		else process.env[ENV_PAIRING_TOKEN] = previousToken;
		await rm(root, { recursive: true, force: true });
	}
});

test("MCP pairing rejects invalid actions without starting the daemon", async () => {
	const result = await callMcpTool("browser_pair", { action: "invalid" });
	assert.equal(result.isError, true);
	assert.match(firstText(result), /action must be start or wait/);
});

test("MCP uses the configured project root", () => {
	const previous = process.env.BROWSER_PILOT_PROJECT_ROOT;
	process.env.BROWSER_PILOT_PROJECT_ROOT = path.join("fixture", "project");
	try {
		assert.equal(mcpProjectRoot(), path.resolve("fixture", "project"));
	} finally {
		if (previous === undefined) delete process.env.BROWSER_PILOT_PROJECT_ROOT;
		else process.env.BROWSER_PILOT_PROJECT_ROOT = previous;
	}
});

test("MCP returns an ordinary tool error for unknown tools", async () => {
	const result = await callMcpTool("browser_missing", {});
	assert.equal(result.isError, true);
	assert.match(firstText(result), /Unknown tool/);
});

test("MCP resources expose the native catalog and project-scoped artifacts", async () => {
	assert.equal(mcpResources()[0]?.uri, "browser-pilot://native-commands");
	const native = await readMcpResource("browser-pilot://native-commands");
	assert.match(resourceText(native), /"network\.list"/);
	assert.equal(Object.hasOwn((JSON.parse(resourceText(native)) as { commands: object }).commands, "tabs"), false);

	const root = await mkdtemp(path.join(os.tmpdir(), "browser-pilot-mcp-"));
	try {
		const artifacts = path.join(root, ".browser-pilot", "artifacts");
		await mkdir(artifacts, { recursive: true });
		await writeFile(path.join(artifacts, "sample.json"), "{\"ok\":true}");
		const artifact = await readMcpResource("browser-pilot://artifact/sample.json", root);
		assert.equal(resourceText(artifact), "{\"ok\":true}");
		await assert.rejects(() => readMcpResource("browser-pilot://artifact/..%2Foutside.txt", root), /invalid resource URI/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("stdio MCP initialization and tools/list work end to end", async () => {
	const child = spawn(process.execPath, ["--import", "tsx", "src/apps/mcp/bin.ts"], {
		cwd: process.cwd(),
		stdio: ["pipe", "pipe", "pipe"],
	});
		const responses = new Map<number, (message: Record<string, unknown>) => void>();
		const progress: Record<string, unknown>[] = [];
		let rootsRequested = false;
		const lines = createInterface({ input: child.stdout });
		lines.on("line", (line) => {
			const message = JSON.parse(line) as { id?: unknown; method?: unknown; params?: unknown } & Record<string, unknown>;
			if (message.method === "roots/list") {
				rootsRequested = true;
				child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { roots: [{ uri: pathToFileURL(process.cwd()).href, name: "workspace" }] } })}\n`);
				return;
			}
			if (message.method === "notifications/progress") progress.push(message.params as Record<string, unknown>);
			if (typeof message.id === "number") responses.get(message.id)?.(message);
		});
		const request = (id: number, method: string, params: Record<string, unknown> = {}, jsonrpc = "2.0") => new Promise<Record<string, unknown>>((resolve) => {
			responses.set(id, resolve);
			child.stdin.write(`${JSON.stringify({ jsonrpc, id, method, params })}\n`);
		});
		try {
			const invalidVersion = await request(-1, "ping", {}, "1.0");
			assert.equal((invalidVersion.error as Record<string, unknown>).code, -32600);
			const invalidInitialize = await request(-2, "initialize");
			assert.equal((invalidInitialize.error as Record<string, unknown>).code, -32602);
			const beforeInitialize = await request(0, "tools/list");
			assert.equal((beforeInitialize.error as Record<string, unknown>).code, -32002);
				const initialized = await request(1, "initialize", { protocolVersion: "2025-11-25", capabilities: { roots: { listChanged: true } }, clientInfo: { name: "test", version: "1" } });
			assert.equal((initialized.result as Record<string, unknown>).protocolVersion, "2025-11-25");
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
			const listed = await request(2, "tools/list");
			assert.equal(((listed.result as { tools: unknown[] }).tools).length, mcpTools().length);
			const resources = await request(3, "resources/list");
			assert.equal(((resources.result as { resources: unknown[] }).resources).length, 1);
			const native = await request(4, "resources/read", { uri: "browser-pilot://native-commands" });
			assert.match(JSON.stringify(native.result), /network\.list/);
			const missing = await request(5, "tools/call", { name: "browser_missing", arguments: {}, _meta: { progressToken: "progress-1" } });
			assert.equal((missing.result as { isError?: boolean }).isError, true);
			assert.equal(progress[0]?.progressToken, "progress-1");
			assert.equal(rootsRequested, true);
	} finally {
		child.stdin.end();
		lines.close();
		await new Promise<void>((resolve) => child.once("close", () => resolve()));
	}
});
