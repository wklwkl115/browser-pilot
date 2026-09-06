import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";
import type { VerificationResult } from "../kernels/abml/types.js";
import { verifyAbmlState } from "../kernels/abml/verification.js";
import { readAbmlVerificationObservation } from "../browser-command-runtime/abml/verification.js";
import { isRecord } from "../utils/records.js";
import type { DeclarativeCondition, RequestCondition, TextMatch } from "./conditionSchema.js";

export type NetworkBaseline = { recorderId: string; createdAt: number; lastSeq: number; overflowCount: number };
export type ConditionRuntime = {
	server: BrowserCommandRuntimePort;
	verb: string;
	browserSessionId?: string;
	tabId?: number;
	rawTarget?: string | number;
	timeoutMs: number;
	signal?: AbortSignal;
	networkBaseline?: NetworkBaseline;
	/** null means the pre-write document could not be identified. */
	documentBaseline?: number | null;
	/** Conjunctive target constraints inherited only through allOf branches. */
	targetDocumentUrls?: readonly string[];
};

export function hasDomCondition(condition: DeclarativeCondition): boolean {
	if ("allOf" in condition) return condition.allOf.some(hasDomCondition);
	if ("anyOf" in condition) return condition.anyOf.some(hasDomCondition);
	return "text" in condition || "value" in condition;
}

export async function readDocumentBaseline(runtime: ConditionRuntime): Promise<number | null> {
	try {
		const result = await runtime.server.executeJavaScript("return performance.timeOrigin;", {
			browserSessionId: runtime.browserSessionId,
			tabId: runtime.rawTarget ?? runtime.tabId,
			timeoutMs: runtime.timeoutMs,
			accessMode: "read",
			signal: runtime.signal,
		});
		return typeof result.data === "number" && Number.isFinite(result.data) ? result.data : null;
	} catch {
		runtime.signal?.throwIfAborted();
		return null;
	}
}

export function conditionResult(
	verb: string,
	status: VerificationResult["status"],
	expected: Record<string, unknown>,
	observed: Record<string, unknown>,
	summary: string,
): VerificationResult {
	return { status, verb, expected, observed, evidence: [{ kind: "declared-condition", summary }], elapsedMs: 0 };
}

async function nativeRead(runtime: ConditionRuntime, command: Record<string, unknown> & { cmd: string }) {
	const response = await runtime.server.sendCommand(command, {
		browserSessionId: runtime.browserSessionId,
		tabId: runtime.rawTarget ?? runtime.tabId,
		timeoutMs: runtime.timeoutMs,
		accessMode: "read",
		signal: runtime.signal,
	});
	return isRecord(response.data) ? response.data : {};
}

export async function readNetworkBaseline(runtime: ConditionRuntime): Promise<NetworkBaseline | undefined> {
	try {
		const status = await nativeRead(runtime, { cmd: "network.status" });
		if (
			status.active !== true ||
			typeof status.recorderId !== "string" ||
			typeof status.lastSeq !== "number" ||
			typeof status.createdAt !== "number"
		)
			return undefined;
		return {
			recorderId: status.recorderId,
			createdAt: status.createdAt,
			lastSeq: status.lastSeq,
			overflowCount: Number(status.overflowCount ?? 0),
		};
	} catch {
		runtime.signal?.throwIfAborted();
		return undefined;
	}
}

function matchesText(value: string, match: TextMatch): boolean {
	return "equals" in match ? value === match.equals : value.includes(match.contains);
}

