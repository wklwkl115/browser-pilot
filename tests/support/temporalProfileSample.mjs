function isRecord(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function resultText(toolResult) {
	return String(toolResult?.content?.[0]?.text ?? "");
}

function tryParseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function firstRecord(...values) {
	for (const value of values) if (isRecord(value)) return value;
	return undefined;
}

function temporalFromEffect(effect) {
	const record = isRecord(effect) ? effect : undefined;
	return isRecord(record?.temporal) ? record.temporal : undefined;
}

function effectFromParsedResult(parsed) {
	const summary = firstRecord(parsed?.summary, parsed?.envelope?.summary);
	const data = firstRecord(parsed?.data, parsed?.envelope?.data);
	const execution = firstRecord(parsed?.execution, data?.execution, parsed?.envelope?.execution);
	return firstRecord(summary?.effect, parsed?.effect, data?.effect, execution?.effect);
}

function supervisorFromParsed(parsed) {
	const data = isRecord(parsed?.data) ? parsed.data : undefined;
	if (isRecord(data?.supervisor)) return data.supervisor;
	const wait = isRecord(data?.wait) ? data.wait : undefined;
	if (isRecord(wait?.supervisor)) return wait.supervisor;
	return undefined;
}

export function maybeTemporalProfileSample(toolResult, params, _metrics, call) {
	const parsed = tryParseJson(resultText(toolResult));
	const diagnostics = firstRecord(
		toolResult?.details?.diagnostics,
		parsed?.diagnostics,
		parsed?.envelope?.diagnostics,
		parsed?.details?.diagnostics,
	);
	const temporalProfile = firstRecord(diagnostics?.temporalProfile);
	const supervisor = supervisorFromParsed(parsed);
	const effect = effectFromParsedResult(parsed);
	const effectTemporal = temporalFromEffect(effect);
	const temporal = call.tool === "browser_execute"
		? firstRecord(effectTemporal, diagnostics?.temporal, supervisor?.temporal)
		: firstRecord(diagnostics?.temporal, supervisor?.temporal, effectTemporal);
	const verdict = firstRecord(temporal?.verdict);
	const frontier = firstRecord(temporal?.frontier);
	const operation = firstRecord(parsed?.operation, parsed?.data?.operation);
	const effectTargetRef = typeof effect?.targetRef === "string" ? effect.targetRef : undefined;
	const target = {
		...(typeof params.browserSessionId === "string" ? { browserSessionId: params.browserSessionId } : {}),
		...(Number.isInteger(Number(params.tabId)) ? { tabId: Number(params.tabId) } : {}),
		...(typeof params.targetRef === "string" ? { targetRef: params.targetRef } : effectTargetRef ? { targetRef: effectTargetRef } : {}),
	};
	const sample = {
		...(typeof operation?.operationId === "string" ? { operationId: operation.operationId } : {}),
		tool: call.tool,
		command: typeof temporalProfile?.command === "string" ? temporalProfile.command : typeof operation?.command === "string" ? operation.command : undefined,
		...(Object.keys(target).length ? { target } : {}),
		deadlineMs: Number.isFinite(Number(params.timeoutMs)) ? Number(params.timeoutMs) : typeof temporalProfile?.deadlineMs === "number" ? temporalProfile.deadlineMs : undefined,
		elapsedMs: call.elapsedMs,
		bridgeRoundTrips: typeof temporalProfile?.bridgeRoundTrips === "number" ? temporalProfile.bridgeRoundTrips : undefined,
		queueDepthAtEnqueue: typeof temporalProfile?.queueDepthAtEnqueue === "number" ? temporalProfile.queueDepthAtEnqueue : undefined,
		queueDepthAtStart: typeof temporalProfile?.queueDepthAtStart === "number" ? temporalProfile.queueDepthAtStart : undefined,
		queueDelayMs: typeof temporalProfile?.queueDelayMs === "number" ? temporalProfile.queueDelayMs : undefined,
		waitAttempts: typeof supervisor?.attempts === "number" ? supervisor.attempts : typeof temporalProfile?.waitAttempts === "number" ? temporalProfile.waitAttempts : undefined,
		workerRestarts: typeof supervisor?.workerRestarts === "number" ? supervisor.workerRestarts : typeof temporalProfile?.workerRestarts === "number" ? temporalProfile.workerRestarts : undefined,
		historyLost: typeof supervisor?.historyLost === "boolean" ? supervisor.historyLost : typeof temporalProfile?.historyLost === "boolean" ? temporalProfile.historyLost : undefined,
		rawSignals: Array.isArray(temporalProfile?.rawSignals) ? temporalProfile.rawSignals.filter((item) => typeof item === "string").slice(0, 8) : undefined,
		verdict: typeof verdict?.status === "string" ? verdict.status : undefined,
		reasons: Array.isArray(verdict?.reasons) ? verdict.reasons.filter((item) => typeof item === "string").slice(0, 3) : undefined,
		recovery: typeof frontier?.next === "string" ? frontier.next : undefined,
	};
	return Object.fromEntries(Object.entries(sample).filter(([, value]) => value !== undefined));
}
