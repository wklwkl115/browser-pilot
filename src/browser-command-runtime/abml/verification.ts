import { prepareExecuteStdlib } from "../executeStdlib.js";
import { buildAxEntityFromNode, mergeKnownDomAndAxEntity } from "../../kernels/abml/ax.js";
import { buildDomEntityFromScanActionable, type Entity, type ScanEntityContext } from "../../kernels/abml/entity.js";
import { verificationDiff, verifyAbmlState, type AbmlStateExpectation, type AbmlVerificationObservation } from "../../kernels/abml/verification.js";
import { readPartialAxTree } from "../../browser-runtime/abml/axRuntime.js";
import { resolveRefUriDetailed, selectorFromRef, type ResourceRefDescriptor } from "../../resources/resourceRefs.js";
import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { isRecord } from "../../utils/records.js";

const TARGET_SAMPLE_SCRIPT = `
const el = browserPilot.refs.target;
if (!el) return null;
const attrBool = name => {
  const value = el.getAttribute(name);
  return value === "true" ? true : value === "false" ? false : undefined;
};
const rect = el.getBoundingClientRect();
const style = getComputedStyle(el);
const vw = Math.max(document.documentElement.clientWidth || 0, innerWidth || 0);
const vh = Math.max(document.documentElement.clientHeight || 0, innerHeight || 0);
const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
const inViewport = visible && rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
const point = { x: Math.round(Math.max(0, Math.min(vw - 1, rect.left + rect.width / 2))), y: Math.round(Math.max(0, Math.min(vh - 1, rect.top + rect.height / 2))) };
let hitOk = null;
if (inViewport && document.elementFromPoint) {
  const hit = document.elementFromPoint(point.x, point.y);
  hitOk = !hit || hit === el || el.contains(hit) || hit.contains(el);
  if (!hitOk) {
    const corner = document.elementFromPoint(
      Math.round(Math.max(0, Math.min(vw - 1, rect.left + rect.width * 0.25))),
      Math.round(Math.max(0, Math.min(vh - 1, rect.top + rect.height * 0.25))),
    );
    hitOk = !corner || corner === el || el.contains(corner) || corner.contains(el);
  }
}
const editable = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el.isContentEditable === true;
const nativeChecked = typeof el.checked === "boolean" ? el.checked : undefined;
const nativeSelected = typeof el.selected === "boolean" ? el.selected : undefined;
return {
  tag: String(el.tagName || "").toLowerCase(),
  role: el.getAttribute("role"),
  editable,
  disabled: el.disabled === true || attrBool("aria-disabled") === true,
  focused: document.activeElement === el,
  checked: nativeChecked ?? attrBool("aria-checked"),
  selected: nativeSelected ?? attrBool("aria-selected"),
  pressed: attrBool("aria-pressed"),
  expanded: attrBool("aria-expanded"),
  current: el.getAttribute("aria-current") || undefined,
  visible,
  inViewport,
  rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  point,
  hitOk
};`;

type AbmlVerificationRuntimeOptions = {
	server: BrowserCommandRuntimePort;
	expectation: AbmlStateExpectation;
	browserSessionId?: string;
	tabId: number;
	rawTarget: string | number;
	timeoutMs: number;
	signal?: AbortSignal;
};

