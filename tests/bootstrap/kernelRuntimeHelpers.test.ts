import test from "node:test";
import assert from "node:assert/strict";
import type { Entity } from "../../src/kernels/abml/entity.ts";
import { displayEntityText, groupEntities, isActionableOrStructural, isPureTextLeaf, normalizeEntityText, structureScopeKey, suppressNestedNonControlGroups, templateGroupDescriptorForEntity } from "../../src/kernels/abml/grouping.ts";
import { buildCollectionModels, summarizeCollectionCompleteness } from "../../src/kernels/abml/collections.ts";
import { buildSnapshotProjection } from "../../src/kernels/abml/snapshotProjection.ts";
import { buildIdentityGraph, identityGraphSummary } from "../../src/kernels/abml/identityGraph.ts";
import { buildEventEntity, buildNetworkEntryEntity, createCaptureRef, mapCaptureState } from "../../src/kernels/abml/stream.ts";
import { classifyStaleness, classifyStateLoss, classifyTimeout, diagnoseWaitTimeout } from "../../src/kernels/temporal/classify.ts";
import { allocateTemporalBudget, classifyDeadlinePressure } from "../../src/kernels/temporal/budget.ts";
import { estimatePageFreshness, estimateTargetContinuity, estimateWaitContinuity } from "../../src/kernels/temporal/estimate.ts";
import { TEMPORAL_REASON_MODEL_CAP, type TemporalAnchor, type TemporalStamp } from "../../src/kernels/temporal/types.ts";
import { jsonForInlineScript, renderCaptureTemplate } from "../../src/capture/inject.ts";
import { buildScanScript } from "../../src/scan/buildScanScript.ts";

function entity(ref: string, overrides: Partial<Entity> = {}): Entity {
	return {
		ref,
		kind: "control",
		role: "button",
		name: "Open details",
		state: {
			visible: true,
			occluded: false,
			disabled: false,
			focused: false,
			editable: false,
			inViewport: true,
		},
		source: "dom",
		...overrides,
	};
}

function stamp(overrides: Partial<TemporalStamp> = {}): TemporalStamp {
	return {
		version: "temporal-stamp/v1",
		browserSessionId: "session-1",
		tabId: 1,
		targetRef: "target-1",
		capturedAtMs: 1_000,
		clockDomain: "driver_wall",
		changeSeq: 5,
		...overrides,
	};
}

function anchor(overrides: Partial<TemporalStamp> = {}): TemporalAnchor {
	return { version: "temporal-anchor/v1", source: "observe", stamp: stamp(overrides) };
}

test("temporal classifier prioritizes deterministic state loss and bounds reason output", () => {
	assert.deepEqual(classifyStateLoss({ extensionUnavailable: true }), {
		verdict: { status: "unknown", confidence: "lost", reasons: ["extension_unavailable"] },
		frontier: { next: "fail_closed" },
		source: "driver_snapshot",
	});
	assert.deepEqual(classifyStateLoss({}), {
		verdict: { status: "fresh", confidence: "mechanical", reasons: ["same_wait_history"] },
		frontier: { next: "retry_same_wait" },
		source: "wait_supervisor",
	});
	assert.deepEqual(classifyTimeout({ historyLost: true, lateSuccessAfterDeadline: true }), {
		verdict: { status: "unknown", confidence: "lost", reasons: ["worker_restarted_history_lost", "unknown_due_to_history_loss"] },
		frontier: { next: "diagnose" },
		source: "wait_supervisor",
	});
	assert.equal(classifyStaleness({ targetRegionDirty: true }).verdict.reasons.length <= TEMPORAL_REASON_MODEL_CAP, true);
});

test("temporal classifier handles empty, malformed-adjacent, and boundary wait signals", () => {
	assert.deepEqual(classifyTimeout({}), {
		verdict: { status: "unknown", confidence: "partial", reasons: ["underconstrained_wait"] },
		frontier: { next: "diagnose" },
		source: "wait_supervisor",
	});
	assert.deepEqual(classifyTimeout({ workerRestarts: -1, acknowledged: false }), {
		verdict: { status: "unknown", confidence: "partial", reasons: ["no_ack"] },
		frontier: { next: "retry_same_wait" },
		source: "wait_supervisor",
	});
	assert.deepEqual(classifyStaleness({ targetRegionDirty: true, stableLocator: true, cssOnlyLocator: false }), {
		verdict: { status: "stale", confidence: "mechanical", reasons: ["target_stale_before_dispatch", "target_region_dirty"] },
		frontier: { next: "reobserve" },
		source: "execute_effect",
	});
	assert.deepEqual(classifyStaleness({}), {
		verdict: { status: "fresh", confidence: "mechanical", reasons: ["same_target"] },
		frontier: { next: "reuse_target" },
		source: "execute_effect",
	});
});

