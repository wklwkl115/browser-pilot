import assert from "node:assert/strict";
import test from "node:test";
import {
	prepareTaskView,
	prepareTaskViewTarget,
	validateTaskAnchorSnapshot,
	observeViewSchema,
} from "../../src/commands/observe/taskViewInput.ts";
import { registerRefDescriptor } from "../../src/resources/resourceRefs.ts";
import type { BrowserCommandRuntimePort } from "../../src/ports/BrowserCommandRuntimePort.ts";
import { taskObservation } from "../helpers/taskView.ts";
import { Value } from "typebox/value";

test("view validates small semantic inputs without implicit or persistent focus", () => {
	assert.equal(prepareTaskView(undefined), undefined);
	assert.equal(prepareTaskView("page"), undefined);
	assert.deepEqual(prepareTaskView({ focus: { query: " INV-2048 " }, fields: [" 备注 ", "备注"] }), {
		focus: { query: "INV-2048" },
		intent: "read",
		fields: ["备注"],
	});
	for (const value of [
		{},
		{ intent: "check" },
		{ focus: { query: " " } },
		{ focus: { refs: [] } },
		{ focus: { refs: ["bp-ref://control/a"], query: "a" } },
		{ focus: { query: "x" }, fields: [" "] },
		{ focus: { query: "x" }, maxEntities: 1 },
		{ focus: { query: "x".repeat(257) } },
		{ focus: { refs: Array(9).fill("bp-ref://control/a") } },
	]) {
		assert.equal(Value.Check(observeViewSchema, value), false);
		assert.throws(() => prepareTaskView(value), /view requires/);
	}
});

let refCount = 0;
function registerFocus(options: { tabId?: number; epoch?: string; createdAt?: number; ttlMs?: number } = {}) {
	const createdAt = options.createdAt ?? Date.now();
	return registerRefDescriptor({
		descriptor: {
			refId: `bp-ref://region/task-input-${++refCount}`,
			kind: "region",
			locators: [],
			owner: { browserSessionId: "session-1", tabId: options.tabId ?? 7, topLevelOrigin: "https://example.test" },
			policy: { shareableAcrossSessions: false, liveActionsAllowed: false },
			observationId: "snapshot-task",
			createdAt,
			ttlMs: options.ttlMs ?? 60000,
			documentEpoch: {
				targetGeneration: 1,
				pageEpoch: options.epoch ?? "page-1",
				url: "https://example.test/invoices",
				capturedAt: createdAt,
			},
		},
	});
}

function runtime() {
	return {
		resolveTargetTabId: (value: unknown) => Number(String(value).replace("tab-", "")),
		snapshot: () => ({
			browserSessionId: "session-1",
			defaultTabId: 9,
			tabs: [7, 8, 9].map((tabId) => ({
				tabId,
				pageEpoch: "page-1",
				targetGeneration: 1,
				url: "https://example.test/invoices",
			})),
		}),
	} as unknown as BrowserCommandRuntimePort;
}

test("task refs pin observation to their owner even when the active tab differs", () => {
	const ref = registerFocus();
	const prepared = prepareTaskViewTarget(runtime(), { view: prepareTaskView({ focus: { refs: [ref] } }) });
	assert.equal(prepared.targetRef, "7");
	assert.equal(prepared.browserSessionId, "session-1");
	assert.equal(
		prepared.taskAnchors![0]!.policy.liveActionsAllowed,
		false,
		"observation must not require write permission",
	);
	validateTaskAnchorSnapshot(prepared.taskAnchors, taskObservation([]));
	assert.throws(
		() =>
			validateTaskAnchorSnapshot(
				prepared.taskAnchors,
				taskObservation([], { snapshot: { ...taskObservation([]).snapshot, pageEpoch: "page-2" } }),
			),
		/page changed during observation/,
	);
});

test("task refs reject conflicting targets, mixed owners, stale pages and expired identities", () => {
	const first = registerFocus();
	const second = registerFocus({ tabId: 8 });
	assert.throws(
		() =>
			prepareTaskViewTarget(runtime(), {
				targetRef: "tab-8",
				view: prepareTaskView({ focus: { refs: [first] } }),
			}),
		/conflicts with ref ownership/,
	);
	assert.throws(
		() => prepareTaskViewTarget(runtime(), { view: prepareTaskView({ focus: { refs: [first, second] } }) }),
		/different tabs/,
	);
	assert.throws(
		() =>
			prepareTaskViewTarget(runtime(), {
				view: prepareTaskView({ focus: { refs: [registerFocus({ epoch: "old-page" })] } }),
			}),
		/identity cannot be proven current/,
	);
	assert.throws(
		() =>
			prepareTaskViewTarget(runtime(), {
				view: prepareTaskView({ focus: { refs: [registerFocus({ createdAt: 1, ttlMs: 1 })] } }),
			}),
		/expired|stale|unavailable/i,
	);
});
