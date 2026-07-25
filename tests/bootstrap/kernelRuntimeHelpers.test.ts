import test from "node:test";
import assert from "node:assert/strict";
import type { Entity } from "../../src/kernels/abml/entity.ts";
import { buildActionableLocators, buildControlsSourceEntity, buildDomEntityFromScanActionable, buildReferencedTargetEntity, buildRegionEntityFromListHint, buildVisionRegionFromCanvasActionable, dedupeEntities } from "../../src/kernels/abml/entity.ts";
import { axBackendNodeId, axName, axNodeId, axRole, axValue, boxModelToGeometry, buildAxEntityFromNode, extractAxPropertyRelationAnchors, isInterestingAxNode, mergeDomAndAxEntities } from "../../src/kernels/abml/ax.ts";
import { addEntityRelations, buildRelationSummary, derivePaintOrderRelationAnchors, deriveStateRelationAnchors, materializeRelationGraph } from "../../src/kernels/abml/relations.ts";
import { buildInferenceSummary, entitiesForInferenceEvidence, inferenceEvidenceRefs } from "../../src/kernels/abml/inference.ts";
import type { EntityDiff } from "../../src/kernels/abml/diff.ts";
import { displayEntityText, groupEntities, isActionableOrStructural, isPureTextLeaf, normalizeEntityText, structureScopeKey, suppressNestedNonControlGroups, templateGroupDescriptorForEntity } from "../../src/kernels/abml/grouping.ts";
import { buildCollectionModels } from "../../src/kernels/abml/collections.ts";
import { firstSafeSemanticText, isItemLikePreview, safeContainerLabelText, sanitizeSemanticText } from "../../src/kernels/abml/semanticText.ts";
import { buildSnapshotProjection } from "../../src/kernels/abml/snapshotProjection.ts";
import { buildIdentityGraph, identityGraphSummary } from "../../src/kernels/abml/identityGraph.ts";
import { buildCausalEvents, buildCausalSummary, buildTriggeredRelations } from "../../src/kernels/abml/causal.ts";
import { jsonForInlineScript, renderCaptureTemplate } from "../../src/capture/inject.ts";
import { buildScanEntities } from "../../src/scan/summary.ts";
import { stableRefIdForDescriptor } from "../../src/kernels/refs/refId.ts";
import { deriveSemanticRefAnchors } from "../../src/kernels/abml/semanticRefAnchor.ts";
import type { BrowserBridgeExecutionResult, BrowserRuntimeCommand } from "../../src/ports/BrowserRuntimeTypes.ts";
import { invalidateAxRawCache, mergeAxIntoDomEntities, readAxEntities, readPartialAxTree } from "../../src/browser-runtime/abml/axRuntime.ts";
import { registerRefDescriptor, resolveRefUriDetailed } from "../../src/resources/resourceRefs.ts";
import { buildScanScript } from "../../src/scan/buildScanScript.ts";
import { scanPage } from "../../capture-src/entries/scanTemplate.ts";
import { pageWorldScanBundle } from "../helpers/pageWorldScan.ts";

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

type CdpCall = { method: string; params?: Record<string, unknown>; targetId?: string; timeoutMs?: number };

type MockCdpResponse = unknown | ((command: BrowserRuntimeCommand) => unknown);

function axNode(backendNodeId: number, role: string, name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		nodeId: `ax-${backendNodeId}`,
		backendDOMNodeId: backendNodeId,
		role: { type: "role", value: role },
		name: { type: "computedString", value: name },
		...overrides,
	};
}

function boxModel(x: number, y: number, w: number, h: number): Record<string, unknown> {
	return { border: [x, y, x + w, y, x + w, y + h, x, y + h] };
}

function domSnapshot(includePaintOrder = true): Record<string, unknown> {
	return {
		strings: ["id", "save", "class", "primary"],
		documents: [{
			nodes: { backendNodeId: [42, 77], attributes: [[0, 1, 2, 3], []] },
			layout: {
				nodeIndex: [0, 1],
				bounds: [[10, 20, 80, 30], [120, 20, 40, 30]],
				...(includePaintOrder ? { paintOrders: [2, 1] } : {}),
			},
		}],
	};
}

function createCdpServer(responses: Record<string, MockCdpResponse>) {
	const calls: CdpCall[] = [];
	return {
		calls,
		async sendCommand(command: BrowserRuntimeCommand): Promise<BrowserBridgeExecutionResult> {
			const method = typeof command.cdpMethod === "string" ? command.cdpMethod : "";
			calls.push({ method, params: command.params as Record<string, unknown> | undefined, ...(typeof command.targetId === "string" ? { targetId: command.targetId } : {}), timeoutMs: typeof command.timeoutMs === "number" ? command.timeoutMs : undefined });
			const response = responses[method];
			if (response instanceof Error) throw response;
			const data = await (typeof response === "function" ? response(command) : response);
			return { id: `mock-${calls.length}`, acknowledged: true, data };
		},
	};
}

function bridgeFailure(message: string, code = "BROWSER_COMMAND_FAILED"): Record<string, unknown> {
	return { ok: false, error: { code, message } };
}

test("partial AX helper returns bounded successful enrichment diagnostics", async () => {
	const server = createCdpServer({
		"Accessibility.getPartialAXTree": { nodes: [axNode(42, "button", "Save changes")] },
	});
	const result = await readPartialAxTree(server, { browserSessionId: "session-1", tabId: 7, targetId: "target-a", backendNodeId: 42, timeoutMs: 2_000, maxNodes: 5, fetchRelatives: false });
	assert.equal(result.nodes.length, 1);
	assert.equal(result.nodes[0]!.backendDOMNodeId, 42);
	assert.deepEqual(result.diagnostics, {
		provider: "partial-ax",
		status: "ok",
		backendNodeId: 42,
		targetId: "target-a",
		fetchRelatives: false,
		timeoutMs: 2_000,
		maxNodes: 5,
		cdpCalls: 1,
		nodeCount: 1,
		elapsedMs: result.diagnostics.elapsedMs,
	});
	assert.equal(server.calls[0]!.method, "Accessibility.getPartialAXTree");
	assert.equal(server.calls[0]!.targetId, "target-a");
	assert.deepEqual(server.calls[0]!.params, { backendNodeId: 42, fetchRelatives: false });
});

