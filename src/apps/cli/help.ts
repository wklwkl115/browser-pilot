export type CliCommandSummary = {
	name: string;
	subcommand: string;
	description?: string;
};

export const COMMAND_SUMMARIES: CliCommandSummary[] = [
	{ subcommand: "artifact", name: "browser_artifact", description: "Read, sample, search, or pick local artifact files produced by browser tools without loading the whole file, including bounded multi-artifact search." },
	{ subcommand: "callback-oast", name: "browser_callback_oast", description: "Run local HTTP/HTTPS/DNS callback listeners with correlation IDs, trigger helpers, persisted events, and external callback metadata." },
	{ subcommand: "command", name: "browser_command", description: "Send a native bridge command object through the Browser Pilot bridge with stable validation and result envelopes." },
	{ subcommand: "cookie-analyze", name: "browser_cookie_analyze", description: "Analyze Cookie, Set-Cookie, JWT, JWE, PASETO, and signed or encrypted session values with decoding, signature/decryption checks, claim mutation generation, claim replay validation, browser-session cookie binding, and Rails AES-GCM/AES-CBC/direct-key evidence." },
	{ subcommand: "crawl", name: "browser_crawl", description: "Collect scoped Web metadata through bounded fingerprint probing or recursive crawl for links, forms, known files, JS endpoints, OpenAPI/GraphQL, source maps, service workers, and response evidence." },
	{ subcommand: "download", name: "browser_download", description: "Trigger or wait for a browser download and return the completed local file path from Chrome downloads." },
	{ subcommand: "evidence", name: "browser_evidence", description: "Aggregate native browser evidence from hook, network recorder, and performance entries." },
	{ subcommand: "execute", name: "browser_execute", description: "Execute JavaScript in a connected real browser tab." },
	{ subcommand: "frame", name: "browser_frame", description: "Native frame commands: list frames, evaluate in a frame, add/remove new-document scripts." },
	{ subcommand: "fuzz", name: "browser_fuzz", description: "Run bounded path, vhost, or parameter fuzzing against explicit scoped HTTP targets with baseline filtering, clustering, response deltas, and evidence artifacts." },
	{ subcommand: "hook", name: "browser_hook", description: "Native browser event hook commands: listTargets, installTargets, install, collect, status, clear, pause, resume, uninstall, evaluate, event listener, performance entries." },
	{ subcommand: "http-replay", name: "browser_http_replay", description: "Replay raw or structured HTTP requests with method/header/body mutation, HAR dependency graph evidence, artifact output, and optional browser-session cookie injection." },
	{ subcommand: "memory", name: "browser_memory", description: "Record, recall, read, or validate local browser memory entries with local-only persistence, near-duplicate dedup, optional provenance evidence, and bounded reads." },
	{ subcommand: "network", name: "browser_network", description: "Native Network recorder commands: start, stop, status, clear, list, get, body, exportHar, wait." },
	{ subcommand: "observe", name: "browser_observe", description: "Observe the current page as the canonical ABML page model; omit mode for ordinary use, with explicit modes reserved for legacy/debug projections." },
	{ subcommand: "screenshot", name: "browser_screenshot", description: "Native screenshot capture. Saves the image to disk by default and returns the file path." },
	{ subcommand: "sqli", name: "browser_sqli", description: "Probe SQL injection or run bounded sqlmap automation from explicit scoped request templates with boolean/error/time/union evidence, mature-engine findings, and artifacts." },
	{ subcommand: "tabs", name: "browser_tabs", description: "List, switch, create, close, or snapshot browser tabs; advanced actions manage scoped browser sessions and tab leases through the Browser Pilot bridge." },
	{ subcommand: "template", name: "browser_template", description: "Run bounded built-in/custom HTTP template checks or mature nuclei template automation against scoped targets or request templates with structured matches and artifacts." },
	{ subcommand: "upload", name: "browser_upload", description: "Upload local file(s) through a page file chooser using CDP DOM.setFileInputFiles." },
	{ subcommand: "wait", name: "browser_wait", description: "Native wait/navigation commands: navigate, navigateAndWait, loadState, networkIdle, selector, any, all, cancel, diagnose. Composite any/all require non-empty waits or conditions." },
];

/** Left-align in a column; if the head already fills the column, keep a 2-space gap so the
 *  description never glues onto a long flag/subcommand. */
export function pad(head: string, width: number): string {
	return head.length < width ? head.padEnd(width) : `${head}  `;
}

export function helpText(): string {
	const lines = [
		"browser-pilot — drive a live browser via the bridge daemon",
		"",
		"Usage:",
		"  browser-pilot <command> [--flags]",
		"  browser-pilot daemon <start|stop|status>",
		"  browser-pilot connect --wait --json",
		"  browser-pilot status --json",
		"  browser-pilot commands --json",
		"  browser-pilot schema <command> --json",
		"  browser-pilot validate <command> --params @params.json --json",
		"  browser-pilot doctor --json",
		"  browser-pilot selftest --confirm --json",
		"",
		"Commands:",
	];
	for (const c of COMMAND_SUMMARIES) lines.push(`  ${pad(c.subcommand, 22)}${c.description ?? ""}`.trimEnd());
	lines.push("", "Run 'browser-pilot <command> --help' for flags. Global: --json | --text | --help");
	return `${lines.join("\n")}\n`;
}

export function printHelp(): void {
	process.stdout.write(helpText());
}

export function isTopLevelHelpArgv(argv: readonly string[]): boolean {
	const sub = argv[0];
	return !sub || sub === "--help" || sub === "-h";
}
