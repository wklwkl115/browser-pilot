/**
 * Pure AgentTrace model (no I/O).
 */

import type { AgentAutomaticAction } from "./agentTypes.js";

export type AgentTraceRecord = {
	traceRef: string;
	contextRef: string;
	owner: string;
	contextRevisionBefore: number;
	contextRevisionAfter: number;
	requestSummary: Record<string, unknown>;
	compiledPlanSummary?: Record<string, unknown>;
	rawOperationRef?: string;
	rawObservationRef?: string;
	automaticActionsTaken: AgentAutomaticAction[];
	projectionReport: {
		candidatesConsidered: number;
		candidatesReturned: number;
		readsBound: number;
		chars: number;
		bytes: number;
		estimatedTokens: number;
	};
	redaction: Record<string, unknown>;
	createdAt: number;
	expiresAt: number;
};

export type AgentTraceDescriptor = {
	available: boolean;
	traceRef?: string;
	unavailableReason?: string;
};

export function traceDescriptorFromRecord(record: AgentTraceRecord | undefined, reason?: string): AgentTraceDescriptor {
	if (!record) return { available: false, unavailableReason: reason ?? "trace_unavailable" };
	return { available: true, traceRef: record.traceRef };
}

/** Redact request summaries before persistence (no secrets/paths). */
export function redactTraceRequestSummary(summary: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(summary)) {
		if (/password|token|secret|authorization|cookie/i.test(key)) {
			out[key] = "[redacted]";
			continue;
		}
		if (key === "value" && typeof value === "string") {
			out.valueLength = value.length;
			continue;
		}
		if (typeof value === "string" && (/[A-Za-z]:\\/.test(value) || value.includes(".browser-pilot"))) {
			out[key] = "[path-redacted]";
			continue;
		}
		out[key] = value;
	}
	return out;
}