test("temporal estimate and budget helpers handle missing anchors, fallback sources, and budget clamps", () => {
	assert.deepEqual(estimateTargetContinuity({ current: stamp() }), {
		verdict: { status: "unknown", confidence: "partial", reasons: ["unknown_due_to_missing_anchor"] },
		frontier: { next: "reobserve" },
		source: "ref_descriptor",
	});
	assert.deepEqual(estimateTargetContinuity({ anchor: anchor({ tabHandle: "old" }), current: stamp({ tabHandle: "new" }) }), {
		verdict: { status: "stale", confidence: "mechanical", reasons: ["tab_replaced"] },
		frontier: { next: "reobserve" },
		source: "driver_snapshot",
	});
	assert.deepEqual(estimateTargetContinuity({ anchor: anchor({ clockDomain: "driver_wall", targetRef: undefined, tabId: undefined }), current: stamp({ clockDomain: "page_wall", targetRef: undefined, tabId: undefined, changeSeq: undefined }) }), {
		verdict: { status: "unknown", confidence: "partial", reasons: ["unknown_due_to_clock_domain"] },
		frontier: { next: "reobserve" },
		source: "driver_snapshot",
	});
	assert.deepEqual(estimatePageFreshness({ anchor: anchor(), current: stamp({ capturedAtMs: 2_100 }), maxSameDomainAgeMs: 1_000 }), {
		verdict: { status: "possibly_stale", confidence: "bounded", reasons: ["target_possibly_stale"] },
		frontier: { next: "reobserve" },
		source: "page_signal",
	});
	assert.deepEqual(estimateWaitContinuity({ eventSource: "poll_fallback" }), {
		verdict: { status: "possibly_stale", confidence: "bounded", reasons: ["selector_unstable"] },
		frontier: { next: "retry_same_wait" },
		source: "poll_fallback",
	});
	assert.deepEqual(allocateTemporalBudget({ remainingMs: 50, reserveMs: 100, candidates: [{ action: "wait", reason: "same_target", cost: { wallMs: 1, bridgeRoundTrips: 1, expectedToolCalls: 1, tokenChars: 1, confidenceLoss: 0 }, expectedEvidence: ["driver_snapshot"] }] }), {
		action: "fail_closed",
		budgetMs: 0,
		reason: "queue_delay_budget_exceeded",
		expectedEvidence: [],
		frontier: { next: "fail_closed" },
	});
	assert.deepEqual(allocateTemporalBudget({
		remainingMs: 200,
		reserveMs: -100,
		candidates: [
			{ action: "wait", reason: "network_active", cost: { wallMs: 250, bridgeRoundTrips: 2, expectedToolCalls: 2, tokenChars: 100, confidenceLoss: 2 }, expectedEvidence: ["page_signal"] },
			{ action: "immediate_probe", reason: "same_target", cost: { wallMs: 20, bridgeRoundTrips: 1, expectedToolCalls: 1, tokenChars: 300, confidenceLoss: 0 }, expectedEvidence: ["driver_snapshot"], frontierNext: "reuse_target" },
		],
	}), {
		action: "immediate_probe",
		budgetMs: 20,
		reason: "same_target",
		expectedEvidence: ["driver_snapshot"],
		frontier: { next: "reuse_target" },
		verdict: undefined,
	});
	assert.equal(classifyDeadlinePressure({ remainingMs: 10, requiredMs: 20 }).frontier.next, "fail_closed");
	assert.equal(classifyDeadlinePressure({ remainingMs: -1, requiredMs: -2 }).verdict.status, "fresh");
});

test("wait timeout diagnosis maps selector, network, infrastructure, and fallback cases", () => {
	assert.deepEqual(diagnoseWaitTimeout({ command: "wait.selector", reasons: ["selector_missing"], selector: "#login" }), {
		waitType: "selector",
		condition: "element matching \"#login\" to appear",
		observedState: "element not found in document",
		suggestion: "element not found — verify selector is correct, re-observe the page with browser_observe, or check if the element is inside an iframe",
	});
	assert.equal(diagnoseWaitTimeout({ command: "network.wait", reasons: ["network_active"], pendingRequests: 1 }).observedState, "1 network request still pending");
	assert.equal(diagnoseWaitTimeout({ command: "network.wait", reasons: ["network_active"], pendingRequests: 2 }).observedState, "2 network requests still pending");
	assert.equal(diagnoseWaitTimeout({ command: "wait.loadState", reasons: [], loadState: "interactive", loadStateTarget: "complete" }).condition, "page load state to reach \"complete\"");
	assert.equal(diagnoseWaitTimeout({ command: "custom.wait", reasons: [], bridgeTimeout: true }).observedState, "bridge communication timed out — command was acknowledged but no result received");
	assert.equal(diagnoseWaitTimeout({ command: "custom.wait", reasons: [] }).waitType, "wait");
});

