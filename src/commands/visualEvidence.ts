import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { artifactResourceUri, decodeDataUrl, saveBuffer } from "../artifacts/artifactFiles.js";
import type { BrowserCommandRuntimePort } from "../ports/BrowserCommandRuntimePort.js";
import type { Entity } from "../kernels/abml/entity.js";
import type { PageWorldScanBundleV1 } from "../kernels/abml/pageWorldScan.js";
import type { ObservationSnapshot, VisualObservation } from "../kernels/abml/pageObservation.js";
import { defaultRefPolicyForKind } from "../kernels/refs/refPolicy.js";
import { makeBrowserPilotRefUri } from "../kernels/refs/refId.js";
import type { RefDescriptor, RefVisualBinding } from "../kernels/refs/types.js";
import { registerRefDescriptor } from "../resources/resourceRefs.js";
import { urlOrigin } from "../utils/url.js";
import { isRecord } from "../utils/records.js";
import { imageDimensions } from "./screenshotCommand.js";
import type { PageFingerprint } from "./pageSignals.js";
import type { ObserveToolParams } from "./observe/common.js";

const VISUAL_REF_TTL_MS = 30_000;

export type VisualScreenshotCapture = {
	buffer: Buffer;
	mime: string;
	sha256: string;
	width: number;
	height: number;
	captureMethod: string;
	actionableGrounding: boolean;
	capturedAt: number;
	transportMs: number;
	decodeHashMs: number;
};

export function screenshotSha256(dataUrl: string): string {
	return createHash("sha256").update(decodeDataUrl(dataUrl).buffer).digest("hex");
}

export function shouldCaptureVisual(params: Pick<ObserveToolParams, "visual">, data: PageWorldScanBundleV1): boolean {
	if (params.visual === "never") return false;
	if (params.visual === "always") return true;
	return Number(data.stats.visualSurfaceCount ?? 0) > 0 || Number(data.stats.unnamedActionableCount ?? 0) > 0;
}

export async function captureVisualScreenshot(server: BrowserCommandRuntimePort, options: { browserSessionId?: string; tabId: string | number | undefined; timeoutMs: number; signal?: AbortSignal }): Promise<VisualScreenshotCapture | undefined> {
	const transportStartedAt = Date.now();
	const result = await server.sendCommand({ cmd: "screenshot.capture", format: "png", captureBeyondViewport: false, fallback: true, timeoutMs: options.timeoutMs }, {
		browserSessionId: options.browserSessionId,
		tabId: options.tabId,
		timeoutMs: options.timeoutMs,
		internal: true,
		signal: options.signal,
	});
	const transportMs = Math.max(0, Date.now() - transportStartedAt);
	const capturedAt = Date.now();
	const data = isRecord(result.data) ? result.data : {};
	const dataUrl = typeof data.screenshot === "string" ? data.screenshot : undefined;
	if (!dataUrl) return undefined;
	const decodeStartedAt = Date.now();
	const decoded = decodeDataUrl(dataUrl);
	const dimensions = imageDimensions(decoded.buffer);
	if (!dimensions) return undefined;
	const sha256 = createHash("sha256").update(decoded.buffer).digest("hex");
	const decodeHashMs = Math.max(0, Date.now() - decodeStartedAt);
	const captureMethod = typeof data.method === "string" ? data.method : typeof data.fallback === "string" ? data.fallback : "unknown";
	return {
		buffer: decoded.buffer,
		mime: decoded.mime,
		sha256,
		width: dimensions.width,
		height: dimensions.height,
		captureMethod,
		actionableGrounding: captureMethod === "persistent_cdp" || captureMethod === "chrome.debugger",
		capturedAt,
		transportMs,
		decodeHashMs,
	};
}

