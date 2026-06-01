import type { GetPromptResult, Prompt } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition } from "./adapter.js";
import { MCP_DISCOVERY_TOOL_NAME } from "./toolVisibility.js";

type PromptDefinition = Prompt & {
	build: (args: Record<string, string | undefined>, toolDefs: readonly ToolDefinition[]) => GetPromptResult;
};

function toolNames(toolDefs: readonly ToolDefinition[], predicate: (name: string) => boolean): string {
	return toolDefs.map((tool) => tool.name).filter(predicate).sort().join(", ");
}

function textPrompt(description: string, text: string): GetPromptResult {
	return { description, messages: [{ role: "user", content: { type: "text", text } }] };
}

const PROMPTS: PromptDefinition[] = [
	{
		name: "browser-first-observe",
		title: "Browser first observe",
		description: "Plan the standard Pi browser flow: list tabs, choose an explicit tabId, observe, then act.",
		arguments: [
			{ name: "url", description: "Optional target URL or current page context.", required: false },
			{ name: "task", description: "User task to perform on the page.", required: false },
		],
		build: (args, toolDefs) => textPrompt("Browser first observe", [
			"Use Pi browser tools with explicit target state.",
			args.url ? `Target URL/context: ${args.url}` : undefined,
			args.task ? `Task: ${args.task}` : undefined,
			"Start with browser_tabs list or browser_tabs create/switch. Keep the returned tabId and pass it explicitly to tab-scoped calls.",
			"Use browser_observe mode=scan/content/html/text/tabs for perception before executing actions.",
			"Use browser_execute for page JavaScript and browser_wait for navigation/selector/network-idle waits.",
			`Available core tools: ${toolNames(toolDefs, (name) => !name.startsWith("browser_") || !["browser_crawl", "browser_fuzz", "browser_sqli", "browser_template", "browser_callback_oast", "browser_cookie_analyze", "browser_http_replay"].includes(name))}.`,
		].filter(Boolean).join("\n")),
	},
	{
		name: "browser-evidence-capture",
		title: "Browser evidence capture",
		description: "Template for collecting network, hook, screenshot, and artifact evidence without hiding handles.",
		arguments: [
			{ name: "goal", description: "Evidence goal or hypothesis.", required: false },
		],
		build: (args, toolDefs) => textPrompt("Browser evidence capture", [
			"Capture browser evidence with durable handles and explicit artifacts.",
			args.goal ? `Goal: ${args.goal}` : undefined,
			"Use browser_network for request/response recording and browser_hook for console/error/storage/websocket/DOM sink events.",
			"Use browser_evidence when one bundled evidence artifact is preferable.",
			"Use browser_screenshot only when visual state is required; prefer browser_observe for text/DOM evidence.",
			"Read large or sensitive outputs through browser-result:// resources or browser_artifact depending on client capability.",
			`Evidence-capable tools: ${toolNames(toolDefs, (name) => ["browser_network", "browser_hook", "browser_evidence", "browser_screenshot", "browser_artifact"].includes(name))}.`,
		].filter(Boolean).join("\n")),
	},
	{
		name: "browser-web-security-scope",
		title: "Browser web security scope",
		description: "Template for scoped Web security probing with explicit target, bounds, and evidence preservation.",
		arguments: [
			{ name: "target", description: "Scoped HTTP target URL, host, or captured request context.", required: false },
			{ name: "check", description: "Desired check type such as crawl, fuzz, sqli, template, cookie, replay, or oast.", required: false },
		],
		build: (args, toolDefs) => textPrompt("Browser web security scope", [
			"Use web-security tools only with explicit scope, bounded inputs, and persisted evidence.",
			args.target ? `Target/scope: ${args.target}` : undefined,
			args.check ? `Check: ${args.check}` : undefined,
			"HTTP target execution for these tools uses Node.js fetch directly; optionally inject browser-session cookies when the tool supports it.",
			"Prefer browser_crawl for discovery, browser_http_replay for focused variants, browser_sqli/browser_template for explicit checks, browser_callback_oast for correlated callback evidence, and browser_cookie_analyze for cookies/JWT/session values.",
			`Web-security tools: ${toolNames(toolDefs, (name) => ["browser_crawl", "browser_fuzz", "browser_sqli", "browser_template", "browser_callback_oast", "browser_cookie_analyze", "browser_http_replay"].includes(name))}.`,
			`If tools/list is compact, call ${MCP_DISCOVERY_TOOL_NAME} with group=web-security to inspect availability.`,
		].filter(Boolean).join("\n")),
	},
	{
		name: "browser-artifact-read",
		title: "Browser artifact/resource read",
		description: "Template for reading large browser-result:// resources with bounded mode, offsets, jsonPath, or search.",
		arguments: [
			{ name: "uri", description: "browser-result:// URI from a tool result resource_link.", required: false },
			{ name: "query", description: "Optional jsonPath/search/offset objective.", required: false },
		],
		build: (args) => textPrompt("Browser artifact/resource read", [
			"Read result artifacts in bounded chunks; do not paste large raw artifacts into the conversation.",
			args.uri ? `Resource URI: ${args.uri}` : "Use a browser-result:// URI from a resource_link or nextActions entry.",
			args.query ? `Read objective: ${args.query}` : undefined,
			"Use resources/read with mode=text|json|search|sample plus offset/limit/jsonPath/search where supported.",
			"Keep default redaction unless raw local evidence is explicitly required.",
		].filter(Boolean).join("\n")),
	},
];

export function listBrowserPrompts(): Prompt[] {
	return PROMPTS.map(({ build: _build, ...prompt }) => prompt);
}

export function getBrowserPrompt(name: string, args: Record<string, string | undefined>, toolDefs: readonly ToolDefinition[]): GetPromptResult | undefined {
	return PROMPTS.find((prompt) => prompt.name === name)?.build(args, toolDefs);
}