test("ABML grouping helpers normalize descriptors and suppress nested non-control groups", () => {
	const controls = Array.from({ length: 4 }, (_, index) => entity(`bp-ref://control/${index}`, {
		name: `Row ${index + 1}`,
		structure: { setSize: 4, posInSet: index + 1 },
		hints: { containerRole: "list", containerName: "Results" },
	}));
	const regions = Array.from({ length: 4 }, (_, index) => entity(`bp-ref://region/${index}`, {
		kind: "region",
		role: "region",
		name: `Panel ${index + 1}`,
		structure: { setSize: 4, posInSet: index + 1 },
		hints: { containerRole: "list", containerName: "Results" },
	}));
	const groups = groupEntities([...controls, ...regions]);
	assert.equal(groups.length, 2);
	assert.deepEqual(templateGroupDescriptorForEntity(entity("bp-ref://single/1")), undefined);
	assert.equal(structureScopeKey(groups[0]!.descriptor), JSON.stringify(["c", "list", "Results"]));
	assert.equal(suppressNestedNonControlGroups(groups).length, 1);
	assert.equal(suppressNestedNonControlGroups(groups)[0]!.descriptor.kind, "control");
	assert.deepEqual(groupEntities([]), []);
});

test("ABML grouping text helpers handle normal, empty, malformed, and boundary-sized values", () => {
	assert.equal(normalizeEntityText("  Save\n\tChanges  "), "save changes");
	assert.equal(normalizeEntityText("   "), undefined);
	assert.equal(normalizeEntityText(42), undefined);
	assert.equal(displayEntityText("x".repeat(130)), "x".repeat(120));
	assert.equal(isPureTextLeaf({ role: "StaticText", kind: "element" }), true);
	assert.equal(isPureTextLeaf({ role: "button", kind: "text" }), true);
	assert.equal(isActionableOrStructural({ role: "button", kind: "control" }), true);
	assert.equal(isActionableOrStructural({ role: "InlineTextBox", kind: "element" }), false);
});

test("ABML stream helpers normalize capture, network, and event boundary inputs", () => {
	const context = { observationId: "obs-1", capturedAt: 1_000, url: "https://example.test/app", browserSessionId: "session-1", tabId: 7 };
	const capture = createCaptureRef({ refId: "cap-1", state: "active", startedAt: 900, expiresAt: 900, lastSeq: 3, context });
	assert.equal(capture.ttlMs, 1);
	assert.equal(capture.owner.topLevelOrigin, "https://example.test");
	assert.equal(capture.streamState.lastSeq, 3);
	assert.equal(mapCaptureState(" stopped ", 10, 20), "stopped");
	assert.equal(mapCaptureState("unexpected", 21, 20), "expired");
	assert.equal(mapCaptureState(undefined, 10, 20), "active");

	const network = buildNetworkEntryEntity({ request: { url: "https://api.example.test/items", method: "POST" }, response: { status: "201" }, _bodyRef: "artifact://body", _requestId: "req-1", updatedAt: "1234" }, context);
	assert.equal(network.entity.name, "POST https://api.example.test/items");
	assert.deepEqual(network.entity.stream, { at: 1234, method: "POST", url: "https://api.example.test/items", status: 201, payloadHandle: "artifact://body" });
	assert.equal(network.descriptor.owner.topLevelOrigin, "https://api.example.test");
	assert.deepEqual(network.descriptor.snapshot, { observationId: "obs-1", resourceUri: "artifact://body", immutable: true });

	const fallbackNetwork = buildNetworkEntryEntity({ request: null, response: null, status: "not-a-number", id: "fallback" }, { observationId: "obs-2", capturedAt: 5, url: "notaurl" });
	assert.equal(fallbackNetwork.entity.name, "GET fallback");
	assert.equal(fallbackNetwork.descriptor.owner.topLevelOrigin, undefined);
	assert.equal(fallbackNetwork.entity.stream?.status, undefined);

	const event = buildEventEntity({ eventType: "dom-sink", phase: "after", handle: "artifact://event", message: "innerHTML assigned", timestamp: "42", originRef: "bp-ref://control/button" }, context);
	assert.equal(event.entity.value, "innerHTML assigned");
	assert.deepEqual(event.entity.stream, { at: 42, eventType: "dom-sink", phase: "after", payloadHandle: "artifact://event" });
	assert.equal(event.descriptor.semantic.value, "innerHTML assigned");
});

