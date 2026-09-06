import { assessTaskNeed } from "./task-need-oracle.mjs";

export const NEED_READING_BUDGET = { maxResourceReads: 12, maxContextJsonBytes: 512 * 1024 };
const list = (value) => (Array.isArray(value) ? value : []);
const normalize = (value) => (typeof value === "string" ? value.toLowerCase().trim() : "");
export const responseBytes = (response) => Buffer.byteLength(JSON.stringify(response));

export function responseValue(response) {
	if (response.structuredContent) return response.structuredContent;
	const items = response.contents ?? response.content;
	const content = list(items).find((item) => typeof item.text === "string");
	if (!content) return {};
	try {
		return JSON.parse(content.text);
	} catch {
		return {};
	}
}

function discover(value, response, fallbackUri) {
	const links = [];
	const add = (uri, kind, item = {}) => {
		if (typeof uri !== "string" || !uri.startsWith("browser-pilot://observation/")) return;
		links.push({
			uri,
			kind: uri === fallbackUri ? "snapshot-evidence" : kind,
			label: item.question ?? item.anchor?.name ?? item.label ?? item.name ?? "",
			mandatory: item.mandatory === true,
		});
	};
	const visit = (node) => {
		if (!node || typeof node !== "object") return;
		for (const item of list(node.frontier?.items))
			add(item.resourceUri, item.ref === "frontier:task-view" ? "task-index" : "page-resource", item);
		for (const item of list(node.remedies))
			if (item.kind === "read-snapshot") add(item.resourceUri, "page-resource", item);
		for (const item of list(node.groups)) {
			add(item.resourceUri, "group", item);
			visit(item);
		}
		for (const item of list(node.packetIndex?.packets)) {
			add(item.resourceUri, "packet", item);
			visit(item);
		}
		if (node.packetIndex?.nextUri) add(node.packetIndex.nextUri, "packet-index");
		if (node.nextUri) add(node.nextUri, node.packets ? "packet-index" : "task-index");
		for (const item of list(node.packets)) {
			if (item.resourceUri) add(item.resourceUri, "packet", item);
			visit(item);
		}
		for (const item of list(node.bundles)) visit(item);
		visit(node.bundle);
		visit(node.packet);
		visit(node.value);
	};
	visit(value);
	for (const item of list(response.content))
		if (item.type === "resource_link" && !links.some((link) => link.uri === item.uri))
			add(item.uri, "page-resource", item);
	return links;
}

function priority(link, profile, input) {
	if (link.kind === "snapshot-evidence") return 9;
	if (profile === "page") return link.kind === "page-resource" ? 1 : Infinity;
	if (profile === "wholeGroup" && ["packet", "packet-index"].includes(link.kind)) return Infinity;
	if (link.mandatory) return 0;
	if (["task-index", "packet-index"].includes(link.kind)) return 1;
	const label = normalize(link.label);
	const relevant = [input.focus?.query, ...list(input.fields)]
		.filter(Boolean)
		.some((term) => label.includes(normalize(term)));
	if (link.kind === "packet") return relevant ? 0 : 4;
	if (link.kind === "group") return relevant ? 2 : 5;
	return 10;
}

/** The reader sees public links and input only; fixture bindings are used solely to judge delivered responses. */
export async function evaluateNeedPath({
	profile,
	initialResponse,
	readResource,
	need,
	input,
	fallbackUri,
	budget = NEED_READING_BUDGET,
}) {
	if (!["page", "wholeGroup", "progressivePacket"].includes(profile)) throw new Error("Unknown reading profile");
	if (
		!Number.isSafeInteger(budget.maxResourceReads) ||
		budget.maxResourceReads < 0 ||
		!Number.isSafeInteger(budget.maxContextJsonBytes) ||
		budget.maxContextJsonBytes < 0
	)
		throw new Error("Reading budgets must be nonnegative safe integers");
	const observations = [];
	const queue = new Map();
	const visited = new Set();
	const trace = [];
	let contextJsonBytes = 0;
	let obtainedResponseJsonBytes = 0;
	let resourceReads = 0;
	let assessment = assessTaskNeed(need, observations);
	const finish = (status, reason) => ({
		status,
		reason,
		contextJsonBytes,
		obtainedResponseJsonBytes,
		resourceReads,
		checks: assessment.checks,
		missing: assessment.missing,
		trace,
	});
	const accept = (response, resourceKind, evidence = true) => {
		const bytes = responseBytes(response);
		obtainedResponseJsonBytes += bytes;
		if (contextJsonBytes + bytes > budget.maxContextJsonBytes) {
			trace.push({ resourceKind, responseJsonBytes: bytes, admitted: false, missing: assessment.missing });
			return false;
		}
		contextJsonBytes += bytes;
		const value = responseValue(response);
		if (evidence) {
			observations.push(value);
			assessment = assessTaskNeed(need, observations);
		}
		trace.push({ resourceKind, responseJsonBytes: bytes, admitted: true, missing: assessment.missing });
		for (const link of evidence ? discover(value, response, fallbackUri) : [])
			if (!visited.has(link.uri) && Number.isFinite(priority(link, profile, input)) && !queue.has(link.uri))
				queue.set(link.uri, link);
		return true;
	};
	if (!accept(initialResponse, "observe")) return finish("budget-exhausted", "context-byte-limit");
	while (!assessment.satisfied) {
		if (!queue.size) return finish("unsatisfied", "no-unread-resource");
		if (resourceReads >= budget.maxResourceReads) return finish("budget-exhausted", "resource-read-limit");
		const next = [...queue.values()].sort((a, b) => priority(a, profile, input) - priority(b, profile, input))[0];
		queue.delete(next.uri);
		visited.add(next.uri);
		resourceReads++;
		let response;
		try {
			response = await readResource(next.uri);
		} catch {
			const error = { error: { code: "RESOURCE_READ_FAILED" } };
			const admitted = accept(error, "resource-error", false);
			return finish(admitted ? "unsatisfied" : "budget-exhausted", "resource-read-failed");
		}
		if (response.error || response.isError) {
			const admitted = accept(response, "resource-error", false);
			return finish(admitted ? "unsatisfied" : "budget-exhausted", "resource-read-failed");
		}
		if (!accept(response, next.kind)) return finish("budget-exhausted", "context-byte-limit");
	}
	return finish("satisfied", "fixture-requirements-met");
}