test("partial AX helper fails closed for missing backend, unsupported, error, timeout, and empty responses", async () => {
	const missing = await readPartialAxTree(createCdpServer({}), { tabId: 7, maxNodes: 5 });
	assert.equal(missing.diagnostics.status, "skipped");
	assert.equal(missing.diagnostics.reason, "missing-backendNodeId");
	assert.equal(missing.diagnostics.cdpCalls, 0);

	for (const [message, reason] of [["'Accessibility.getPartialAXTree' wasn't found", "unsupported"], ["CDP crashed", "error"], ["bridge timeout after 1500ms", "error"]] as const) {
		const server = createCdpServer({ "Accessibility.getPartialAXTree": bridgeFailure(message) });
		const result = await readPartialAxTree(server, { tabId: 7, backendNodeId: 42, timeoutMs: 1_500, maxNodes: 5 });
		assert.equal(result.nodes.length, 0);
		assert.equal(result.diagnostics.status, "failed");
		assert.equal(result.diagnostics.reason, reason);
		assert.match(result.diagnostics.error?.message ?? "", new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}

	const empty = await readPartialAxTree(createCdpServer({ "Accessibility.getPartialAXTree": { nodes: [] } }), { tabId: 7, backendNodeId: 42, maxNodes: 5 });
	assert.equal(empty.nodes.length, 0);
	assert.equal(empty.diagnostics.status, "degraded");
	assert.equal(empty.diagnostics.reason, "empty");
});

test("partial AX helper truncates over-budget nodes and reports degraded diagnostics", async () => {
	const nodes = Array.from({ length: 6 }, (_, index) => axNode(100 + index, "button", `Item ${index + 1}`));
	const result = await readPartialAxTree(createCdpServer({ "Accessibility.getPartialAXTree": { result: { nodes } } }), { tabId: 7, backendNodeId: 100, maxNodes: 3, fetchRelatives: true });
	assert.equal(result.nodes.length, 3);
	assert.deepEqual(result.nodes.map((node) => node.backendDOMNodeId), [100, 101, 102]);
	assert.equal(result.diagnostics.status, "degraded");
	assert.equal(result.diagnostics.reason, "over-budget");
	assert.equal(result.diagnostics.nodeCount, 6);
	assert.equal(result.diagnostics.maxNodes, 3);
	assert.equal(result.diagnostics.fetchRelatives, true);
});

test("full AX reader projects snapshot geometry, paint order, relations, and raw cache", async () => {
	const nodes = [
		axNode(42, "button", "Save changes", { properties: [{ name: "controls", value: { relatedNodes: [{ backendDOMNodeId: 77 }] } }] }),
		axNode(77, "region", "Details"),
	];
	const server = createCdpServer({
		"Accessibility.getFullAXTree": { nodes },
		"DOMSnapshot.captureSnapshot": domSnapshot(),
	});
	const options = { browserSessionId: "session-1", tabId: 7, observationId: "obs-full", capturedAt: 1_000, cacheKey: "full-ax-cache" };
	const first = await readAxEntities(server, options);
	assert.equal(first.entities.length, 2);
	assert.deepEqual(first.entities[0]?.entity.geometry?.box, { x: 10, y: 20, w: 80, h: 30 });
	assert.equal(first.anchors.some((anchor) => anchor.type === "controls" && anchor.targetKey === "b:77"), true);
	assert.deepEqual(first.snapshotGeometryEntries?.[0], { backendNodeId: 42, bounds: { x: 10, y: 20, w: 80, h: 30 }, attrs: { id: "save", class: "primary" } });
	assert.deepEqual(first.paintOrderEntries?.map((entry) => [entry.backendNodeId, entry.paintOrder]), [[42, 2], [77, 1]]);
	assert.equal(first.diagnostics?.cdpCalls, 2);
	assert.equal(first.diagnostics?.geometryCdpCalls, 0);
	assert.equal(first.diagnostics?.cacheHit, false);
	assert.equal(first.diagnostics?.snapshotDocumentCount, 1);
	assert.equal(first.diagnostics?.snapshotDocumentsSkipped, undefined);

	const cached = await readAxEntities(server, options);
	assert.equal(cached.diagnostics?.cacheHit, true);
	assert.equal(cached.diagnostics?.cdpCalls, 0);
	assert.equal(cached.diagnostics?.snapshotDocumentCount, 1);
	assert.equal(server.calls.length, 2);
	assert.equal(invalidateAxRawCache(options), true);
	const refreshed = await readAxEntities(server, options);
	assert.equal(refreshed.diagnostics?.cacheHit, false);
	assert.equal(server.calls.length, 4);
});

test("full AX reader redacts password values from AX-only entities and refs", async () => {
	const server = createCdpServer({
		"Accessibility.getFullAXTree": { nodes: [axNode(556, "textbox", "Password", { value: { type: "string", value: "secret" } })] },
		"DOMSnapshot.captureSnapshot": {
			strings: ["type", "password"],
			documents: [{ nodes: { backendNodeId: [556], attributes: [[0, 1]] }, layout: { nodeIndex: [], bounds: [] } }],
		},
	});
	const options = { tabId: 7, observationId: "obs-password", cacheKey: "password-cache" };
	const result = await readAxEntities(server, options);
	const built = result.entities[0]!;
	assert.equal(built.entity.value, undefined);
	assert.equal(built.entity.hints?.valueRedacted, true);
	assert.equal(built.descriptor.semantic?.value, undefined);

	const appended = mergeAxIntoDomEntities([], result.entities).entities[0]!;
	const resolved = resolveRefUriDetailed(appended.ref);
	assert.equal(resolved.ok ? resolved.ref.descriptor.semantic?.value : "missing", undefined);
	const cached = await readAxEntities(server, options);
	assert.equal(cached.entities[0]?.entity.value, undefined);
	assert.equal(cached.entities[0]?.entity.hints?.valueRedacted, true);
	assert.equal(cached.diagnostics?.cacheHit, true);
});

test("full AX reader consumes only the main DOMSnapshot document", async () => {
	const snapshot = domSnapshot();
	(snapshot.strings as unknown[]).push("type", "password");
	(snapshot.documents as Array<Record<string, unknown>>).push({
		nodes: { backendNodeId: [999], attributes: [[4, 5]] },
		layout: { nodeIndex: [0], bounds: [[900, 800, 50, 20]], paintOrders: [99] },
	});
	const server = createCdpServer({
		"Accessibility.getFullAXTree": { nodes: [axNode(42, "button", "Save"), axNode(999, "textbox", "Child password", { value: { type: "string", value: "secret" } })] },
		"DOMSnapshot.captureSnapshot": snapshot,
		"DOM.getBoxModel": { result: {} },
	});
	const options = { tabId: 7, observationId: "obs-multi-document", cacheKey: "multi-document-cache" };
	const result = await readAxEntities(server, options);

	assert.deepEqual(result.snapshotGeometryEntries?.map((entry) => entry.backendNodeId), [42, 77]);
	assert.deepEqual(result.paintOrderEntries?.map((entry) => entry.backendNodeId), [42, 77]);
	assert.equal(result.entities[1]?.entity.geometry, undefined);
	assert.equal(result.entities[1]?.entity.value, undefined);
	assert.equal(result.entities[1]?.entity.hints?.valueRedacted, true);
	assert.equal(result.diagnostics?.snapshotDocumentCount, 2);
	assert.equal(result.diagnostics?.snapshotDocumentsSkipped, 1);
	const cached = await readAxEntities(server, options);
	assert.equal(cached.diagnostics?.snapshotDocumentCount, 2);
	assert.equal(cached.diagnostics?.snapshotDocumentsSkipped, 1);
});

test("full AX reader keeps snapshot document geometry while projecting viewport state", async () => {
	const snapshot = domSnapshot();
	const document = (snapshot.documents as Array<Record<string, unknown>>)[0]!;
	(document.layout as Record<string, unknown>).bounds = [[10, 120, 80, 30], [120, 400, 40, 30]];
	const result = await readAxEntities(createCdpServer({
		"Accessibility.getFullAXTree": { nodes: [axNode(42, "button", "Visible"), axNode(77, "button", "Far")] },
		"DOMSnapshot.captureSnapshot": snapshot,
	}), { tabId: 7, observationId: "obs-scrolled", scrollY: 100, viewportWidth: 300, viewportHeight: 200 });
	assert.deepEqual(result.snapshotGeometryEntries?.map((entry) => entry.bounds.y), [120, 400]);
	assert.deepEqual(result.entities.map((item) => item.entity.geometry?.box?.y), [20, 300]);
	assert.deepEqual(result.entities.map((item) => item.entity.state.inViewport), [true, false]);
});

test("runtime fusion refreshes refs only from exact backend identity and redacts password values", () => {
	const context = { browserSessionId: "session-1", tabId: 7, observationId: "obs-ref-refresh", capturedAt: Date.now(), url: "https://example.test/" };
	const dom = buildDomEntityFromScanActionable({ tag: "button", selector: "#fusion", label: "DOM label", clickable: true, backendNodeId: 555, rect: { x: 0, y: 0, width: 100, height: 30 } }, context);
	const ref = registerRefDescriptor({ descriptor: dom.descriptor });
	const ax = buildAxEntityFromNode({ role: "button", name: "Accessible label", backendDOMNodeId: 555 }, context, { box: { x: 0, y: 0, w: 100, h: 30 } });
	const fused = mergeAxIntoDomEntities([{ ...dom.entity, ref }], [ax]).entities[0]!;
	const resolved = resolveRefUriDetailed(ref);
	assert.equal(fused.hints?.backendNodeId, 555);
	assert.equal(resolved.ok, true);
	if (!resolved.ok) return;
	assert.deepEqual(resolved.ref.descriptor.locators.slice(0, 2), [{ by: "backendNodeId", value: 555 }, { by: "css", value: "#fusion" }]);
	assert.equal(resolved.ref.descriptor.semantic?.name, "Accessible label");

	const passwordDom = buildDomEntityFromScanActionable({ tag: "input", role: "textbox", selector: "#password", label: "Password", editable: true, inputKind: "password", backendNodeId: 556, rect: { x: 0, y: 40, width: 100, height: 30 } }, context);
	const passwordRef = registerRefDescriptor({ descriptor: passwordDom.descriptor });
	const passwordAx = buildAxEntityFromNode({ role: "textbox", name: "Password", value: "secret", backendDOMNodeId: 556 }, context);
	const passwordFused = mergeAxIntoDomEntities([{ ...passwordDom.entity, ref: passwordRef }], [passwordAx]).entities[0]!;
	const passwordResolved = resolveRefUriDetailed(passwordRef);
	assert.equal(passwordFused.value, undefined);
	assert.equal(passwordResolved.ok ? passwordResolved.ref.descriptor.semantic?.value : "missing", undefined);
});

test("full AX reader preserves fragmented snapshot projection semantics", async () => {
	const server = createCdpServer({
		"Accessibility.getFullAXTree": { nodes: [axNode(42, "button", "Save changes")] },
		"DOMSnapshot.captureSnapshot": {
			strings: [],
			documents: [{
				nodes: { backendNodeId: [42], attributes: [[]] },
				layout: { nodeIndex: [0, 0], bounds: [[10, 20, 30, 10], [50, 20, 30, 10]], paintOrders: [1, 2] },
			}],
		},
	});
	const result = await readAxEntities(server, { tabId: 7, observationId: "obs-fragmented" });

	assert.deepEqual(result.entities[0]?.entity.geometry?.box, { x: 50, y: 20, w: 30, h: 10 });
	assert.deepEqual(result.snapshotGeometryEntries, [{ backendNodeId: 42, bounds: { x: 10, y: 20, w: 30, h: 10 } }]);
	assert.deepEqual(result.paintOrderEntries, [{ backendNodeId: 42, paintOrder: 1, bounds: { x: 10, y: 20, w: 30, h: 10 } }]);
});

test("full AX reader degrades from paint snapshot and falls back to bounded box geometry", async () => {
	let snapshotCalls = 0;
	const paintFallbackServer = createCdpServer({
		"Accessibility.getFullAXTree": { result: { nodes: [axNode(42, "button", "Save changes")] } },
		"DOMSnapshot.captureSnapshot": () => ++snapshotCalls === 1 ? bridgeFailure("includePaintOrder unsupported") : domSnapshot(false),
	});
	const paintFallback = await readAxEntities(paintFallbackServer, { tabId: 7, observationId: "obs-paint-fallback" });
	assert.equal(paintFallback.diagnostics?.paintOrder?.snapshotUnsupported, true);
	assert.equal(paintFallback.diagnostics?.paintOrder?.geometryFallbackUsed, true);
	assert.equal(paintFallback.diagnostics?.snapshotGeometryUnavailable, undefined);
	assert.equal(paintFallback.diagnostics?.cdpCalls, 3);
	assert.equal(paintFallback.diagnostics?.geometryCdpCalls, 0);

	const boxFallbackServer = createCdpServer({
		"Accessibility.getFullAXTree": { nodes: [axNode(42, "button", "Save changes")] },
		"DOMSnapshot.captureSnapshot": bridgeFailure("snapshot unavailable"),
		"DOM.getBoxModel": { result: boxModel(5, 6, 70, 20) },
	});
	const boxFallback = await readAxEntities(boxFallbackServer, { tabId: 7, observationId: "obs-box-fallback", scrollY: 100 });
	assert.deepEqual(boxFallback.entities[0]?.entity.geometry?.box, { x: 5, y: 6, w: 70, h: 20 });
	assert.equal(boxFallback.diagnostics?.snapshotGeometryUnavailable, true);
	assert.equal(boxFallback.diagnostics?.cdpCalls, 4);
	assert.equal(boxFallback.diagnostics?.geometryCdpCalls, 1);
});

test("full AX reader bounds concurrent box geometry fallback", async () => {
	let active = 0;
	let maxActive = 0;
	const nodes = Array.from({ length: 12 }, (_, index) => axNode(index + 1, "button", `Action ${index + 1}`));
	const server = createCdpServer({
		"Accessibility.getFullAXTree": { nodes },
		"DOMSnapshot.captureSnapshot": bridgeFailure("snapshot unavailable"),
		"DOM.getBoxModel": async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise<void>((resolve) => setImmediate(resolve));
			active -= 1;
			return { result: boxModel(0, 0, 10, 10) };
		},
	});
	const result = await readAxEntities(server, { tabId: 7, observationId: "obs-bounded-box-fallback" });
	assert.equal(result.diagnostics?.geometryCdpCalls, 12);
	assert.equal(maxActive, 4);
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
	const duplicateEntities = [
		...Array.from({ length: 4 }, (_, index) => entity(`bp-ref://a/${index}`, { role: "listitem", kind: "element", name: index ? `A${index}` : "Approve", hints: { containerRole: "list", containerName: "Results", containerKey: "b:1" } })),
		...Array.from({ length: 4 }, (_, index) => entity(`bp-ref://b/${index}`, { role: "listitem", kind: "element", name: index ? `B${index}` : "Approve", hints: { containerRole: "list", containerName: "Results", containerKey: "b:2" } })),
	];
	const duplicateContainers = groupEntities(duplicateEntities);
	assert.equal(duplicateContainers.length, 2);
	assert.equal(buildCollectionModels({ entities: duplicateEntities, snapshotProjection: buildSnapshotProjection(duplicateEntities) }).length, 2);
	const anchors = deriveSemanticRefAnchors(duplicateEntities);
	assert.deepEqual(anchors.anchors
		.filter((item) => item.anchor.normalizedName === "approve")
		.map((item) => [item.anchor.confidence, item.anchor.reason, item.anchor.mintingEligible]), [
		["low", "duplicate-container", false],
		["low", "duplicate-container", false],
	]);
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

test("ABML causal projection preserves complete redacted deltas", () => {
	const records = Array.from({ length: 15 }, (_, index) => ({ seq: index + 1, requestId: `request-${index}`, request: { method: "GET", url: `https://example.test/${"x".repeat(300)}?index=${index}` }, initiator: { type: "script" } }));
	const causal = buildCausalSummary(records, 0);
	assert.equal("requests" in causal && causal.requests.length, 15);
	assert.ok("requests" in causal && causal.requests[0]!.url!.length > 200);
	assert.equal(buildTriggeredRelations(causal).length, 15);
	const timed = buildCausalSummary([{ seq: 1, requestId: "timed", createdAt: 10, updatedAt: 30 }], 0);
	assert.equal("requests" in timed && timed.requests[0]?.at, 10);
	const actionScoped = buildTriggeredRelations({ sinceSeq: 0, requests: [
		{ ref: "bp-ref://network/before", at: 10, initiatorType: "script" },
		{ ref: "bp-ref://network/unknown", initiatorType: "script" },
		{ ref: "bp-ref://network/after", at: 30, initiatorType: "script" },
	] }, { hasActionRef: true, actionAt: 20 });
	assert.deepEqual(actionScoped.map((relation) => [relation.targetRef, relation.confidence]), [["bp-ref://network/after", "medium"]]);
	const events = buildCausalEvents(records.map((record) => ({ ...record, type: "console", data: { message: "x".repeat(300) } })), 0);
	assert.equal(events.events.length, 15);
	assert.equal(events.events[0]!.summary?.length, 300);
});

test("ABML semantic text rejects unsafe names and item-like previews for container labels", () => {
	const pricingCard = "Kimi K2 Turbo model billing per 1M tokens input $0.60 output $2.50 cache write $0.15 cache read $0.05 context 128k";
	assert.equal(isItemLikePreview(pricingCard), true);
	assert.equal(isItemLikePreview("API price: $0.60, output: $2.50, cache: $0.05"), true);
	assert.equal(isItemLikePreview("个人中心"), false);
	assert.equal(isItemLikePreview("全部供应商 30"), false);
	assert.equal(isItemLikePreview("All latest topics"), false);
	assert.equal(safeContainerLabelText(pricingCard), undefined);
	assert.equal(safeContainerLabelText("个人中心"), "个人中心");
	assert.equal(safeContainerLabelText("全部供应商 30"), "全部供应商 30");
	assert.equal(safeContainerLabelText("All latest topics"), "All latest topics");
	assert.equal(firstSafeSemanticText(["<svg><path d=\"M0 0\" /></svg>", "Safe label"]), "Safe label");
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
			summary: { templateCount: 1, changedTemplateCount: 1, appeared: 2, disappeared: 0, changed: 1, reordered: 1, partialBaseline: true },
			templates: [{
				templateKey: projectionKey("grid", "Orders", "row", 100),
				container: "grid",
				containerName: "Orders",
				role: "row",
				kind: "element",
				beforeCount: 23,
				afterCount: 25,
				appeared: { count: 2, instances: [
					{ key: "name:Order 24", ref: "bp-ref://row/23", anchor: "name", confidence: "high", name: "Order 24" },
					{ key: "name:Order 25", ref: "bp-ref://row/24", anchor: "name", confidence: "high", name: "Order 25" },
				] },
				disappeared: { count: 0, instances: [] },
				changed: { count: 1, instances: [{ key: "name:Order 2", beforeRef: "bp-ref://row/1", afterRef: "bp-ref://row/1", anchor: "name", confidence: "high", name: "Order 2", fieldCount: 1, fields: [{ field: "name", before: "Order 2", after: "Order 2 updated" }] }] },
				reordered: { changed: true, commonCount: 2, beforeSample: ["bp-ref://row/1", "bp-ref://row/2"], afterSample: ["bp-ref://row/2", "bp-ref://row/1"] },
			}],
		},
	});
	assert.equal(projection.summary.templateCount, 2);
	assert.equal(projection.summary.projectedInstanceRefCount, 25);
	assert.equal(projection.summary.partialBaseline, true);
	const projectedRows = projection.templates.find((template) => template.container === "grid" && template.containerName === "Orders" && template.count === 25)!;
	assert.equal(projectedRows.count, 25);
	assert.equal(projectedRows.instanceRefCount, 25);
	const deltaOnly = projection.templates.find((template) => template.deltaOnly)!;
	assert.equal(deltaOnly.delta?.appeared.count, 2);
	assert.equal(deltaOnly.delta?.changed.instances[0]?.fields[0]?.field, "name");

	const collections = buildCollectionModels({ entities: rows, snapshotProjection: projection });
	assert.equal(collections[0]!.kind, "table");
	assert.equal(collections[0]!.completeness, "virtualized");
	assert.equal(collections[0]!.declaredTotal, 100);
	assert.equal(collections[0]!.itemRefs.length, 25);
	assert.equal(buildCollectionModels({ entities: rows, snapshotProjection: buildSnapshotProjection(rows) }).length, 1);

	const duplicatedPositions = Array.from({ length: 24 }, (_, index) => entity(`bp-ref://fragment/${index}`, {
		role: "div",
		structure: { setSize: 12, posInSet: index % 12 + 1 },
		hints: { containerRole: "list", containerKey: "feed" },
	}));
	const positionalCollection = buildCollectionModels({ entities: duplicatedPositions, snapshotProjection: buildSnapshotProjection(duplicatedPositions) })[0]!;
	assert.equal(positionalCollection.observedCount, 12);
	assert.equal(positionalCollection.itemRefCount, 12);
	assert.equal(positionalCollection.itemRefs.length, 12);
	assert.equal(positionalCollection.declaredTotal, 12);
	assert.equal(positionalCollection.completeness, "complete");
});