function completeVisualFingerprint(fingerprint: PageFingerprint | undefined): fingerprint is PageFingerprint & Required<Pick<PageFingerprint, "scrollX" | "scrollY" | "viewportWidth" | "viewportHeight" | "devicePixelRatio">> {
	return !!fingerprint
		&& Number.isFinite(fingerprint.changeSeq)
		&& Number.isFinite(fingerprint.scrollX)
		&& Number.isFinite(fingerprint.scrollY)
		&& Number(fingerprint.viewportWidth) > 0
		&& Number(fingerprint.viewportHeight) > 0
		&& Number(fingerprint.devicePixelRatio) > 0;
}

function visualTargets(entities: Entity[], viewportWidth: number, viewportHeight: number): VisualObservation["targets"] {
	const clamp = (value: number) => Math.max(0, Math.min(1, value));
	return entities
		.filter((entity) => entity.state.inViewport && entity.geometry?.box && (entity.actionability || entity.kind === "control" || entity.kind === "frame" || entity.hints?.visualSurface === true))
		.slice(0, 128)
		.map((entity) => {
			const box = entity.geometry!.box!;
			const left = clamp(box.x / viewportWidth);
			const top = clamp(box.y / viewportHeight);
			const right = clamp((box.x + box.w) / viewportWidth);
			const bottom = clamp((box.y + box.h) / viewportHeight);
			return {
				ref: entity.ref,
				box: { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) },
			};
		})
		.filter((target) => target.box.w > 0 && target.box.h > 0);
}

export async function materializeVisualObservation(options: {
	capture: VisualScreenshotCapture;
	fingerprint: PageFingerprint | undefined;
	entities: Entity[];
	snapshot: ObservationSnapshot;
	outputPath: string;
	projectRoot: string;
	url?: string;
}): Promise<{ visual: VisualObservation; saved: { path: string; bytes: number; mime: string }; writeMs: number }> {
	if (!completeVisualFingerprint(options.fingerprint)) throw new Error("visual screenshot has no coherent viewport fingerprint");
	const fingerprint = options.fingerprint;
	const screenshotPath = path.join(path.dirname(options.outputPath), `${path.parse(options.outputPath).name}.png`);
	const resourceUri = artifactResourceUri(screenshotPath, options.projectRoot);
	if (!resourceUri) throw new Error("visual screenshot is outside the Browser Pilot artifact root");
	const writeStartedAt = Date.now();
	const saved = await saveBuffer(options.capture.buffer, screenshotPath, options.capture.mime);
	const writeMs = Math.max(0, Date.now() - writeStartedAt);
	const imageToCss: RefVisualBinding["imageToCss"] = [
		fingerprint.viewportWidth / options.capture.width, 0, 0,
		fingerprint.viewportHeight / options.capture.height, 0, 0,
	];
	const actionableGrounding = options.capture.actionableGrounding;
	const binding: RefVisualBinding = {
		resourceUri,
		sha256: options.capture.sha256,
		width: options.capture.width,
		height: options.capture.height,
		captureMethod: options.capture.captureMethod,
		actionableGrounding,
		fingerprint,
		imageToCss,
	};
	const owner = {
		...(options.snapshot.browserSessionId ? { browserSessionId: options.snapshot.browserSessionId } : {}),
		...(options.snapshot.tabId !== undefined ? { tabId: options.snapshot.tabId } : {}),
		...(urlOrigin(options.url) ? { topLevelOrigin: urlOrigin(options.url) } : {}),
	};
	const policy = defaultRefPolicyForKind("region");
	const ref = registerRefDescriptor({
		descriptor: {
			refId: makeBrowserPilotRefUri("region", randomUUID()),
			kind: "region",
			locators: [{ by: "point", x: fingerprint.viewportWidth / 2, y: fingerprint.viewportHeight / 2 }],
			owner,
			policy: { ...policy, liveActionsAllowed: actionableGrounding },
			semantic: { role: "region", name: "visual viewport" },
			geometry: { box: { x: 0, y: 0, w: fingerprint.viewportWidth, h: fingerprint.viewportHeight } },
			observationId: options.snapshot.snapshotId,
			documentEpoch: {
				...(options.snapshot.targetGeneration !== undefined ? { targetGeneration: options.snapshot.targetGeneration } : {}),
				...(options.snapshot.pageEpoch ? { pageEpoch: options.snapshot.pageEpoch } : {}),
				...(options.snapshot.documentId ? { documentId: options.snapshot.documentId } : {}),
				changeSeq: fingerprint.changeSeq,
				mutationEpoch: fingerprint.changeSeq,
				url: options.url,
				capturedAt: options.capture.capturedAt,
			},
			visual: binding,
			createdAt: options.capture.capturedAt,
			ttlMs: Math.min(options.snapshot.ttlMs, VISUAL_REF_TTL_MS),
			stabilityScore: actionableGrounding ? 0.5 : 0,
		},
		artifactPath: saved.path,
	});
	return {
		visual: {
			ref,
			resourceUri,
			captureMethod: options.capture.captureMethod,
			actionableGrounding,
			coordinateSpace: "normalized-image",
			image: { width: options.capture.width, height: options.capture.height, sha256: options.capture.sha256 },
			basis: {
				observationId: options.snapshot.snapshotId,
				changeSeq: fingerprint.changeSeq,
				...(fingerprint.url ? { url: fingerprint.url } : {}),
				scrollX: fingerprint.scrollX,
				scrollY: fingerprint.scrollY,
				viewportWidth: fingerprint.viewportWidth,
				viewportHeight: fingerprint.viewportHeight,
				devicePixelRatio: fingerprint.devicePixelRatio,
				imageToCss,
			},
			targets: fingerprint.viewportWidth > 0 && fingerprint.viewportHeight > 0 ? visualTargets(options.entities, fingerprint.viewportWidth, fingerprint.viewportHeight) : [],
		},
		saved,
		writeMs,
	};
}

