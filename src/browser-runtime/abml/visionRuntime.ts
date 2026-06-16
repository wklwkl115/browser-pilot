import { mkdir } from "node:fs/promises";
import path from "node:path";
import { registerBrowserResultResource, type ResourceRefDescriptor as RefDescriptor } from "../../resources/resourceRefs.js";
import { jsonForInlineScript, renderCaptureTemplate } from "../../capture/inject.js";
import { VIEWPORT_TEMPLATE } from "../../capture/generated/visionBundle.js";
import type { BrowserCommandRuntimePort } from "../../ports/BrowserCommandRuntimePort.js";
import { assertBridgeCommandSucceeded } from "../../utils/bridgeResultValidation.js";
import { saveDataUrl } from "../../artifacts/artifactFiles.js";
import type { Entity } from "../../kernels/abml/entity.js";
import { normalizeAbmlError } from "../../kernels/abml/errors.js";

export type AbmlVisionRuntimeServer = Pick<BrowserCommandRuntimePort, "sendCommand">;

export type VisionInspectResult =
	| { ok: true; artifactPath: string; resourceUri: string; entity: Entity; data: Record<string, unknown> }
	| { ok: false; error: ReturnType<typeof normalizeAbmlError> };

function selectorFromRef(descriptor: RefDescriptor): string | undefined {
	for (const locator of descriptor.locators) if (locator.by === "css" && locator.value.trim()) return locator.value;
	return undefined;
}

function pointFromRef(descriptor: RefDescriptor): { x: number; y: number } | undefined {
	for (const locator of descriptor.locators) if (locator.by === "point") return { x: locator.x, y: locator.y };
	return descriptor.geometry?.point;
}

function artifactFileName(prefix: string, format: string): string {
	const ext = format === "jpeg" ? "jpg" : format;
	return `${prefix}-${Date.now()}.${ext}`;
}

function viewportScript(selector?: string): string {
	return renderCaptureTemplate(VIEWPORT_TEMPLATE, { 'JSON.stringify(selector || "")': jsonForInlineScript(selector || "") });
}

async function evaluatePageObject(server: AbmlVisionRuntimeServer, script: string, options: { browserSessionId?: string; tabId?: number; timeoutMs: number }): Promise<Record<string, unknown>> {
	const result = await server.sendCommand({
		cmd: "cdp",
		method: "Runtime.evaluate",
		persistent: false,
		timeoutMs: options.timeoutMs,
		params: { expression: script, awaitPromise: true, returnByValue: true },
	}, { browserSessionId: options.browserSessionId, tabId: options.tabId, timeoutMs: options.timeoutMs });
	assertBridgeCommandSucceeded(result, "cdp:Runtime.evaluate");
	const data = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
	const remote = data.result && typeof data.result === "object" ? data.result as Record<string, unknown> : undefined;
	return remote && typeof remote.value === "object" && remote.value && !Array.isArray(remote.value) ? remote.value as Record<string, unknown> : {};
}

export async function inspectVisionRegion(server: AbmlVisionRuntimeServer, descriptor: RefDescriptor, options: { browserSessionId?: string; tabId?: number; timeoutMs?: number; cwd?: string }): Promise<VisionInspectResult> {
	const point = pointFromRef(descriptor);
	if (!point) return { ok: false, error: normalizeAbmlError({ code: "INVALID_INPUT", message: "vision region ref requires a cached point" }) };
	const tabId = descriptor.owner.tabId ?? options.tabId;
	if (!tabId) return { ok: false, error: normalizeAbmlError({ code: "BACKEND_UNAVAILABLE", message: "No target tab available for vision inspection" }) };
	const timeoutMs = options.timeoutMs ?? 10_000;
	const selector = selectorFromRef(descriptor);
	const shot = await server.sendCommand({ cmd: "screenshot.capture", tabId, format: "png", fallback: true, timeoutMs }, { browserSessionId: options.browserSessionId ?? descriptor.owner.browserSessionId, tabId, timeoutMs });
	try {
		assertBridgeCommandSucceeded(shot, "screenshot.capture");
	} catch (error) {
		return { ok: false, error: normalizeAbmlError(error) };
	}
	const data = shot.data && typeof shot.data === "object" ? shot.data as Record<string, unknown> : {};
	const screenshot = typeof data.screenshot === "string" ? data.screenshot : undefined;
	if (!screenshot) return { ok: false, error: normalizeAbmlError({ code: "BACKEND_UNAVAILABLE", message: "screenshot.capture returned no screenshot payload" }) };
	const cwd = options.cwd ?? process.cwd();
	const outDir = path.resolve(cwd, ".browser-pilot", "artifacts");
	await mkdir(outDir, { recursive: true });
	const artifactPath = path.join(outDir, artifactFileName("abml-vision-region", typeof data.format === "string" ? data.format : "png"));
	const saved = await saveDataUrl(screenshot, artifactPath);
	const resourceUri = registerBrowserResultResource({ kind: "artifact-slice", artifactPath, name: descriptor.semantic?.name || "vision-region", mime: saved.mime, bytes: saved.bytes, browserSessionId: descriptor.owner.browserSessionId, redaction: "default" });
	const probe = await evaluatePageObject(server, viewportScript(selector), { browserSessionId: options.browserSessionId ?? descriptor.owner.browserSessionId, tabId, timeoutMs }).catch(() => ({} as Record<string, unknown>));
	const probeViewport = probe && typeof probe.viewport === "object" && probe.viewport ? probe.viewport : undefined;
	const probeText = typeof probe.text === "string" ? probe.text : undefined;
	const probeUrl = typeof probe.url === "string" ? probe.url : undefined;
	const entity: Entity = {
		ref: descriptor.refId,
		kind: "region",
		role: descriptor.semantic?.role || "region",
		...(descriptor.semantic?.name ? { name: descriptor.semantic.name } : {}),
		state: {
			visible: true,
			occluded: false,
			disabled: false,
			focused: false,
			editable: false,
			inViewport: true,
		},
		source: "vision",
		locators: descriptor.locators,
		geometry: descriptor.geometry,
		hints: {
			visualFloor: true,
			screenshotHandle: resourceUri,
			selector,
			viewport: probeViewport,
			text: probeText,
		},
	};
	return { ok: true, artifactPath, resourceUri, entity, data: { screenshotHandle: resourceUri, artifactPath, format: saved.mime, point, selector, viewport: probeViewport, url: probeUrl } };
}