test("ABML collections and snapshot projection handle empty, repeated, and boundary-sized trees", () => {
	assert.deepEqual(buildSnapshotProjection([]), {
		summary: { templateCount: 0, instanceCount: 0, projectedInstanceRefCount: 0 },
		templates: [],
	});
	assert.deepEqual(buildCollectionModels({ entities: [] }), []);

	const rows = Array.from({ length: 25 }, (_, index) => entity(`bp-ref://row/${index}`, {
		kind: "element",
		role: "row",
		name: `Order ${index + 1}`,
		structure: { setSize: 100, posInSet: index + 1 },
		hints: { containerRole: "grid", containerName: "Orders" },
	}));
	const projection = buildSnapshotProjection(rows, {
		treeDiff: {
			summary: { changedTemplateCount: 1, appeared: 2, disappeared: 0, changed: 1, reordered: 1, partialBaseline: true },
			templates: [{
				templateKey: projectionKey("grid", "Orders", "row", 100),
				container: "grid",
				containerName: "Orders",
				role: "row",
				kind: "element",
				beforeCount: 23,
				afterCount: 25,
				appeared: { count: 2, instances: [{ ref: "bp-ref://row/23" }, { ref: "bp-ref://row/24" }] },
				disappeared: { count: 0, instances: [] },
				changed: { count: 1, instances: [{ ref: "bp-ref://row/1", fields: [{ field: "name", before: "Order 2", after: "Order 2 updated" }] }] },
				reordered: { count: 2, beforeSample: ["bp-ref://row/1", "bp-ref://row/2"], afterSample: ["bp-ref://row/2", "bp-ref://row/1"] },
			}],
		},
	});
	assert.equal(projection.summary.templateCount, 2);
	assert.equal(projection.summary.projectedInstanceRefCount, 20);
	assert.equal(projection.summary.partialBaseline, true);
	const projectedRows = projection.templates.find((template) => template.container === "grid" && template.containerName === "Orders" && template.count === 25)!;
	assert.equal(projectedRows.count, 25);
	assert.equal(projectedRows.instanceRefCount, 20);
	const deltaOnly = projection.templates.find((template) => template.deltaOnly)!;
	assert.equal(deltaOnly.delta?.appeared.count, 2);
	assert.equal(deltaOnly.delta?.changed.instances[0]?.fields[0]?.field, "name");

	const collections = buildCollectionModels({ entities: rows, snapshotProjection: projection, scanEvidence: { growthProbe: { beforeCount: 25, afterCount: 35, beforeScrollHeight: 1000, afterScrollHeight: 1400 } } });
	assert.equal(collections[0]!.kind, "table");
	assert.equal(collections[0]!.completeness, "virtualized");
	assert.equal(collections[0]!.declaredTotal, 100);
	assert.equal(collections[0]!.itemRefs.length, 20);
	assert.equal(collections[0]!.pageSize, 10);
	assert.equal(collections[0]!.scrollDirection, "vertical");
	assert.equal(collections[0]!.continuation?.kind, "virtual-window");
	assert.deepEqual(summarizeCollectionCompleteness(collections[0]!), { completeness: "virtualized", confidence: "high", reason: "observed 25 of declared 100" });
});

test("ABML collections absorb malformed scan evidence and pagination edges", () => {
	const models = buildCollectionModels({
		entities: [entity("bp-ref://list/container", { role: "list", kind: "region", name: "Results", hints: { listContainer: true, itemCount: "4", hiddenCount: "3" } })],
		scanEvidence: {
			listHints: [{ itemCount: "bad", hiddenCount: -1, selector: "  ", firstItemPreview: "  " }],
			actionables: [{ text: "Next page", ref: "bp-ref://control/next" }, { text: "Load more" }],
			growthProbe: { beforeCount: "bad", afterCount: 1, windowShifted: false },
		},
	});
	assert.equal(models.length, 1);
	assert.equal(models[0]!.containerRef, "bp-ref://list/container");
	assert.equal(models[0]!.hiddenCount, 3);
	assert.equal(models[0]!.completeness, "lazy");
	assert.equal(models[0]!.paginationControl?.kind, "next");
	assert.equal(models[0]!.paginationControl?.ref, "bp-ref://control/next");
});