test("ABML collections absorb malformed scan evidence and pagination edges", () => {
	const models = buildCollectionModels({
		entities: [entity("bp-ref://list/container", { role: "list", kind: "region", name: "Results", hints: { listContainer: true, itemCount: "4" as unknown as number } })],
		scanEvidence: {
			listHints: [{ itemCount: "bad", selector: "  ", firstItemPreview: "  " }],
			actionables: [{ text: "Next page", ref: "bp-ref://control/next" }, { text: "Load more" }],
		},
	});
	assert.equal(models.length, 1);
	assert.equal(models[0]!.containerRef, "bp-ref://list/container");
	assert.equal(models[0]!.estimatedTotal, undefined);
	assert.equal(models[0]!.completeness, "paginated");
	assert.equal(models[0]!.paginationControl?.kind, "next");
	assert.equal(models[0]!.paginationControl?.ref, "bp-ref://control/next");
	const independent = buildCollectionModels({
		entities: [],
		scanEvidence: {
			listHints: [
				{ itemCount: 2, selector: "#a > li", firstItemPreview: "A" },
				{ itemCount: 3, selector: "#b > li", firstItemPreview: "B" },
			],
			actionables: [{ text: "Next page", ref: "bp-ref://control/next" }],
		},
	});
	assert.deepEqual(independent.map((item) => item.paginationControl), [undefined, undefined]);
	const labelled = buildCollectionModels({
		entities: [],
		scanEvidence: { listHints: [{ itemCount: 6, containerLabel: "Orders", selector: "#orders > li", firstItemPreview: "<svg><path d=\"M0 0\" /></svg>" }] },
	});
	assert.equal(labelled[0]!.containerName, "Orders");
	assert.equal(labelled[0]!.estimatedTotal, undefined);
	assert.equal(labelled[0]!.completeness, "viewport-window");
	assert.equal(labelled[0]!.evidence[0]!.summary, "scan list hint");
	const fallback = buildCollectionModels({
		entities: [],
		scanEvidence: { listHints: [{ itemCount: 6, firstItemPreview: "<path d=\"M0 0\" />" }] },
	});
	assert.equal(fallback[0]!.containerName, "list-0");
	const pricingPreview = "Kimi K2 Turbo model billing per 1M tokens input $0.60 output $2.50 cache write $0.15 cache read $0.05 context 128k";
	const pricing = buildCollectionModels({
		entities: [],
		scanEvidence: { listHints: [{ itemCount: 8, firstItemPreview: pricingPreview }] },
	});
	assert.equal(pricing[0]!.containerName, "list-0");
	assert.equal(pricing[0]!.evidence[0]!.summary.includes("Kimi K2 Turbo"), true);
	assert.equal(buildRegionEntityFromListHint({ selector: "#pricing", firstItemPreview: pricingPreview }, { observationId: "obs-list", capturedAt: 1 }, 1).entity.name, "list-1");
	assert.equal(buildRegionEntityFromListHint({ selector: "#providers", firstItemPreview: "全部供应商 30" }, { observationId: "obs-list", capturedAt: 1 }, 3).entity.name, "全部供应商 30");
	assert.equal(buildRegionEntityFromListHint({ selector: "#icons", firstItemPreview: "<path d=\"M0 0\" />" }, { observationId: "obs-list", capturedAt: 1 }, 2).entity.name, "list-2");
	assert.equal(buildRegionEntityFromListHint({ selector: "#icons", containerLabel: "Toolbar", firstItemPreview: "<path d=\"M0 0\" />" }, { observationId: "obs-list", capturedAt: 1 }, 2).entity.name, "Toolbar");
	const duplicateCollections = buildCollectionModels({
		entities: [],
		scanEvidence: {
			listHints: [
				{ itemCount: 3, containerLabel: "Cards", selector: "#featured-cards > li", firstItemPreview: "Alpha" },
				{ itemCount: 4, containerLabel: "Cards", selector: "#archived-cards > li", firstItemPreview: "Beta" },
			],
		},
	});
	assert.deepEqual(duplicateCollections.map((collection) => collection.containerName), ["Cards (archived cards)", "Cards (featured cards)"]);
	assert.deepEqual(duplicateCollections.map((collection) => collection.containerNameSource), ["disambiguated", "disambiguated"]);
	const duplicateListRegions = buildScanEntities(pageWorldScanBundle({ structure: { listHints: [
		{ itemCount: 2, containerLabel: "Cards", selector: "#featured-cards > li", firstItemPreview: "Alpha" },
		{ itemCount: 2, containerLabel: "Cards", selector: "#archived-cards > li", firstItemPreview: "Beta" },
	] } }), { entityContext: { observationId: "obs-dup", capturedAt: 10 } }).listEntities;
	assert.deepEqual(duplicateListRegions.map((region) => region.name), ["Cards (featured cards)", "Cards (archived cards)"]);
	const duplicateSelectorActions = buildScanEntities(pageWorldScanBundle({ structure: { actionables: [
		{ index: 0, selector: ".item", tag: "span", clickable: true, actionConfidence: "medium", point: { x: 10, y: 10 }, entityRefs: { domAction: "bp-ref://element/item-1" } },
		{ index: 1, selector: ".item", tag: "span", clickable: true, actionConfidence: "medium", point: { x: 20, y: 20 }, entityRefs: { domAction: "bp-ref://element/item-2" } },
	] } }), { entityContext: { observationId: "obs-actions", capturedAt: 10 } }).entities;
	assert.equal(duplicateSelectorActions.length, 2);
	assert.equal(new Set(duplicateSelectorActions.map((item) => item.ref)).size, 2);
	const unsafeDuplicate = buildCollectionModels({
		entities: [],
		scanEvidence: { listHints: [
			{ itemCount: 1, containerLabel: "Cards", selector: "svg > path", firstItemPreview: "Alpha" },
			{ itemCount: 1, containerLabel: "Cards", selector: "svg > path", firstItemPreview: "Beta" },
		] },
	});
	assert.deepEqual(unsafeDuplicate.map((collection) => collection.containerName), ["Cards (1)", "Cards (2)"]);
	assert.deepEqual(unsafeDuplicate.map((collection) => collection.containerNameSource), ["disambiguated", "disambiguated"]);
	const observeDuplicateCollections = buildCollectionModels({
		entities: [],
		scanEvidence: { listHints: [
			{ itemCount: 1, containerLabel: "筛选", selector: "div > div.flex", firstItemPreview: "Alpha" },
			{ itemCount: 2, containerLabel: "筛选", selector: "section > div.flex", firstItemPreview: "Beta" },
		] },
	});
	assert.deepEqual(observeDuplicateCollections.map((collection) => collection.containerName), ["筛选 (flex) (1)", "筛选 (flex) (2)"]);
	assert.equal(new Set(observeDuplicateCollections.map((collection) => collection.containerName)).size, observeDuplicateCollections.length);
	assert.deepEqual(observeDuplicateCollections.map((collection) => collection.containerNameSource), ["disambiguated", "disambiguated"]);
});

