import test from "node:test";
import assert from "node:assert/strict";
import { summarizeEvidenceData } from "../../../src/tools/summaries/evidence.ts";

test("summarizeEvidenceData returns type for non-record input", () => {
	const result = summarizeEvidenceData(null);
	assert.ok("type" in result);
});

test("summarizeEvidenceData handles empty sources", () => {
	const result = summarizeEvidenceData({ tabId: 1, sources: {} });
	assert.equal(result.tabId, 1);
	assert.equal(result.source_count, 0);
	assert.ok(!("artifact_hints" in result));
});

test("summarizeEvidenceData summarizes hook_collect source", () => {
	const data = {
		tabId: 5,
		sources: {
			hook_collect: {
				ok: true,
				data: {
					events: [
						{ type: "click" },
						{ type: "click" },
						{ type: "input" },
					],
					total: 3,
				},
			},
		},
	};
	const result = summarizeEvidenceData(data);
	assert.equal(result.tabId, 5);
	assert.equal(result.source_count, 1);
	const sources = result.sources as Record<string, unknown>;
	const hookCollect = sources.hook_collect as Record<string, unknown>;
	assert.equal(hookCollect.ok, true);
	assert.equal(hookCollect.events, 3);
});

test("summarizeEvidenceData includes artifact hints when sources exist", () => {
	const data = {
		sources: {
			network: { ok: true, data: { entries: [], total: 0 } },
		},
	};
	const result = summarizeEvidenceData(data);
	assert.ok("artifact_hints" in result);
});

test("summarizeEvidenceData extracts special hook_status fields", () => {
	const data = {
		sources: {
			hook_status: {
				ok: true,
				data: {
					state: "active",
					session_id: "sess-123",
					dispatcher_version: "1.2.3",
					buffer_used: 42,
				},
			},
		},
	};
	const result = summarizeEvidenceData(data);
	const sources = result.sources as Record<string, unknown>;
	const hookStatus = sources.hook_status as Record<string, unknown>;
	assert.equal(hookStatus.state, "active");
	assert.equal(hookStatus.session_id, "sess-123");
	assert.equal(hookStatus.buffer_used, 42);
});

test("summarizeEvidenceData collects eventTypes counts per source", () => {
	const data = {
		sources: {
			events: {
				ok: true,
				data: {
					events: [
						{ type: "xhr" },
						{ type: "xhr" },
						{ type: "ws" },
					],
				},
			},
		},
	};
	const result = summarizeEvidenceData(data);
	const sources = result.sources as Record<string, unknown>;
	const eventsSource = sources.events as Record<string, unknown>;
	const eventTypes = eventsSource.eventTypes as Array<{ key: string; count: number }>;
	const xhrCount = eventTypes.find((item) => item.key === "xhr");
	assert.ok(xhrCount);
	assert.equal(xhrCount!.count, 2);
});