export function visualFingerprintMatches(binding: RefVisualBinding, fingerprint: PageFingerprint | undefined): boolean {
	const expected = binding.fingerprint;
	return !!fingerprint
		&& fingerprint.changeSeq === expected.changeSeq
		&& fingerprint.pageEpoch === expected.pageEpoch
		&& fingerprint.documentId === expected.documentId
		&& fingerprint.url === expected.url
		&& fingerprint.scrollX === expected.scrollX
		&& fingerprint.scrollY === expected.scrollY
		&& fingerprint.viewportWidth === expected.viewportWidth
		&& fingerprint.viewportHeight === expected.viewportHeight
		&& fingerprint.devicePixelRatio === expected.devicePixelRatio;
}

export function registerVisualTargetRef(base: RefDescriptor, point: { x: number; y: number }, to?: { x: number; y: number }): string {
	if (!base.visual) throw new Error("visual target requires a visual observation ref");
	const visual = base.visual;
	const x = point.x * visual.fingerprint.viewportWidth;
	const y = point.y * visual.fingerprint.viewportHeight;
	return registerRefDescriptor({
		descriptor: {
			refId: makeBrowserPilotRefUri("region", randomUUID()),
			kind: "region",
			locators: [{ by: "point", x, y }],
			owner: base.owner,
			policy: base.policy,
			semantic: { role: "region", name: "visual target" },
			geometry: { box: { x: Math.max(0, x - 1), y: Math.max(0, y - 1), w: 2, h: 2 }, point: { x, y } },
			observationId: base.observationId,
			documentEpoch: base.documentEpoch,
			visual: { ...visual, anchor: { hostRef: base.refId, point, ...(to ? { to } : {}) } },
			createdAt: Date.now(),
			ttlMs: Math.max(1, Math.min(base.ttlMs - Math.max(0, Date.now() - base.createdAt), VISUAL_REF_TTL_MS)),
			stabilityScore: 0.25,
		},
	});
}
