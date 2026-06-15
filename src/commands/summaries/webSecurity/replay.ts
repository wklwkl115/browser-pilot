import { asArray, bodyPreview, isRecord, summaryTable, type Summary } from "./shared.js";

export function summarizeHttpReplayData(value: unknown): Summary {
	const request = isRecord(value) && isRecord(value.request) ? value.request : {};
	const response = isRecord(value) && isRecord(value.response) ? value.response : {};
	const steps = isRecord(value) ? asArray(value.steps).filter(isRecord) : [];
	const dependencyGraph = isRecord(value) && isRecord(value.dependencyGraph) ? value.dependencyGraph : undefined;
	const multipartMatrix = isRecord(value) && isRecord(value.multipartMatrix) ? value.multipartMatrix : undefined;
	return {
		ok: isRecord(value) ? value.ok : undefined,
		mode: isRecord(value) ? value.mode : undefined,
		stepCount: isRecord(value) ? value.stepCount : undefined,
		failureCount: isRecord(value) ? value.failureCount : undefined,
		variableScope: isRecord(value) ? value.variableScope : undefined,
		variableNames: isRecord(value) ? value.variableNames : undefined,
		multipartMatrix: multipartMatrix ? {
			caseCount: multipartMatrix.caseCount,
			truncatedCases: multipartMatrix.truncatedCases,
			fieldNames: multipartMatrix.fieldNames,
			fileValueCount: multipartMatrix.fileValueCount,
		} : undefined,
		request: {
			method: request.method,
			url: request.url,
			headerCount: Array.isArray(request.headerNames) ? request.headerNames.length : undefined,
			omittedHeaderNames: request.omittedHeaderNames,
			bodyBytes: request.bodyBytes,
			cookiesBound: request.cookiesBound,
			csrfReflected: isRecord(request.csrfReflected) ? { cookie: request.csrfReflected.cookie, header: request.csrfReflected.header } : undefined,
			multipart: isRecord(request.multipart) ? { partCount: request.multipart.partCount, fileCount: request.multipart.fileCount, fieldCount: request.multipart.fieldCount, nestedMultipartPartCount: request.multipart.nestedMultipartPartCount } : undefined,
		},
		response: {
			status: response.status,
			statusText: response.statusText,
			url: response.url,
			headerCount: Array.isArray(response.headerNames) ? response.headerNames.length : undefined,
			bodyBytes: isRecord(response.body) ? response.body.bytes : undefined,
			bodySha256: isRecord(response.body) ? response.body.sha256 : undefined,
			bodyTruncated: isRecord(response.body) ? response.body.truncated : undefined,
			preview: bodyPreview(response.body),
			elapsedMs: response.elapsedMs,
		},
		delta: isRecord(value) ? value.delta : undefined,
		dependencyGraph: dependencyGraph ? {
			nodeCount: dependencyGraph.nodeCount,
			edgeCount: dependencyGraph.edgeCount,
			edgeTypes: dependencyGraph.edgeTypes,
		} : undefined,
		clusters: summaryTable(isRecord(value) ? asArray(value.clusters).filter(isRecord) : [], [
			{ key: "status", value: (item) => item.status },
			{ key: "title", value: (item) => item.title },
			{ key: "bodyBytes", value: (item) => item.bodyBytes },
			{ key: "count", value: (item) => item.count },
			{ key: "ok", value: (item) => item.okCount },
			{ key: "samples", value: (item) => item.sampleSteps },
		], 20),
		steps: summaryTable(steps, [
			{ key: "index", value: (step) => step.index },
			{ key: "source", value: (step) => step.source },
			{ key: "method", value: (step) => isRecord(step.request) ? step.request.method : undefined },
			{ key: "url", value: (step) => isRecord(step.request) ? step.request.url : undefined },
			{ key: "status", value: (step) => isRecord(step.response) ? step.response.status : undefined },
			{ key: "bodyBytes", value: (step) => isRecord(step.response) && isRecord(step.response.body) ? step.response.body.bytes : undefined },
			{ key: "multipartCase", value: (step) => isRecord(step.multipartMatrixCase) ? `${step.multipartMatrixCase.fieldName}:${step.multipartMatrixCase.kind}:${step.multipartMatrixCase.fileCount}` : undefined },
			{ key: "multipartFiles", value: (step) => isRecord(step.request) && isRecord(step.request.multipart) ? step.request.multipart.fileCount : undefined },
			{ key: "variableScope", value: (step) => step.variableScope },
			{ key: "capturedVariables", value: (step) => step.capturedVariableNames },
			{ key: "persistedVariables", value: (step) => step.persistedVariableNames },
			{ key: "delta", value: (step) => step.delta },
			{ key: "error", value: (step) => step.error },
		], 20),
		redirects: isRecord(value) && Array.isArray(value.redirects) ? value.redirects.length : 0,
		nextActions: [
			"use browser_fuzz mode=param, browser_sqli, or browser_template only after narrowing the replay target and preserving a baseline request",
			"read saved replay artifacts or rerun with compareBaseline:true when response deltas need manual confirmation",
			"keep replay mutations narrow and explicit instead of widening into broad fuzzing when one request variant is enough",
		],
	};
}
