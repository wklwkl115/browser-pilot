import { summaryTable, textPreview, type Summary } from "../common";
import { isRecord } from "../common";

export function summarizeWsSessionData(action: string, value: unknown): Summary {
	const root = isRecord(value) ? value : {};
	const session = isRecord(root.session) ? root.session : {};
	const entry = isRecord(root.entry) ? root.entry : {};
	const sent = isRecord(root.sent) ? root.sent : {};
	const events = Array.isArray(root.events) ? root.events : [];
	const steps = Array.isArray(root.steps) ? root.steps : [];
	const failure = isRecord(root.failure) ? root.failure : {};
	return {
		action,
		sessionId: session.sessionId,
		url: session.url,
		state: session.state,
		active: session.active,
		transcriptCount: session.transcriptCount ?? root.total,
		maxTranscript: session.maxTranscript,
		openedAt: session.openedAt,
		closedAt: session.closedAt,
		lastError: session.lastError,
		sent: sent.seq ? { seq: sent.seq, bytes: sent.bytes, preview: sent.preview } : undefined,
		replayFailure: failure.stepIndex !== undefined ? {
			stepIndex: failure.stepIndex,
			lastSeq: failure.lastSeq,
			errorCode: isRecord(failure.error) ? failure.error.code : undefined,
			errorMessage: isRecord(failure.error) ? failure.error.message : undefined,
		} : undefined,
		replaySteps: summaryTable(steps, [
			{ key: "index", value: (item) => isRecord(item) ? item.index : undefined },
			{ key: "sentSeq", value: (item) => isRecord(item) && isRecord(item.sent) ? item.sent.seq : undefined },
			{ key: "sentPreview", value: (item) => isRecord(item) && isRecord(item.sent) && typeof item.sent.preview === "string" ? textPreview(item.sent.preview, 120) : undefined },
			{ key: "matchSeq", value: (item) => isRecord(item) && isRecord(item.matched) && isRecord(item.matched.entry) ? item.matched.entry.seq : undefined },
			{ key: "matchPreview", value: (item) => isRecord(item) && isRecord(item.matched) && isRecord(item.matched.entry) && typeof item.matched.entry.preview === "string" ? textPreview(item.matched.entry.preview, 120) : undefined },
		], 12),
		waitMatch: entry.seq ? {
			seq: entry.seq,
			event: entry.event,
			preview: typeof entry.preview === "string" ? textPreview(entry.preview, 160) : undefined,
			json: entry.json,
		} : undefined,
		events: summaryTable(events, [
			{ key: "seq", value: (item) => isRecord(item) ? item.seq : undefined },
			{ key: "event", value: (item) => isRecord(item) ? item.event : undefined },
			{ key: "direction", value: (item) => isRecord(item) ? item.direction : undefined },
			{ key: "bytes", value: (item) => isRecord(item) ? item.bytes : undefined },
			{ key: "preview", value: (item) => isRecord(item) && typeof item.preview === "string" ? textPreview(item.preview, 120) : undefined },
		], 12),
		nextActions: [
			"keep websocket inputs explicit: sessionId/url/message/matcher only",
			"save or read transcript artifacts instead of inlining long websocket exchanges",
		],
	};
}