function backendNodeId(descriptor: ResourceRefDescriptor): number | undefined {
	const locator = descriptor.locators.find((item) => item.by === "backendNodeId");
	const value = Number(locator?.value);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

function targetId(descriptor: ResourceRefDescriptor): string | undefined {
	return descriptor.owner?.targetId || descriptor.locators?.find((item) => item.by === "backendNodeId")?.targetId;
}

function axNodeForBackend(nodes: Array<Record<string, unknown>>, id: number | undefined): Record<string, unknown> | undefined {
	if (id === undefined) return undefined;
	return nodes.find((node) => Number(node.backendDOMNodeId ?? node.backendNodeId) === id);
}

function staleRefReason(options: AbmlVerificationRuntimeOptions, descriptor: ResourceRefDescriptor): string | undefined {
	const snapshot = options.server.snapshot({ browserSessionId: options.browserSessionId });
	const tab = snapshot.tabs.find((item) => Number(item.tabId ?? item.id) === options.tabId);
	const expected = descriptor.documentEpoch;
	const targetGeneration = Number(tab?.targetGeneration ?? tab?.generation);
	const pageEpoch = typeof tab?.pageEpoch === "string" ? tab.pageEpoch : undefined;
	if (descriptor.owner.tabId !== options.tabId || (descriptor.owner.browserSessionId && descriptor.owner.browserSessionId !== snapshot.browserSessionId)) return "ABML target ref belongs to a different page target";
	if (!expected || !Number.isInteger(targetGeneration) || !pageEpoch) return "ABML target page identity cannot be proven current";
	if (expected.targetGeneration !== targetGeneration || expected.pageEpoch !== pageEpoch) return "ABML target ref became stale after page replacement";
	return undefined;
}

export async function readAbmlVerificationObservation(options: AbmlVerificationRuntimeOptions): Promise<AbmlVerificationObservation> {
	const resolved = resolveRefUriDetailed(options.expectation.ref);
	if (!resolved.ok) return { reason: resolved.error };
	const descriptor = resolved.ref.descriptor;
	const staleReason = staleRefReason(options, descriptor);
	if (staleReason) return { reason: staleReason };
	const capturedAt = Date.now();
	const context: ScanEntityContext = {
		browserSessionId: options.browserSessionId,
		tabId: options.tabId,
		targetId: targetId(descriptor),
		targetGeneration: descriptor.documentEpoch?.targetGeneration,
		pageEpoch: descriptor.documentEpoch?.pageEpoch,
		url: descriptor.documentEpoch?.url,
		observationId: descriptor.observationId,
		capturedAt,
	};
	const prepared = prepareExecuteStdlib(TARGET_SAMPLE_SCRIPT, { refs: { target: options.expectation.ref } });
	const id = backendNodeId(descriptor);
	const [domResult, axResult] = await Promise.allSettled([
		options.server.executeJavaScript(prepared.script, {
			browserSessionId: options.browserSessionId,
			tabId: options.rawTarget,
			timeoutMs: Math.min(options.timeoutMs, 1_500),
			accessMode: "read",
			signal: options.signal,
		}),
		readPartialAxTree(options.server, {
			browserSessionId: options.browserSessionId,
			tabId: options.tabId,
			backendNodeId: id,
			timeoutMs: Math.min(options.timeoutMs, 1_500),
			maxNodes: 8,
			fetchRelatives: false,
			signal: options.signal,
		}),
	]);
	options.signal?.throwIfAborted();

	let dom: Entity | undefined;
	if (domResult.status === "fulfilled" && isRecord(domResult.value.data)) {
		const built = buildDomEntityFromScanActionable({
			...domResult.value.data,
			...(selectorFromRef(descriptor) ? { selector: selectorFromRef(descriptor) } : {}),
			...(id !== undefined ? { backendNodeId: id } : {}),
			...(targetId(descriptor) ? { targetId: targetId(descriptor) } : {}),
		}, context);
		dom = { ...built.entity, ref: options.expectation.ref };
	}

	let ax: ReturnType<typeof buildAxEntityFromNode>["entity"] | undefined;
	if (axResult.status === "fulfilled") {
		const node = axNodeForBackend(axResult.value.nodes, id);
		if (node) ax = buildAxEntityFromNode(node, { ...context, observationId: descriptor.observationId }).entity;
	}
	const entity = dom && ax
		? mergeKnownDomAndAxEntity(dom, ax)
		: dom ?? (ax ? { ...ax, ref: options.expectation.ref } : undefined);
	if (entity) {
		delete entity.name;
		delete entity.value;
	}
	const sources = [...(dom ? ["dom"] : []), ...(ax ? ["ax"] : [])];
	return entity
		? { entity, sources }
		: { reason: "ABML target state was unavailable", sources };
}

export async function prepareAbmlVerification(options: AbmlVerificationRuntimeOptions & { verb: string }) {
	const before = await readAbmlVerificationObservation(options);
	return {
		initialVerification: verifyAbmlState(options.verb, options.expectation, { reason: "Postcondition observation did not complete" }, 0),
		verify: async () => {
			const after = await readAbmlVerificationObservation(options);
			const result = verifyAbmlState(options.verb, options.expectation, after, 0);
			const diff = verificationDiff(before.entity, after.entity);
			return { ...result, ...(diff ? { diff } : {}) };
		},
	};
}

export function recordAbmlActionContext(options: {
	server: BrowserCommandRuntimePort;
	browserSessionId?: string;
	tabId: number;
	ref: string;
	verb: string;
	at?: number;
}): void {
	if (!options.server.getPerceptionLedgerFrame || !options.server.recordPerceptionLedgerFrame) return;
	const bridge = options.server.snapshot({ browserSessionId: options.browserSessionId });
	const tab = bridge.tabs.find((item) => Number(item.tabId ?? item.id) === options.tabId);
	const browserSessionId = bridge.browserSessionId;
	const targetGeneration = Number(tab?.targetGeneration ?? tab?.generation);
	const pageEpoch = typeof tab?.pageEpoch === "string" ? tab.pageEpoch : undefined;
	if (!browserSessionId || !Number.isInteger(targetGeneration) || targetGeneration <= 0 || !pageEpoch) return;
	const key = { browserSessionId, tabId: options.tabId, targetGeneration, pageEpoch };
	const frame = options.server.getPerceptionLedgerFrame(key);
	if (!frame) return;
	options.server.recordPerceptionLedgerFrame({
		...frame,
		lastAction: { ref: options.ref, verb: options.verb, at: options.at ?? Date.now() },
	});
}
