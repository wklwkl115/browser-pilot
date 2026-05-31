/**
 * MCP tool annotation table.
 *
 * Maps each browser_* tool to its MCP ToolAnnotations hints. These are
 * informational hints to MCP clients (hosts, UIs) — NOT security boundaries.
 * Security is enforced by the tool's own guards (scope, allowPrivateTargets, etc.).
 *
 * Hint semantics per MCP spec:
 *   readOnlyHint      – tool never modifies external state (safe to retry freely)
 *   destructiveHint   – tool may irreversibly change data/state (default true if not set)
 *   idempotentHint    – repeated identical calls have same net effect as one call
 *   openWorldHint     – tool may contact external systems / the open internet
 */

export type McpToolAnnotations = {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
};

/**
 * Annotation table for all registered browser tools.
 * Tools not listed here get no annotations (server returns no hints).
 */
export const TOOL_ANNOTATIONS: Record<string, McpToolAnnotations> = {
	// ── Core browser tools ──────────────────────────────────────────────────────

	// Reads tab list / metadata or switches focus. Close action modifies state
	// but is idempotent (closing a closed tab is a no-op at the session level).
	browser_tabs: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },

	// Low-level bridge command pass-through. May do anything — treat as open-world.
	browser_command: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },

	// Executes arbitrary JS in the page. Can read or write DOM/state.
	browser_execute: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },

	// Reads DOM snapshot. Pure observation; does not modify the page.
	browser_observe: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

	// Reads a single element from the page. Pure observation.
	browser_pick: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

	// Waits for page conditions. Time-based; not idempotent (state may change).
	browser_wait: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },

	// Reads buffered network traffic for the tab. Pure read.
	browser_network: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

	// Installs JS hooks in the page. Hooks can observe or mutate page state.
	browser_hook: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },

	// Captures DOM, screenshots, and timing evidence. Pure read of current state.
	browser_evidence: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

	// Switches the CDP frame context. State-switching, not destructive.
	browser_frame: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },

	// Captures a screenshot. Pure read of visible state.
	browser_screenshot: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

	// Reads or searches a saved artifact file. Pure read.
	browser_artifact: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

	// Downloads a file from the browser to the local filesystem. Writes locally.
	browser_download: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },

	// Uploads a local file into the browser. Writes to the page.
	browser_upload: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },

	// ── Web-security tools ──────────────────────────────────────────────────────

	// Crawls a site — makes many HTTP requests and follows links to external pages.
	browser_crawl: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },

	// Sends crafted HTTP probes to a target. Open-world by nature.
	browser_fuzz: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },

	// Sends SQL injection probes. Open-world; not idempotent (probe state varies).
	browser_sqli: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },

	// Runs built-in or inline templates against a target. Open-world.
	browser_template: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },

	// Sets up an OAST callback listener. Involves external callback infrastructure.
	browser_callback_oast: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },

	// Decodes/analyzes cookies; optionally makes replay requests. May be open-world.
	browser_cookie_analyze: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },

	// Replays a captured HTTP request with optional mutations. Open-world.
	browser_http_replay: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
};