test("ABML identity graph ignores malformed relations and summarizes duplicate node identities", () => {
	assert.deepEqual(identityGraphSummary(buildIdentityGraph([], undefined)), {
		entityCount: 0,
		backendNodeIdCount: 0,
		backendNodeIdCoverage: 0,
		anchorCount: 0,
		triggeredCount: 0,
		sourceCounts: {},
	});
	const graph = buildIdentityGraph([
		entity("bp-ref://control/save", {
			name: "Save",
			locators: [{ by: "backendNodeId", value: 10, targetId: "target-1" }],
			relations: [
				{ type: "triggered", targetRef: "bp-ref://network-entry/request-1", source: "timing", confidence: "low" },
				{ type: "triggered", targetRef: "", source: "timing", confidence: "low" },
				{ type: "controls", targetRef: "bp-ref://region/dialog", source: "ax", confidence: "high" },
			] as Entity["relations"],
		}),
		entity("bp-ref://control/save-copy", { name: "Save", locators: [{ by: "backendNodeId", value: 10, targetId: "target-1" }] }),
		entity("bp-ref://region/plain", { kind: "region", role: "region", source: "ax" }),
	]);
	assert.equal(graph.entityCount, 3);
	assert.equal(graph.backendNodeIdCount, 2);
	assert.equal(graph.triggeredCount, 2);
	assert.deepEqual(graph.byRef["bp-ref://control/save"]?.triggeredRequests, ["bp-ref://network-entry/request-1", ""]);
	assert.equal(graph.byRef["bp-ref://control/save"]?.nodeKey, "t:target-1:b:10");
	assert.equal(graph.byRef["bp-ref://control/save"]?.legacyNodeKey, "b:10");
	assert.equal(graph.byRef["bp-ref://region/plain"], undefined);
	assert.deepEqual(identityGraphSummary(graph), {
		entityCount: 3,
		backendNodeIdCount: 2,
		backendNodeIdCoverage: 0.667,
		anchorCount: 0,
		triggeredCount: 2,
		sourceCounts: { dom: 2, ax: 1 },
	});
});

function projectionKey(containerRole: string, containerName: string, itemRole: string, declaredTotal: number): string {
	return [undefined, containerRole, containerName, itemRole, `total:${declaredTotal}`, undefined].filter((item): item is string => !!item).join("\u0000");
}

test("capture template helpers escape inline JSON and fail closed for missing placeholders", () => {
	assert.equal(jsonForInlineScript(undefined), "null");
	assert.equal(jsonForInlineScript("<tag>&line\u2028next\u2029>"), '"\\u003Ctag\\u003E\\u0026line\\u2028next\\u2029\\u003E"');
	assert.equal(renderCaptureTemplate("const value = ${ value };", { value: 7 }), "const value = 7;");
	assert.equal(renderCaptureTemplate("no placeholders", {}), "no placeholders");
	assert.throws(() => renderCaptureTemplate("${missing}", {}), /capture template missing value: missing/);
});

test("scan script builder clamps options and injects scan helper blocks deterministically", () => {
	const original = process.env.BROWSER_PILOT_GROWTH_PROBE_WAIT_MS;
	try {
		delete process.env.BROWSER_PILOT_GROWTH_PROBE_WAIT_MS;
		const script = buildScanScript({ textOnly: true, maxChars: 1, maxNodes: Number.POSITIVE_INFINITY, includeIframes: false, probeWaitMs: 0 });
		assert.match(script, /const options = \{"textOnly":true,"maxChars":1000,"maxNodes":4000,"includeIframes":false\};/);
		assert.match(script, /const waitMs = 80;/);
		assert.match(script, /signals: \{ fingerprint: piScanFingerprint \}/);
		assert.match(script, /growthProbe,/);
		process.env.BROWSER_PILOT_GROWTH_PROBE_WAIT_MS = "125.9";
		assert.match(buildScanScript(), /const waitMs = 125;/);
		process.env.BROWSER_PILOT_GROWTH_PROBE_WAIT_MS = "bad";
		assert.match(buildScanScript({ probeWaitMs: 90.8 }), /const waitMs = 90;/);
	} finally {
		if (original === undefined) delete process.env.BROWSER_PILOT_GROWTH_PROBE_WAIT_MS;
		else process.env.BROWSER_PILOT_GROWTH_PROBE_WAIT_MS = original;
	}
});