test("ABML identity graph ignores malformed relations and summarizes duplicate node identities", () => {
	assert.deepEqual(identityGraphSummary(buildIdentityGraph([])), {
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

test("ABML entity builders handle malformed inputs, fallback roles, refs, and dedupe keys", () => {
	const context = { observationId: "obs-entity", capturedAt: 2_000, url: "notaurl", browserSessionId: "session-1", tabId: 3, targetId: "target-1" };
	assert.deepEqual(buildActionableLocators({ backendNodeId: "7", selector: " #save ", action: " Save ", role: "button", point: { x: 10.4, y: 20.6 } }), [
		{ by: "backendNodeId", value: 7 },
		{ by: "css", value: "#save" },
		{ by: "textAnchor", value: "Save", role: "button", exact: false },
		{ by: "point", x: 10, y: 21 },
	]);
	assert.deepEqual(buildActionableLocators({ backendNodeId: 0, selector: " ", point: { x: "bad" } }), []);
	const action = buildDomEntityFromScanActionable({ tag: "a", index: "2", text: "Open", value: "href", rect: { x: 1.2, y: 2.8, width: 10.2, height: 20.1 }, current: "page", hitOk: false, occluderSelector: "#modal", controlsSelectors: ["#panel", "", 1], ownsSelectors: ["#owned"], expandedTargetSelectors: ["#expanded"], backendNodeIdBootstrap: { from: "snapshot" }, inputKind: "search" }, context);
	assert.equal(action.entity.kind, "control");
	assert.equal(action.entity.role, "link");
	assert.equal(action.entity.state.current, "page");
	assert.equal(action.entity.state.occluded, true);
	assert.equal(action.entity.hints?.occluderSelector, "#modal");
	assert.deepEqual(action.entity.hints?.controlsSelectors, ["#panel"]);
	assert.equal(action.descriptor.owner.topLevelOrigin, undefined);
	const editable = buildDomEntityFromScanActionable({ tag: "input", editable: true, current: "false", value: "secret", point: { x: 3, y: 4 } }, { ...context, url: "https://example.test/form" });
	assert.equal(editable.entity.value, undefined);
	assert.equal(editable.entity.state.current, undefined);
	assert.equal(editable.descriptor.owner.topLevelOrigin, "https://example.test");
	const scopedLike = buildDomEntityFromScanActionable({ tag: "span", clickable: true, action: "Like", actionConfidence: "high", label: "380", hitOk: true, scope: { key: "#feed > article", name: "Feed", position: 1, size: 20 } }, context);
	assert.equal(scopedLike.entity.kind, "element");
	assert.equal(scopedLike.entity.role, "span");
	assert.deepEqual(scopedLike.entity.actionability, { actions: ["click"], hint: "Like", confidence: "high" });
	assert.deepEqual(scopedLike.entity.scope, { key: "#feed > article", name: "Feed", position: 1, size: 20 });
	assert.equal(scopedLike.entity.structure, undefined);
	assert.equal(scopedLike.entity.hints?.containerKey, undefined);
	const list = buildRegionEntityFromListHint({ selector: "#items", firstItemPreview: " First " }, context, 4);
	assert.equal(list.entity.name, "First");
	assert.equal(buildRegionEntityFromListHint({}, context, 8).entity.name, "list-8");
	assert.equal(sanitizeSemanticText("<path d=\"M10 10 L20 20\"></path>"), undefined);
	assert.equal(firstSafeSemanticText(["<svg><path d=\"M0 0\" /></svg>", "Upload file"]), "Upload file");
	const noisy = buildDomEntityFromScanActionable({ tag: "button", role: "button", action: "<path d=\"M0 0 L1 1\" />", label: "", text: "", displayLabel: "Open menu" }, context);
	assert.equal(noisy.entity.name, "Open menu");
	assert.deepEqual(noisy.entity.locators?.filter((locator) => locator.by === "textAnchor"), [{ by: "textAnchor", value: "Open menu", role: "button", exact: false }]);
	assert.equal(noisy.descriptor.semantic?.name, "Open menu");
	const unnamedIcon = buildDomEntityFromScanActionable({ tag: "button", role: "button", action: "<svg><path d=\"M0 0\" /></svg>", label: "", text: "" }, context);
	assert.equal(unnamedIcon.entity.name, undefined);
	assert.deepEqual(unnamedIcon.entity.locators, []);
	const editableWithSecret = buildDomEntityFromScanActionable({ tag: "input", editable: true, label: "Search", value: "private query" }, context);
	assert.equal(editableWithSecret.entity.name, "Search");
	assert.equal(editableWithSecret.entity.value, undefined);
	assert.equal(buildControlsSourceEntity({ sourceSelector: "#tabs", sourceRole: "tablist", sourceName: "Tabs", controlsSelectors: ["#panel"] }, context).entity.kind, "element");
	assert.equal(buildControlsSourceEntity({ sourceRole: "heading" }, context).entity.kind, "text");
	const target = buildReferencedTargetEntity({ selector: "#dialog", role: "dialog", hidden: true }, context);
	assert.equal(target.entity.kind, "region");
	assert.equal(target.entity.state.visible, false);
	const vision = buildVisionRegionFromCanvasActionable({ rect: { x: 0, y: 0, w: 20, h: 10 }, hitOk: false }, context);
	assert.deepEqual(vision.entity.locators, [{ by: "point", x: 10, y: 5 }]);
	assert.equal(vision.entity.state.occluded, true);
	const deduped = dedupeEntities([
		{ kind: "control", hints: { selector: "#same", jsonPath: "a" } },
		{ kind: "control", hints: { selector: "#same", jsonPath: "b" } },
		{ kind: "region", hints: { jsonPath: "r1", listContainer: true }, locators: [{ by: "css", value: "#list" }] },
		{ kind: "region", hints: { jsonPath: "r2", listContainer: true }, locators: [{ by: "css", value: "#list" }] },
	]);
	assert.equal(deduped.length, 2);
});

test("ABML query priority oracle prefers user-facing semantics over selector-like and generated candidates", () => {
	const context = { observationId: "obs-query-priority", capturedAt: 2_000, url: "https://example.test/settings", browserSessionId: "session-1", tabId: 3, targetId: "target-1" };
	const frameworkClass = "css-1abc23 mui-generated hash_9z9z9z";
	const longPreview = `${"Verbose marketing copy ".repeat(20)}Submit order`;
	const button = buildDomEntityFromScanActionable({
		tag: "button",
		role: "button",
		selector: `button.${frameworkClass.replace(/\s+/g, ".")}`,
		action: "button.css-1abc23 > svg > path",
		label: "Submit order",
		displayLabel: longPreview,
		text: "<svg><path d=\"M10 10 L20 20\" /></svg>",
		backendNodeId: 42,
		point: { x: 10, y: 20 },
	}, context);
	assert.equal(button.entity.role, "button");
	assert.equal(button.entity.name, "Submit order");
	assert.deepEqual(button.entity.locators?.filter((locator) => locator.by === "textAnchor"), [{ by: "textAnchor", value: "Submit order", role: "button", exact: false }]);
	assert.equal(button.entity.locators?.some((locator) => locator.by === "textAnchor" && locator.value === longPreview), false);
	assert.equal(button.entity.locators?.some((locator) => locator.by === "textAnchor" && String(locator.value).includes("css-1abc23")), false);
	assert.equal(button.entity.locators?.some((locator) => locator.by === "textAnchor" && String(locator.value).includes("<svg")), false);
	assert.equal(button.descriptor.semantic?.name, "Submit order");
	assert.equal(JSON.stringify(button.descriptor.semantic).includes("css-1abc23"), false);
	assert.equal(JSON.stringify(button.descriptor.semantic).includes("Verbose marketing copy"), false);
	assert.equal(JSON.stringify(button.descriptor.semantic).includes("<svg"), false);

	const labelledList = buildRegionEntityFromListHint({
		selector: ".css-1abc23.generated-list > li:nth-child(1)",
		containerLabel: "Invoices",
		firstItemPreview: "Invoice #1234 Total $99.00 Due tomorrow Owner Finance Department Status Pending Region West",
	}, context, 0);
	assert.equal(labelledList.entity.name, "Invoices");
	assert.equal(labelledList.entity.hints?.containerNameSource, "safe-label");
	assert.deepEqual(labelledList.entity.locators?.filter((locator) => locator.by === "textAnchor"), [{ by: "textAnchor", value: "Invoice #1234 Total $99.00 Due tomorrow Owner Finance Department Status Pending Region West", role: "list", exact: false }]);
	assert.equal(labelledList.descriptor.semantic?.name, "Invoices");

	assert.equal(sanitizeSemanticText("button.css-1abc23 > svg > path"), undefined);
	assert.equal(sanitizeSemanticText("<svg><path d=\"M0 0\" /></svg>"), undefined);
	assert.equal(firstSafeSemanticText(["button.css-1abc23 > svg > path", "<svg><path d=\"M0 0\" /></svg>", "Open settings"]), "Open settings");
});

test("ABML ref stability oracle ignores runtime locators when concise semantic anchors are available", () => {
	const base = {
		kind: "control" as const,
		owner: { browserSessionId: "session-1", tabId: 3, topLevelOrigin: "https://example.test" },
		documentEpoch: { targetGeneration: 1, pageEpoch: "page-1", url: "https://example.test/settings" },
		semantic: { role: "button", name: "Submit order" },
	};
	const anchoredSemantic = { role: "button", name: "Submit order", anchor: { scope: "abml-template" as const, confidence: "high" as const, mintingEligible: true, containerRole: "form", containerName: "Checkout", role: "button", kind: "control", normalizedName: "submit order" } };
	const first = stableRefIdForDescriptor({
		...base,
		semantic: anchoredSemantic,
		locators: [
			{ by: "css" as const, value: ".css-1abc23 > button:nth-child(2)" },
			{ by: "backendNodeId" as const, value: 101 },
			{ by: "textAnchor" as const, value: "Submit order", role: "button", exact: false },
		],
	});
	const second = stableRefIdForDescriptor({
		...base,
		semantic: anchoredSemantic,
		locators: [
			{ by: "css" as const, value: ".css-9xyz88 > button:nth-child(4)" },
			{ by: "backendNodeId" as const, value: 202 },
			{ by: "textAnchor" as const, value: "Submit order", role: "button", exact: false },
		],
	});
	assert.equal(first, second);
	assert.equal(typeof first, "string");
	assert.equal(first!.includes("css-"), false);
	assert.equal(first!.includes("nth-child"), false);
	assert.equal(first!.includes("101"), false);
	assert.equal(first!.includes("202"), false);
	assert.notEqual(first, stableRefIdForDescriptor({ ...base, owner: { ...base.owner, browserSessionId: "session-2" }, semantic: anchoredSemantic, locators: [] }));
	assert.notEqual(first, stableRefIdForDescriptor({ ...base, documentEpoch: { ...base.documentEpoch, pageEpoch: "page-2" }, semantic: anchoredSemantic, locators: [] }));

	const semanticAnchor = {
		kind: "control" as const,
		owner: { tabId: 3, topLevelOrigin: "https://example.test" },
		documentEpoch: { url: "https://example.test/settings" },
		locators: [
			{ by: "css" as const, value: ".css-generated-a" },
			{ by: "backendNodeId" as const, value: 11 },
		],
		semantic: {
			role: "button",
			name: "Approve",
			anchor: {
				scope: "abml-template",
				confidence: "high",
				mintingEligible: true,
				containerRole: "list",
				containerName: "Invoices",
				role: "button",
				kind: "control",
				normalizedName: "approve",
			},
		},
	};
	const anchoredFirst = stableRefIdForDescriptor(semanticAnchor);
	const anchoredSecond = stableRefIdForDescriptor({
		...semanticAnchor,
		locators: [
			{ by: "css" as const, value: ".css-generated-b" },
			{ by: "backendNodeId" as const, value: 22 },
		],
	});
	assert.equal(anchoredFirst, anchoredSecond);
	assert.match(anchoredFirst ?? "", /^bp-ref:\/\/control\/[A-Za-z0-9._~:@/-]+$/);
});

test("ABML AX helpers cover malformed nodes, structure properties, relation anchors, and merge ambiguity", () => {
	const node = {
		role: { value: "checkbox" },
		name: { value: "Enable" },
		value: { value: "on" },
		nodeId: "ax-1",
		backendDOMNodeId: "11",
		properties: [
			{ name: "checked", value: { value: "true" } },
			{ name: "disabled", value: true },
			{ name: "focused", value: { value: false } },
			{ name: "level", value: { value: "2" } },
			{ name: "setsize", value: { value: 4 } },
			{ name: "posinset", value: { value: 1 } },
			{ name: "sort", value: { value: "ascending" } },
			{ name: "controls", value: { relatedNodes: [{ backendDOMNodeId: 22 }, { backendNodeId: "23" }, {}] } },
			{ name: "expanded", value: { value: "false" } },
		],
	};
	assert.equal(axRole(node), "checkbox");
	assert.equal(axName(node), "Enable");
	assert.equal(axValue(node), "on");
	assert.equal(axNodeId(node), "ax-1");
	assert.equal(axBackendNodeId(node), 11);
	assert.equal(isInterestingAxNode({ role: { value: "generic" }, name: "" }), false);
	assert.equal(isInterestingAxNode({ ignored: true, role: "button", name: "Save" }), false);
	assert.equal(isInterestingAxNode({ role: "generic", backendDOMNodeId: 44, value: "fallback" }), true);
	assert.equal(boxModelToGeometry({ border: [0, 0, 10, 0, 10, 20, 0, 20] })?.point?.y, 10);
	assert.equal(boxModelToGeometry({ border: [0, Number.NaN] }), undefined);
	assert.deepEqual(extractAxPropertyRelationAnchors(node), [
		{ type: "controls", targetKey: "b:22" },
		{ type: "controls", targetKey: "b:23" },
		{ type: "expandedTarget", targetKey: "b:22" },
		{ type: "expandedTarget", targetKey: "b:23" },
	]);
	const built = buildAxEntityFromNode(node, { observationId: "obs-ax", capturedAt: 10, url: "https://example.test/page", tabId: 2 }, { box: { x: 0, y: 0, w: 10, h: 20 }, point: { x: 5, y: 10 } });
	assert.equal(built.entity.kind, "control");
	assert.equal(built.entity.state.checked, true);
	assert.equal(built.entity.state.disabled, true);
	assert.equal(built.entity.state.focused, false);
	assert.equal(built.entity.state.expanded, false);
	assert.equal(built.entity.structure?.level, 2);
	assert.equal(built.entity.structure?.setSize, 4);
	assert.equal(built.entity.structure?.posInSet, 1);
	assert.equal(built.entity.structure?.sort, "ascending");
	assert.deepEqual(built.entity.actionability, { actions: ["click"], confidence: "medium" });
	assert.equal(built.descriptor.owner.topLevelOrigin, "https://example.test");
	const dom = [entity("bp-ref://dom/1", { role: "button", name: "Save", geometry: { point: { x: 100, y: 100 } } }), entity("bp-ref://dom/2", { role: "button", name: "Save", geometry: { point: { x: 101, y: 101 } } })];
	const ambiguousAx = buildAxEntityFromNode({ role: "button", name: "Save" }, { observationId: "obs-ax", capturedAt: 10 });
	const ambiguousSemanticMerge = mergeDomAndAxEntities(dom, [ambiguousAx]);
	assert.equal(ambiguousSemanticMerge.unmatchedAx.length, 1);
	assert.deepEqual(ambiguousSemanticMerge.diagnostics.skipped, { ambiguousBackend: 0, ambiguousGeometry: 0, ambiguousSemantic: 1, targetScopeMismatch: 0, unsafeSemantic: 0 });
	assert.equal(ambiguousSemanticMerge.diagnostics.degraded, true);
	const ambiguousBackendMerge = mergeDomAndAxEntities([
		entity("bp-ref://dom/backend-a", { locators: [{ by: "backendNodeId", value: 88 }] }),
		entity("bp-ref://dom/backend-b", { locators: [{ by: "backendNodeId", value: 88 }] }),
	], [buildAxEntityFromNode({ role: "button", name: "Save", backendDOMNodeId: 88 }, { observationId: "obs-ax", capturedAt: 10 })]);
	assert.equal(ambiguousBackendMerge.diagnostics.skipped.ambiguousBackend, 1);
	assert.equal(ambiguousBackendMerge.diagnostics.axOnly, 1);
	assert.equal(ambiguousBackendMerge.diagnostics.degraded, true);
	const ambiguousGeometryMerge = mergeDomAndAxEntities([
		entity("bp-ref://dom/geo-a", { role: "button", name: "Save", geometry: { point: { x: 100, y: 100 } } }),
		entity("bp-ref://dom/geo-b", { role: "button", name: "Save", geometry: { point: { x: 100, y: 100 } } }),
	], [buildAxEntityFromNode({ role: "button", name: "Save" }, { observationId: "obs-ax", capturedAt: 10 }, { point: { x: 100, y: 100 } })]);
	assert.equal(ambiguousGeometryMerge.diagnostics.skipped.ambiguousGeometry, 1);
	assert.equal(ambiguousGeometryMerge.diagnostics.axOnly, 1);
	assert.equal(ambiguousGeometryMerge.diagnostics.degraded, true);
	const backendMerged = mergeDomAndAxEntities([entity("bp-ref://dom/backend", { role: "button", name: "Old", actionability: { actions: ["click"], confidence: "medium" }, scope: { key: "#feed > article", position: 2, size: 10 }, locators: [{ by: "backendNodeId", value: 99 }, { by: "css", value: "#save" }], hints: { selector: "#save" }, state: { ...entity("x").state, pressed: false, current: "page" } })], [buildAxEntityFromNode({ role: "button", name: "New", backendDOMNodeId: 99, properties: [{ name: "pressed", value: { value: "true" } }, { name: "current", value: { value: "step" } }, { name: "setsize", value: { value: 6 } }] }, { observationId: "obs-ax", capturedAt: 10 })]);
	assert.equal(backendMerged.merged[0]!.name, "New");
	assert.equal(backendMerged.merged[0]!.state.pressed, true);
	assert.equal(backendMerged.merged[0]!.state.current, "page");
	assert.deepEqual(backendMerged.merged[0]!.locators, [{ by: "backendNodeId", value: 99 }, { by: "css", value: "#save" }]);
	assert.deepEqual(backendMerged.merged[0]!.hints?.stateSource, { pressed: "ax" });
	assert.deepEqual(backendMerged.merged[0]!.hints?.fusionConflicts, ["state.pressed", "name"]);
	assert.deepEqual(backendMerged.merged[0]!.actionability, { actions: ["click"], confidence: "medium" });
	assert.deepEqual(backendMerged.merged[0]!.scope, { key: "#feed > article", position: 2, size: 10 });
	assert.deepEqual(backendMerged.merged[0]!.structure, { setSize: 6 });
	assert.equal(backendMerged.diagnostics.axEnriched, 1);
	assert.deepEqual(backendMerged.diagnostics, {
		scanBacked: 1,
		axEnriched: 1,
		axOnly: 0,
		matched: { backend: 1, geometry: 0, semantic: 0 },
		degraded: false,
		skipped: { ambiguousBackend: 0, ambiguousGeometry: 0, ambiguousSemantic: 0, targetScopeMismatch: 0, unsafeSemantic: 0 },
	});
	const stateNode = buildAxEntityFromNode({ role: "option", name: "Filter", backendDOMNodeId: 101, properties: [{ name: "selected", value: { value: "true" } }, { name: "disabled", value: { value: "true" } }, { name: "checked", value: { value: "false" } }, { name: "level", value: { value: "3" } }, { name: "posinset", value: { value: 2 } }, { name: "setsize", value: { value: 6 } }, { name: "expanded", value: { value: true } }, { name: "current", value: { value: "page" } }] }, { observationId: "obs-ax", capturedAt: 10 });
	assert.equal(stateNode.entity.state.selected, true);
	assert.equal(stateNode.entity.state.disabled, true);
	assert.equal(stateNode.entity.state.checked, false);
	assert.equal(stateNode.entity.state.expanded, true);
	assert.equal(stateNode.entity.state.current, "page");
	assert.deepEqual(stateNode.entity.structure, { level: 3, setSize: 6, posInSet: 2 });
	const unsafeNode = buildAxEntityFromNode({ role: "button", name: "<svg><path d=\"M10 10\" /></svg>", backendDOMNodeId: 102 }, { observationId: "obs-ax", capturedAt: 10 });
	assert.equal(unsafeNode.entity.name, undefined);
	assert.equal(unsafeNode.entity.hints?.unsafeNameSkipped, true);
	const unsafeMerge = mergeDomAndAxEntities([entity("bp-ref://dom/unsafe", { locators: [{ by: "backendNodeId", value: 102 }], hints: { selector: "#unsafe" } })], [unsafeNode]);
	assert.equal(unsafeMerge.merged[0]!.hints?.selector, "#unsafe");
	assert.deepEqual(unsafeMerge.merged[0]!.hints?.mergedSources, ["dom", "ax"]);
	assert.deepEqual(unsafeMerge.merged[0]!.hints?.fusionMatch, { tier: "backend", confidence: "high" });
	assert.equal(unsafeMerge.diagnostics.skipped.unsafeSemantic, 1);
	assert.equal(unsafeMerge.diagnostics.axOnly, 0);
	assert.equal(unsafeMerge.diagnostics.degraded, true);
});

test("ABML relations materialize fallbacks, paint-order occlusion, graph dedupe, and summaries", () => {
	const source = entity("bp-ref://control/source", { locators: [{ by: "backendNodeId", value: 1, targetId: "target-a" }], hints: { targetId: "target-a", selector: "#source", backendNodeId: 1, currentContainerKeys: ["b:404", "s:#nav"], controlsSelectors: ["#panel"], occluderSelector: "#overlay" }, state: { ...entity("x").state, current: "page", occluded: true } });
	const panel = entity("bp-ref://region/panel", { kind: "region", role: "region", hints: { selector: "#panel" } });
	const nav = entity("bp-ref://region/nav", { kind: "region", role: "navigation", hints: { selector: "#nav" } });
	const overlay = entity("bp-ref://region/overlay", { kind: "region", role: "dialog", hints: { selector: "#overlay" } });
	const anchors = deriveStateRelationAnchors([source, panel, nav, overlay]);
	assert.equal(anchors.length, 4);
	const materialized = materializeRelationGraph([source, panel, nav, overlay], anchors);
	assert.equal(materialized.graph.edgeCount, 4);
	assert.equal(materialized.entities[0]!.relations?.some((relation) => relation.type === "currentIn" && relation.targetRef === "bp-ref://region/nav"), true);
	assert.equal(materialized.entities[0]!.relations?.some((relation) => relation.type === "controls" && relation.targetRef === "bp-ref://region/panel"), true);
	const paintEntities = [
		entity("bp-ref://paint/lower", { locators: [{ by: "backendNodeId", value: 10 }], geometry: { box: { x: 0, y: 0, w: 100, h: 100 } } }),
		entity("bp-ref://paint/upper-near", { locators: [{ by: "backendNodeId", value: 11 }], geometry: { box: { x: 5, y: 5, w: 90, h: 90 } } }),
		entity("bp-ref://paint/upper-far", { locators: [{ by: "backendNodeId", value: 12 }], geometry: { box: { x: 500, y: 500, w: 10, h: 10 } } }),
		entity("bp-ref://paint/text", { kind: "text", role: "StaticText", locators: [{ by: "backendNodeId", value: 13 }] }),
	];
	const paintAnchors = derivePaintOrderRelationAnchors(paintEntities, [
		{ backendNodeId: 10, paintOrder: 1, bounds: { x: 0, y: 0, w: 100, h: 100 } },
		{ backendNodeId: 11, paintOrder: 2, bounds: { x: 5, y: 5, w: 90, h: 90 } },
		{ backendNodeId: 12, paintOrder: 3, bounds: { x: 500, y: 500, w: 10, h: 10 } },
		{ backendNodeId: 13, paintOrder: 4, bounds: { x: 0, y: 0, w: 100, h: 100 } },
	]);
	assert.equal(paintAnchors.length, 2);
	assert.equal(paintAnchors[0]!.type, "coveredBy");
	assert.equal(paintAnchors[0]!.evidence?.overlapRatio, 1);
	const relationRich = addEntityRelations(entity("bp-ref://control/rich"), [
		{ type: "owns", targetRef: "bp-ref://target/b", source: "dom", confidence: "medium" },
		{ type: "controls", targetRef: "bp-ref://target/a", source: "ax", confidence: "high", evidence: { ax: true } },
		{ type: "controls", targetRef: "bp-ref://target/a", source: "dom", confidence: "low", evidence: { dom: true } },
		...Array.from({ length: 10 }, (_, index) => ({ type: "labelledBy" as const, targetRef: `bp-ref://label/${index}`, source: "ax" as const, confidence: "high" as const })),
	]);
	assert.equal(relationRich.relations?.length, 12);
	assert.deepEqual(relationRich.relations?.[0], { type: "controls", targetRef: "bp-ref://target/a", source: "ax", confidence: "high", evidence: { ax: true } });
	const summary = buildRelationSummary([relationRich, entity("bp-ref://cell/1", { relations: [{ type: "cellOf", targetRef: "bp-ref://table/1", source: "ax", confidence: "high" }] })]);
	assert.equal(summary.summary.controls, 1);
	assert.equal(summary.summary.tableCells, 1);
	assert.equal(summary.highlights.some((highlight) => highlight.type === "cellOf"), false);
});

test("ABML inference detects anchored intents, dedupes evidence refs, and handles diff fallbacks", () => {
	const baseSummary = { summary: { expandedTarget: 2, currentIn: 1, tableCells: 51 }, highlights: [] };
	const entities = [
		entity("bp-ref://input/password", { role: "textbox", state: { ...entity("x").state, editable: true }, hints: { inputKind: "password" } }),
		entity("bp-ref://button/login", { role: "button", name: "Sign in", state: { ...entity("x").state, inViewport: true } }),
		entity("bp-ref://search/box", { role: "searchbox", state: { ...entity("x").state, editable: true } }),
		...Array.from({ length: 7 }, (_, index) => entity(`bp-ref://filter/${index}`, { role: index % 2 ? "checkbox" : "button", name: `Filter ${index}`, hints: { containerRole: "group", containerName: "Filters" } })),
		entity("bp-ref://radio/group", { role: "radiogroup" }),
		entity("bp-ref://expand/1", { role: "button", state: { ...entity("x").state, expanded: false }, relations: [{ type: "expandedTarget", targetRef: "bp-ref://panel/1", source: "dom", confidence: "high" }] }),
		entity("bp-ref://expand/2", { role: "button", state: { ...entity("x").state, expanded: true }, relations: [{ type: "expandedTarget", targetRef: "bp-ref://panel/2", source: "dom", confidence: "high" }] }),
		entity("bp-ref://grid/main", { role: "grid" }),
		entity("bp-ref://nav/current", { role: "link", state: { ...entity("x").state, current: "page" }, relations: [{ type: "currentIn", targetRef: "bp-ref://nav/main", source: "ax", confidence: "high" }] }),
		entity("bp-ref://dialog/main", { kind: "region", role: "dialog" }),
		entity("bp-ref://tabs/list", { kind: "region", role: "tablist" }),
		entity("bp-ref://tab/1", { role: "tab" }),
		entity("bp-ref://tab/2", { role: "tab" }),
		entity("bp-ref://alert/status", { kind: "region", role: "status", name: "Saved" }),
		entity("bp-ref://input/required", { role: "textbox", state: { ...entity("x").state, editable: true, focused: false } }),
		entity("bp-ref://button/submit", { role: "button", name: "Submit" }),
	];
	const diff: EntityDiff = {
		appeared: ["bp-ref://alert/status"],
		disappeared: [],
		focusedRef: "bp-ref://input/required",
		changed: [{ ref: "bp-ref://button/submit", kind: "state-changed", before: { disabled: true }, after: { disabled: false } }],
	};
	const summary = buildInferenceSummary(entities, baseSummary, diff);
	assert.deepEqual(summary.intents.map((intent) => intent.intent), ["login", "filter-panel", "single-choice", "multi-choice", "expandable", "data-grid", "navigation", "dialog", "tabbed-interface", "alert-region", "form-dependency"]);
	assert.equal((summary.intents.find((intent) => intent.intent === "filter-panel")?.evidence?.controlRefs as string[]).length, 7);
	assert.equal(summary.intents.find((intent) => intent.intent === "alert-region")?.evidence?.fresh, "appeared");
	assert.equal(summary.intents.find((intent) => intent.intent === "form-dependency")?.evidence?.focusSignal, "focusedRef");
	assert.equal(inferenceEvidenceRefs(summary).includes("bp-ref://button/submit"), true);
	assert.ok(entitiesForInferenceEvidence(entities, summary).length > 3);
	const weakLogin = buildInferenceSummary([entity("bp-ref://password/only", { role: "textbox", state: { ...entity("x").state, editable: true }, hints: { inputKind: "password" } }), entity("bp-ref://oauth", { role: "button", name: "Forgot password" })], { summary: {}, highlights: [] });
	assert.equal(weakLogin.intents[0]?.confidence, "medium");
	assert.equal(weakLogin.intents[0]?.evidence, undefined);
	const transitionDiff: EntityDiff = { appeared: [], disappeared: [], changed: [
		{ ref: "bp-ref://button/enabled", kind: "state-changed", before: { disabled: true }, after: { disabled: false } },
		{ ref: "bp-ref://input/lost", kind: "state-changed", before: { focused: true }, after: { focused: false } },
	] };
	const transition = buildInferenceSummary([
		entity("bp-ref://button/enabled", { role: "button" }),
		entity("bp-ref://input/lost", { role: "textbox", state: { ...entity("x").state, editable: true } }),
	], { summary: {}, highlights: [] }, transitionDiff);
	assert.equal(transition.intents.find((intent) => intent.intent === "form-dependency")?.confidence, "medium");
	assert.deepEqual(buildInferenceSummary([], { summary: {}, highlights: [] }).intents, []);
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
	const script = buildScanScript({ maxChars: 1, maxNodes: Number.POSITIVE_INFINITY });
	const source = scanPage.toString();
	assert.match(script, /^\(\(\) => \{/);
	assert.match(script, /function scanPage\(config\)/);
	assert.match(script, /const __name = \(target\) => target;/);
	assert.match(script, /const BrowserPilotDomAccessibilityApi = \(\(\) => \{/);
	assert.match(script, /catch \{\s*return null;/);
	assert.match(script, /"options":\{"maxChars":1000,"maxNodes":4000\}/);
	assert.match(script, /"pageWorldScanSchema":"browser-page-scan\/v1"/);
	assert.match(source, /fingerprint\s*:\s*scanFingerprint/);
	assert.match(source, /devicePixelRatio\s*:\s*Number\(window\.devicePixelRatio\s*\|\|\s*1\)/);
	assert.match(source, /createTreeWalker/);
	assert.doesNotMatch(source, /querySelectorAll\('\*'\)/);
	assert.doesNotMatch(source, /document\.body\s*&&\s*document\.body\.innerText/);
	assert.match(source, /scrollY\s*:\s*Number\(window\.scrollY\s*\|\|\s*0\)/);
	assert.match(source, /viewportHeight\s*:\s*Math\.max\(/);
	assert.doesNotMatch(source, /content\.tree|tree\s*:\s*content|function walk\(|iframeNotes|includeIframes|growthProbe|collectVisibleRows|collectMediaCandidates|mediaCandidates|\binteractive\s*:|window\.scrollTo|\.scrollTop\s*=/);
	assert.match(source, /selected\s*:\s*selectedState.*pressed\s*:\s*pressedAttr===?["']true["'].*expanded\s*:\s*expandedAttr===?["']true["']/);
	assert.match(source, /documentRect\s*:\s*visible\.documentRect/);
	assert.doesNotMatch(source, /list_hints|canvas_regions|media_candidates|node_count|iframe_notes|controls_pairs|text_only/);
	for (const helper of ["safePreviewOf", "conciseContainerLabel", "headingLabelNear", "containerLabelOf", "computedAccessibleName", "roleProviderRole", "explicitRoleOf", "nativeRoleOf"]) {
		assert.match(source, new RegExp(`function ${helper}\\(`));
	}
	assert.match(source, /computeAccessibleName/);
	assert.match(source, /getRole/);
	assert.match(source, /accessibleNameCount\s*>=\s*ACCESSIBLE_NAME_LIMIT/);
	assert.match(source, /LOW_VALUE_PROVIDER_ROLES/);
	assert.match(source, /moneyTokens\s*>=\s*2/);
	assert.match(source, /aria-labelledby/);
	assert.match(source, /aria-selected/);
	assert.match(source, /sr-only/);
	assert.doesNotMatch(source, /__browserPilotScanFingerprintSeq/);
	const transformHelpers = [...new Set(source.match(/\b__[A-Za-z_$][\w$]*/g) ?? [])];
	assert.equal(transformHelpers.every((name) => name === "__name"), true);
	assert.doesNotThrow(() => Function(`return ${script};`));
});

function scanRoleOf(provider: unknown): (el: { tagName: string; type?: string; multiple?: boolean; size?: number; attrs?: Record<string, string> }) => string | null {
	const source = scanPage.toString();
	const start = source.indexOf("function clean(");
	const end = source.indexOf("function actionNameOf(");
	assert.ok(start >= 0 && end > start);
	return Function("BrowserPilotDomAccessibilityApi", "__name", `${source.slice(start, end)}\nreturn roleOf;`)(provider, (value: unknown) => value) as (el: { tagName: string; type?: string; multiple?: boolean; size?: number; attrs?: Record<string, string> }) => string | null;
}

function roleFixture(tagName: string, attrs: Record<string, string> = {}, extras: Record<string, unknown> = {}): { tagName: string; attrs: Record<string, string>; getAttribute: (name: string) => string | null; hasAttribute: (name: string) => boolean } & Record<string, unknown> {
	return {
		tagName,
		attrs,
		getAttribute(name: string) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] ?? null : null; },
		hasAttribute(name: string) { return Object.hasOwn(this.attrs, name); },
		...extras,
	};
}

test("scan role provider covers representative implicit roles without widening no-role anchors", () => {
	const roleOf = scanRoleOf({ getRole: (el: { attrs?: Record<string, string> }) => el.attrs?.["data-provider-role"] ?? null });
	assert.equal(roleOf(roleFixture("A", { href: "/docs", "data-provider-role": "link" })), "link");
	assert.equal(roleOf(roleFixture("A", { "data-provider-role": "generic" })), null);
	assert.equal(roleOf(roleFixture("INPUT", { "data-provider-role": "searchbox" }, { type: "search" })), "searchbox");
	assert.equal(roleOf(roleFixture("INPUT", { list: "choices", "data-provider-role": "combobox" }, { type: "text" })), "combobox");
	assert.equal(roleOf(roleFixture("IMG", { alt: "", "data-provider-role": "presentation" })), null);
	assert.equal(roleOf(roleFixture("SUMMARY", { "data-provider-role": "button" })), "button");
	assert.equal(roleOf(roleFixture("NAV", { "data-provider-role": "navigation" })), "navigation");
	assert.equal(roleOf(roleFixture("MAIN", { "data-provider-role": "main" })), "main");
	assert.equal(roleOf(roleFixture("SECTION", { "data-provider-role": "region" })), "region");
	assert.equal(roleOf(roleFixture("FORM", { "data-provider-role": "form" })), "form");
	assert.equal(roleOf(roleFixture("HEADER", { "data-provider-role": "banner" })), "banner");
	assert.equal(roleOf(roleFixture("FOOTER", { "data-provider-role": "contentinfo" })), "contentinfo");
});

test("scan role provider fails closed and preserves native role fallback", () => {
	for (const provider of [null, {}, { getRole: () => { throw new Error("provider unavailable"); } }, { getRole: () => "generic" }]) {
		const roleOf = scanRoleOf(provider);
		assert.equal(roleOf(roleFixture("BUTTON")), "button");
		assert.equal(roleOf(roleFixture("SUMMARY")), "button");
		assert.equal(roleOf(roleFixture("TEXTAREA")), "textbox");
		assert.equal(roleOf(roleFixture("INPUT", {}, { type: "checkbox" })), "checkbox");
		assert.equal(roleOf(roleFixture("INPUT", {}, { type: "search" })), "searchbox");
		assert.equal(roleOf(roleFixture("INPUT", { list: "choices" }, { type: "email" })), "combobox");
		assert.equal(roleOf(roleFixture("SELECT", {}, { multiple: false, size: 1 })), "combobox");
	}
	const roleOf = scanRoleOf({ getRole: () => "link" });
	assert.equal(roleOf(roleFixture("DIV", { role: "button link" })), "button");
});
