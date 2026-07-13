/**
 * Shared agent-envelope leak detection / fail-closed sanitization.
 * Used by browser_view, browser_act, and browser_read paths.
 */

const LEAK_PATTERN = /pageEpoch|browserSessionId|backendNodeId|"tabId"\s*:|[A-Za-z]:\\|\/\.browser-pilot\//;

export function agentEnvelopeLeaksMechanicalIds(value: unknown): boolean {
	return LEAK_PATTERN.test(JSON.stringify(value));
}

/** Strip notice messages that embed mechanical identity tokens. */
export function sanitizeAgentNotices<T extends { message: string }>(notices: T[]): T[] {
	return notices.map((notice) => ({
		...notice,
		message: notice.message
			.replace(/pageEpoch[=:]\s*\S+/gi, "pageEpoch=[redacted]")
			.replace(/browserSessionId[=:]\s*\S+/gi, "browserSessionId=[redacted]")
			.replace(/tabId[=:]\s*\d+/gi, "tabId=[redacted]")
			.replace(/backendNodeId[=:]\s*\d+/gi, "backendNodeId=[redacted]")
			.replace(/[A-Za-z]:\\[^\s"]+/g, "[path-redacted]"),
	}));
}

/**
 * Fail-closed: if a projected AgentView still contains mechanical leaks,
 * drop candidates/notices/reads that may carry them and keep only safe summary fields.
 */
export function failClosedAgentView<T extends Record<string, unknown>>(view: T): T {
	if (!agentEnvelopeLeaksMechanicalIds(view)) {
		if (Array.isArray(view.notices)) {
			return { ...view, notices: sanitizeAgentNotices(view.notices as Array<{ message: string }>) };
		}
		return view;
	}
	return {
		...view,
		notices: [],
		candidates: [],
		reads: undefined,
		summary: typeof view.summary === "string"
			? `${view.summary} (mechanical fields redacted)`
			: "mechanical fields redacted",
		decision: { kind: "inspect", readRefs: [] },
		limits: view.limits,
	};
}