function jsonPointer(value: unknown, pointer: string): unknown {
	if (!pointer) return value;
	let current = value;
	for (const segment of pointer.slice(1).split("/")) {
		const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
		if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

async function requestBodyChecks(runtime: ConditionRuntime, request: RequestCondition, id: string) {
	const body = await nativeRead(runtime, { cmd: "network.body", requestId: id, maxBytes: 262_144 });
	if (body.bodyTruncated !== false || typeof body.body !== "string") return undefined;
	const text = body.base64Encoded === true ? Buffer.from(body.body, "base64").toString("utf8") : body.body;
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return undefined;
	}
	return request.json!.map((field) => {
		const value = jsonPointer(json, field.pointer);
		return { pointer: field.pointer, matched: value !== undefined && Object.is(value, field.equals) };
	});
}

async function evaluateRequest(
	condition: { request: RequestCondition },
	runtime: ConditionRuntime,
): Promise<VerificationResult> {
	const baseline = runtime.networkBaseline;
	const unknown = (summary: string) => conditionResult(runtime.verb, "inconclusive", condition, {}, summary);
	if (!baseline) return unknown("No active request recorder baseline was available before this operation");
	const current = await readNetworkBaseline(runtime);
	if (
		!current ||
		current.recorderId !== baseline.recorderId ||
		current.createdAt !== baseline.createdAt ||
		current.overflowCount !== baseline.overflowCount
	)
		return unknown("Request recorder changed or lost evidence since the operation started");
	const { request } = condition;
	const listed = await nativeRead(runtime, {
		cmd: "network.list",
		sinceSeq: baseline.lastSeq,
		url: request.url,
		method: request.method,
		limit: 100,
		...(request.requestId ? { requestId: request.requestId } : {}),
	});
	if (!Array.isArray(listed.items) || (listed.nextOffset !== null && listed.nextOffset !== undefined))
		return unknown("Request evidence is incomplete");
	const matches = listed.items.filter(isRecord).filter((item) => {
		const req = isRecord(item.request) ? item.request : {};
		return req.url === request.url && req.method === request.method && Number(item.seq) > baseline.lastSeq;
	});
	if (matches.length !== 1)
		return unknown(
			matches.length
				? "Multiple requests match; use a unique URL or requestId"
				: "The declared request has not been captured",
		);
	const item = matches[0]!;
	const response = isRecord(item.response) ? item.response : {};
	const observed = {
		requestId: item.requestId,
		status: response.status,
		phase: item.phase,
		responseComplete: item.phase === "finished",
	};
	if (typeof response.status !== "number")
		return unknown("The matching request has no captured HTTP response status");
	if (response.status !== request.status)
		return conditionResult(
			runtime.verb,
			"unmet",
			condition,
			observed,
			"Captured request did not satisfy the declared response condition",
		);
	const fields = request.json ? await requestBodyChecks(runtime, request, String(item.requestId)) : undefined;
	if (request.json && !fields) return unknown("A complete JSON response body is unavailable");
	return conditionResult(
		runtime.verb,
		fields?.some((field) => !field.matched) ? "unmet" : "verified",
		condition,
		{ ...observed, ...(fields ? { fields } : {}) },
		"Captured HTTP status checked; JSON fields require a complete body. Status alone proves neither response-body completion nor business persistence",
	);
}

async function evaluateDom(
	condition: { text: { selector: string; match: TextMatch } } | { value: { selector: string; equals: string } },
	runtime: ConditionRuntime,
) {
	const selector = "text" in condition ? condition.text.selector : condition.value.selector;
	const property = "text" in condition ? "textContent" : "value";
	// Only generated read expressions run here. Selector and expected values are data, never code.
	const script = `const nodes = document.querySelectorAll(${JSON.stringify(selector)});
if (nodes.length !== 1) return { count: nodes.length };
const node = nodes[0];
if (node.matches('input[type="password"]')) return { count: 1, unavailable: 'password' };
const value = node[${JSON.stringify(property)}];
return { count: 1, value: typeof value === 'string' ? value.slice(0, 4096) : null, truncated: typeof value === 'string' && value.length > 4096, documentOrigin: performance.timeOrigin, url: location.href };`;
	const result = await runtime.server.executeJavaScript(script, {
		browserSessionId: runtime.browserSessionId,
		tabId: runtime.rawTarget ?? runtime.tabId,
		timeoutMs: runtime.timeoutMs,
		accessMode: "read",
		signal: runtime.signal,
	});
	const data = isRecord(result.data) ? result.data : {};
	const targetMatches = runtime.targetDocumentUrls?.length
		? runtime.targetDocumentUrls.every((url) => data.url === url)
		: runtime.documentBaseline === undefined ||
			(typeof runtime.documentBaseline === "number" && data.documentOrigin === runtime.documentBaseline);
	if (!targetMatches)
		return conditionResult(
			runtime.verb,
			"inconclusive",
			condition,
			{ url: data.url, documentOrigin: data.documentOrigin },
			"DOM evidence does not satisfy its exact target URL constraints or original document boundary",
		);
	if (data.count !== 1 || typeof data.value !== "string" || data.truncated === true)
		return conditionResult(
			runtime.verb,
			"inconclusive",
			condition,
			{ count: data.count },
			"A unique, complete non-password value was not available",
		);
	const matched =
		"text" in condition ? matchesText(data.value, condition.text.match) : data.value === condition.value.equals;
	return conditionResult(
		runtime.verb,
		matched ? "verified" : "unmet",
		condition,
		{ value: data.value },
		"DOM value observed; this is a UI assertion, not proof of server persistence",
	);
}

async function evaluateCombination(
	condition: { allOf: DeclarativeCondition[] } | { anyOf: DeclarativeCondition[] },
	runtime: ConditionRuntime,
) {
	const all = "allOf" in condition;
	const children = all ? condition.allOf : condition.anyOf;
	const destinations = all
		? children.flatMap((child) => ("url" in child && "equals" in child.url ? [child.url.equals] : []))
		: [];
	const childRuntime = destinations.length
		? { ...runtime, targetDocumentUrls: [...(runtime.targetDocumentUrls ?? []), ...destinations] }
		: runtime;
	const results: VerificationResult[] = [];
	for (const child of children) {
		const result = await evaluateCondition(child, childRuntime);
		results.push(result);
		if (result.status === (all ? "unmet" : "verified")) break;
	}
	const status = all
		? results.some((result) => result.status === "unmet")
			? "unmet"
			: results.every((result) => result.status === "verified")
				? "verified"
				: "inconclusive"
		: results.some((result) => result.status === "verified")
			? "verified"
			: results.every((result) => result.status === "unmet")
				? "unmet"
				: "inconclusive";
	const result = conditionResult(
		runtime.verb,
		status,
		condition,
		{
			conditions: results.map((item) => ({ status: item.status, observed: item.observed })),
			skippedConditions: children.length - results.length,
		},
		`${all ? "allOf" : "anyOf"} evaluated over declared evidence; observations are not an atomic server transaction`,
	);
	result.evidence.push(...results.flatMap((item) => item.evidence));
	return result;
}

export async function evaluateCondition(
	condition: DeclarativeCondition,
	runtime: ConditionRuntime,
): Promise<VerificationResult> {
	runtime.signal?.throwIfAborted();
	try {
		if (runtime.tabId === undefined)
			return conditionResult(
				runtime.verb,
				"inconclusive",
				condition,
				{},
				"Operation has no tracked browser target",
			);
		if ("allOf" in condition || "anyOf" in condition) return await evaluateCombination(condition, runtime);
		if ("ref" in condition) {
			const observation = await readAbmlVerificationObservation({
				...runtime,
				tabId: runtime.tabId,
				rawTarget: runtime.rawTarget ?? runtime.tabId,
				expectation: condition,
			});
			return verifyAbmlState(runtime.verb, condition, observation, 0);
		}
		if ("request" in condition) return await evaluateRequest(condition, runtime);
		if ("text" in condition || "value" in condition) return await evaluateDom(condition, runtime);
		const result = await runtime.server.executeJavaScript("return location.href;", {
			browserSessionId: runtime.browserSessionId,
			tabId: runtime.rawTarget ?? runtime.tabId,
			timeoutMs: runtime.timeoutMs,
			accessMode: "read",
			signal: runtime.signal,
		});
		if (typeof result.data !== "string")
			return conditionResult(runtime.verb, "inconclusive", condition, {}, "URL unavailable");
		return conditionResult(
			runtime.verb,
			matchesText(result.data, condition.url) ? "verified" : "unmet",
			condition,
			{ url: result.data },
			"Current URL observed",
		);
	} catch {
		runtime.signal?.throwIfAborted();
		return conditionResult(runtime.verb, "inconclusive", condition, {}, "Declared evidence could not be read");
	}
}
