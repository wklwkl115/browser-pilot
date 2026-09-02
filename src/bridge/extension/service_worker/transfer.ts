// Upload/download commands for the Browser Pilot bridge.

import { chromeApi as chrome } from "./runtimeEnv.js";
import {
	BROWSER_PILOT_ERROR_CODES,
	normalizePersistentBrowserPilotResponse,
	browserPilotError,
	browserPilotPersistentCdp,
	runtimeErrorMessage as errorText,
	runtimeRecord as asRecord,
} from "./runtimeSupport.js";
import { subscribeBrowserPilotCdp, unsubscribeBrowserPilotCdp } from "./wait_cdp.js";
import type {
	JsonRecord,
	BrowserPilotBridgeCommand,
	BrowserPilotBridgeResponse,
	BrowserPilotChromeDownloadItem,
	BrowserPilotPersistentCdpBridge,
} from "./types.js";

const BROWSER_PILOT_FILE_ACCESS_MESSAGE =
	'To enable file upload, open chrome://extensions, click Details under Browser Pilot Bridge, and enable "Allow access to file URLs".';

type TransferDownloadMode = "click" | "media" | "url";
type TransferDownloadTarget = "selector" | "url";
type TransferDownloadSummary = JsonRecord & {
	id?: number;
	url?: string;
	finalUrl?: string;
	filename?: string;
	path?: string;
	mime?: string;
	state?: string;
	bytesReceived?: number;
	totalBytes?: number;
	danger?: string;
	exists?: boolean;
	startTime?: string;
	endTime?: string;
	error?: string;
};
type TransferPageDownloadEvent = JsonRecord & {
	method?: string;
	url?: string;
	suggestedFilename?: string;
	guid?: string;
	frameId?: unknown;
	pageDownloadError?: string;
};
type TransferDownloadOptions = JsonRecord & {
	url: string;
	saveAs: boolean;
	filename?: string;
	conflictAction?: string;
};
type TransferEvalData = JsonRecord & { href?: string; suggestedFilename?: string };
type TransferCdpBridge = BrowserPilotPersistentCdpBridge & {
	send: NonNullable<BrowserPilotPersistentCdpBridge["send"]>;
};
const DOWNLOAD_PENDING_DANGERS = new Set(["asyncScanning", "asyncLocalPasswordScanning"]);
const DOWNLOAD_ALLOWED_DANGERS = new Set(["safe", "accepted", "allowlistedByPolicy", "deepScannedSafe"]);

function errorRecord(error: unknown): JsonRecord {
	return asRecord(error);
}

function responseData(response: BrowserPilotBridgeResponse | null | undefined): JsonRecord {
	return asRecord(response?.data);
}

function transferTimeoutMs(msg: BrowserPilotBridgeCommand, fallback: number): number {
	const raw = Number(msg.timeoutMs ?? msg.timeout_ms ?? fallback ?? 30000);
	if (!Number.isFinite(raw) || raw <= 0) return fallback || 30000;
	return Math.max(100, Math.min(300000, Math.floor(raw)));
}

function transferIsHttpUrl(url: unknown): boolean {
	try {
		const u = new URL(String(url || ""));
		return u.protocol === "http:" || u.protocol === "https:";
	} catch (_) {
		return false;
	}
}

function transferNormalizeDownloadMode(
	msg: BrowserPilotBridgeCommand,
	target: TransferDownloadTarget,
): { ok: true; mode: TransferDownloadMode } | BrowserPilotBridgeResponse {
	const raw = msg && msg.mode;
	const omitted = raw === undefined || raw === null || raw === "";
	if (omitted) return { ok: true, mode: target === "url" ? "url" : "click" };
	if (typeof raw !== "string") {
		return browserPilotError(
			BROWSER_PILOT_ERROR_CODES.INVALID_RULE,
			"transfer.download mode must be one of click, media, or url",
			{ mode: raw, target, allowedModes: ["click", "media", "url"] },
		);
	}
	const mode = raw.trim().toLowerCase();
	if (!["click", "media", "url"].includes(mode)) {
		return browserPilotError(
			BROWSER_PILOT_ERROR_CODES.INVALID_RULE,
			"transfer.download mode must be one of click, media, or url",
			{ mode: raw, target, allowedModes: ["click", "media", "url"] },
		);
	}
	if (target === "url" && mode !== "url") {
		return browserPilotError(
			BROWSER_PILOT_ERROR_CODES.INVALID_RULE,
			"transfer.download url target only accepts mode:url or omitted mode",
			{ mode, target, allowedModes: ["url"] },
		);
	}
	if (target === "selector" && mode === "url") {
		return browserPilotError(
			BROWSER_PILOT_ERROR_CODES.INVALID_RULE,
			"transfer.download selector target only accepts mode:click, mode:media, or omitted mode",
			{ mode, target, allowedModes: ["click", "media"] },
		);
	}
	return { ok: true, mode: mode as TransferDownloadMode };
}

function transferDownloadItem(item: BrowserPilotChromeDownloadItem | null | undefined): TransferDownloadSummary | null {
	if (!item) return null;
	return {
		id: item.id,
		url: item.url,
		finalUrl: item.finalUrl,
		filename: item.filename,
		path: item.filename,
		mime: item.mime,
		state: item.state,
		bytesReceived: item.bytesReceived,
		totalBytes: item.totalBytes,
		danger: item.danger,
		exists: item.exists,
		startTime: item.startTime,
		endTime: item.endTime,
		error: item.error,
	};
}

function transferMimeMatchesExpectation(mime: string, expected: string): boolean {
	const actual = mime.toLowerCase();
	return expected === "image" || expected === "media"
		? /^(image|video|audio)\//.test(actual)
		: actual === expected || actual.startsWith(expected);
}

function transferAnnotateMime(
	response: BrowserPilotBridgeResponse,
	msg: BrowserPilotBridgeCommand,
): BrowserPilotBridgeResponse {
	if (response.ok === false) return response;
	const data = responseData(response);
	const mode = String(data.mode || "");
	const expected =
		typeof msg.expectMime === "string" && msg.expectMime.trim()
			? msg.expectMime.trim().toLowerCase()
			: mode === "media"
				? "image"
				: "";
	const download = asRecord(data.download);
	const mime = typeof download.mime === "string" ? download.mime : "";
	if (expected && mime && !transferMimeMatchesExpectation(mime, expected)) {
		data.mimeMismatch = { expected, actual: mime };
	}
	return response;
}

function transferDownload(options: TransferDownloadOptions): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		try {
			chrome.downloads.download(options, (id) => {
				const err = chrome.runtime?.lastError;
				if (err) reject(new Error(err.message || String(err)));
				else resolve(Number(id));
			});
		} catch (error) {
			reject(error);
		}
	});
}

function transferSearchDownloads(query: JsonRecord): Promise<TransferDownloadSummary[]> {
	return new Promise<TransferDownloadSummary[]>((resolve) => {
		try {
			chrome.downloads.search(query || {}, (items) =>
				resolve(
					(items || [])
						.map(transferDownloadItem)
						.filter((item): item is TransferDownloadSummary => Boolean(item)),
				),
			);
		} catch (_) {
			resolve([]);
		}
	});
}

function transferSearchDownload(id: unknown): Promise<TransferDownloadSummary | null> {
	return transferSearchDownloads({ id: Number(id) }).then((items) => items[0] || null);
}

function transferDownloadTimeMs(value: unknown): number {
	const parsed = Date.parse(String(value || ""));
	return Number.isFinite(parsed) ? parsed : 0;
}

function transferDownloadStartedAfter(item: TransferDownloadSummary | null | undefined, startedAt: unknown): boolean {
	const itemStart = transferDownloadTimeMs(item && item.startTime);
	return !itemStart || itemStart >= Math.max(0, Number(startedAt || 0) - 2000);
}

function transferBlockedDownload(item: TransferDownloadSummary | null | undefined): Error | undefined {
	const danger = typeof item?.danger === "string" ? item.danger : "";
	if (!danger || DOWNLOAD_ALLOWED_DANGERS.has(danger) || DOWNLOAD_PENDING_DANGERS.has(danger)) return undefined;
	return Object.assign(new Error(`Chrome blocked download ${String(item?.id || "")}: ${danger}`), {
		code: "DOWNLOAD_BLOCKED_BY_BROWSER",
		details: { downloadId: item?.id, danger, url: item?.finalUrl || item?.url },
	});
}

function transferDownloadMatchesPageEvent(
	item: TransferDownloadSummary | null | undefined,
	event: TransferPageDownloadEvent | null | undefined,
	startedAt: unknown,
): boolean {
	if (!item) return false;
	if (!transferDownloadStartedAfter(item, startedAt)) return false;
	const eventUrl = String((event && event.url) || "");
	if (!eventUrl) return false;
	return String(item.url || "") === eventUrl || String(item.finalUrl || "") === eventUrl;
}

async function transferDownloadCandidatesSince(startedAt: unknown): Promise<TransferDownloadSummary[]> {
	const query = { startedAfter: new Date(Math.max(0, Number(startedAt || 0) - 2000)).toISOString() };
	return await transferSearchDownloads(query);
}

async function transferAmbiguousDownload(reason: unknown, details: JsonRecord): Promise<BrowserPilotBridgeResponse> {
	const code = BROWSER_PILOT_ERROR_CODES.AMBIGUOUS_DOWNLOAD || "AMBIGUOUS_DOWNLOAD";
	return browserPilotError(
		code,
		"Click download could not be matched to a tab-scoped download event: " + reason,
		details || {},
	);
}

function transferWaitDownloadComplete(id: unknown, timeoutMs: number): Promise<TransferDownloadSummary> {
	return new Promise<TransferDownloadSummary>((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			clearTimeout(timer);
			try {
				chrome.downloads.onChanged.removeListener(onChanged);
			} catch (_error) {
				/* best-effort download change listener cleanup */
			}
		};
		const finishFromSearch = async () => {
			const item = await transferSearchDownload(id);
			const blocked = transferBlockedDownload(item);
			if (blocked) {
				cleanup();
				reject(blocked);
				return true;
			}
			if (item && item.state === "complete") {
				cleanup();
				resolve(item);
				return true;
			}
			if (item && item.state === "interrupted") {
				cleanup();
				reject(new Error("Download " + id + " failed: " + (item.error || "interrupted")));
				return true;
			}
			return false;
		};
		const onChanged = (delta: JsonRecord & { id?: number; state?: { current?: string }; filename?: unknown }) => {
			if (!delta || Number(delta.id) !== Number(id)) return;
			if (delta.state && (delta.state.current === "complete" || delta.state.current === "interrupted")) {
				void finishFromSearch();
			} else if (delta.filename || delta.danger) {
				void finishFromSearch();
			}
		};
		const tick = async () => {
			if (await finishFromSearch()) return;
			if (Date.now() >= deadline) {
				cleanup();
				reject(new Error("Timed out after " + timeoutMs + "ms waiting for download " + id));
				return;
			}
			timer = setTimeout(() => {
				void tick();
			}, 250);
		};
		chrome.downloads.onChanged.addListener(onChanged);
		tick().catch((error) => {
			cleanup();
			reject(error);
		});
	});
}

function transferWaitPageDownloadBegin(tabId: number, timeoutMs: number): Promise<TransferPageDownloadEvent> {
	return new Promise<TransferPageDownloadEvent>((resolve, reject) => {
		if (typeof subscribeBrowserPilotCdp !== "function") {
			reject(new Error("CDP event subscription is unavailable"));
			return;
		}
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("Timed out after " + timeoutMs + "ms waiting for tab download event"));
		}, timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			if (subscriptionId && typeof unsubscribeBrowserPilotCdp === "function")
				unsubscribeBrowserPilotCdp(subscriptionId);
		};
		const subscriptionId = subscribeBrowserPilotCdp(
			tabId,
			["Page.downloadWillBegin", "Browser.downloadWillBegin"],
			(_source, method, params) => {
				cleanup();
				resolve({
					method,
					url: params.url ? String(params.url) : "",
					suggestedFilename: params.suggestedFilename ? String(params.suggestedFilename) : "",
					guid: params.guid ? String(params.guid) : "",
					frameId: params.frameId,
				});
			},
			{ waitId: "transfer-download", kind: "download", cdpSubscriptions: [] },
		);
		if (!subscriptionId) {
			cleanup();
			reject(new Error("CDP event subscription is unavailable"));
		}
	});
}

function transferWaitDownloadForPageEvent(
	event: TransferPageDownloadEvent,
	startedAt: unknown,
	timeoutMs: number,
): Promise<TransferDownloadSummary> {
	return new Promise<TransferDownloadSummary>((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => clearTimeout(timer);
		const tick = async () => {
			const query: JsonRecord = {
				startedAfter: new Date(Math.max(0, Number(startedAt || 0) - 2000)).toISOString(),
			};
			if (event && event.url) query.url = String(event.url);
			const items = (await transferSearchDownloads(query)).filter((item) =>
				transferDownloadMatchesPageEvent(item, event, startedAt),
			);
			items.sort((a, b) => transferDownloadTimeMs(b.startTime) - transferDownloadTimeMs(a.startTime));
			const item = items[0];
			if (item && item.state === "complete") {
				cleanup();
				resolve(item);
				return;
			}
			if (item && item.state === "interrupted") {
				cleanup();
				reject(new Error("Download " + item.id + " failed: " + (item.error || "interrupted")));
				return;
			}
			if (item && item.id != null) {
				try {
					const completed = await transferWaitDownloadComplete(item.id, Math.max(100, deadline - Date.now()));
					cleanup();
					resolve(completed);
					return;
				} catch (error) {
					cleanup();
					reject(error);
					return;
				}
			}
			if (Date.now() >= deadline) {
				cleanup();
				reject(
					new Error(
						"Timed out after " + timeoutMs + "ms waiting for tab download " + ((event && event.url) || ""),
					),
				);
				return;
			}
			timer = setTimeout(() => {
				void tick();
			}, 250);
		};
		tick().catch((error) => {
			cleanup();
			reject(error);
		});
	});
}

async function transferEvaluate(
	tabId: number,
	expression: string,
	timeoutMs: number,
): Promise<BrowserPilotBridgeResponse> {
	const cdp = browserPilotPersistentCdp();
	if (!cdp?.send)
		return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, "persistent CDP helper is not loaded", {
			tabId,
		});
	const resp = normalizePersistentBrowserPilotResponse(
		await cdp.send(
			tabId,
			"Runtime.evaluate",
			{
				expression: String(expression || ""),
				awaitPromise: true,
				returnByValue: true,
				userGesture: true,
			},
			{ persistent: true, name: "transfer", timeoutMs },
		),
	);
	if (!resp || resp.ok === false) return resp;
	const data = asRecord(resp.data);
	const result = asRecord(data.result || resp.result || resp.data);
	const exceptionDetails = asRecord(result.exceptionDetails);
	if (result.exceptionDetails) {
		// Recover the structured selector error code from the in-page exception (Runtime.evaluate drops
		// the thrown Error's custom .code) and strip the JS stack so callers see a clean SELECTOR_NOT_FOUND
		// / INVALID_SELECTOR instead of an opaque execution error with a stack trace.
		const rawDesc = String(
			asRecord(exceptionDetails.exception).description ||
				asRecord(exceptionDetails.exception).value ||
				"Runtime.evaluate failed",
		);
		const message = rawDesc.split("\n")[0].replace(/^[A-Za-z]*Error:\s*/, "");
		const code = message.includes("No element matches selector")
			? BROWSER_PILOT_ERROR_CODES.SELECTOR_NOT_FOUND
			: message.includes("Invalid selector")
				? BROWSER_PILOT_ERROR_CODES.INVALID_SELECTOR
				: BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR;
		return browserPilotError(code, message, exceptionDetails);
	}
	return { ok: true, data: asRecord(asRecord(result.result).value) as TransferEvalData };
}

function transferClickScript(selector: unknown, index: unknown): string {
	const numericIndex = Number.isInteger(Number(index)) ? Number(index) : 0;
	return `(() => {
    const selector = ${JSON.stringify(String(selector || ""))};
    const index = ${numericIndex};
    let nodes;
    try { nodes = Array.from(document.querySelectorAll(selector)); }
    catch (error) { const e = new Error('Invalid selector: ' + selector); e.code = 'INVALID_SELECTOR'; e.details = { selector }; throw e; }
    if (!nodes.length) { const e = new Error('No element matches selector: ' + selector); e.code = 'ELEMENT_NOT_FOUND'; e.details = { selector }; throw e; }
    if (index < 0 || index >= nodes.length) { const e = new Error('Index out of range for selector: ' + selector); e.code = 'ELEMENT_INDEX_OUT_OF_RANGE'; e.details = { selector, index, totalMatches: nodes.length }; throw e; }
    const el = nodes[index];
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'nearest' });
    if (typeof el.click !== 'function') { const e = new Error('Matched element is not clickable'); e.code = 'ELEMENT_NOT_CLICKABLE'; e.details = { selector, index }; throw e; }
    el.click();
    return { clicked: true, tagName: el.tagName, type: el.getAttribute && el.getAttribute('type'), multiple: !!el.multiple, selector, index };
  })()`;
}

function transferClickDownloadUrlScript(selector: unknown, index: unknown, filename: unknown): string {
	const numericIndex = Number.isInteger(Number(index)) ? Number(index) : 0;
	return `(() => {
    const selector = ${JSON.stringify(String(selector || ""))};
    const index = ${numericIndex};
    const filename = ${JSON.stringify(filename || "")};
    let nodes;
    try { nodes = Array.from(document.querySelectorAll(selector)); }
    catch (error) { const e = new Error('Invalid selector: ' + selector); e.code = 'INVALID_SELECTOR'; e.details = { selector }; throw e; }
    if (!nodes.length) { const e = new Error('No element matches selector: ' + selector); e.code = 'ELEMENT_NOT_FOUND'; e.details = { selector }; throw e; }
    if (index < 0 || index >= nodes.length) { const e = new Error('Index out of range for selector: ' + selector); e.code = 'ELEMENT_INDEX_OUT_OF_RANGE'; e.details = { selector, index, totalMatches: nodes.length }; throw e; }
    const el = nodes[index];
    const candidates = [el];
    if (el.closest) candidates.push(el.closest('a[href], area[href]'));
    if (el.querySelector) candidates.push(el.querySelector('a[href], area[href], img[src], video[src], source[src]'));
    const get = (node, name) => typeof node?.[name] === 'string' ? node[name] : null;
    for (const node of candidates) {
      if (!node) continue;
      const rawHref = node.getAttribute?.('href');
      if (rawHref !== null && rawHref !== undefined) {
        const raw = String(rawHref).trim().toLowerCase();
        if (!raw || raw === '#' || raw.startsWith('#') || raw.startsWith('javascript:')) continue;
      }
      const href = get(node, 'href') || get(node, 'currentSrc') || get(node, 'src') || '';
      if (!href) continue;
      const a = document.createElement('a');
      a.href = href;
      return { href: a.href, suggestedFilename: filename || node.getAttribute?.('download') || a.href.split('/').pop().split('?')[0] || 'download', selector, index, sourceTag: node.tagName || null };
    }
    return { href: '', suggestedFilename: filename || 'download', selector, index, sourceTag: null };
  })()`;
}

function transferMediaUrlScript(selector: unknown, index: unknown, filename: unknown): string {
	const numericIndex = Number.isInteger(Number(index)) ? Number(index) : 0;
	return `(() => {
    const selector = ${JSON.stringify(String(selector || ""))};
    const index = ${numericIndex};
    const filename = ${JSON.stringify(filename || "")};
    let nodes;
    try { nodes = Array.from(document.querySelectorAll(selector)); }
    catch (error) { const e = new Error('Invalid selector: ' + selector); e.code = 'INVALID_SELECTOR'; e.details = { selector }; throw e; }
    if (!nodes.length) { const e = new Error('No element matches selector: ' + selector); e.code = 'ELEMENT_NOT_FOUND'; e.details = { selector }; throw e; }
    if (index < 0 || index >= nodes.length) { const e = new Error('Index out of range for selector: ' + selector); e.code = 'ELEMENT_INDEX_OUT_OF_RANGE'; e.details = { selector, index, totalMatches: nodes.length }; throw e; }
    const el = nodes[index];
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const media = (el.closest && el.closest('img, video, source, a[href]')) || (el.querySelector && el.querySelector('img, video, source, a[href]')) || el;
    const get = (node, name) => typeof node?.[name] === 'string' ? node[name] : null;
    const href = get(media, 'currentSrc') || get(media, 'src') || get(media, 'href') || '';
    if (!href) { const e = new Error('Matched element does not expose a downloadable media URL'); e.code = 'MEDIA_URL_NOT_FOUND'; e.details = { selector, index }; throw e; }
    const a = document.createElement('a');
    a.href = href;
    return { href: a.href, suggestedFilename: filename || a.href.split('/').pop().split('?')[0] || 'download', selector, index };
  })()`;
}

async function transferDownloadWithOptions(
	options: TransferDownloadOptions,
	timeoutMs: number,
	mode: TransferDownloadMode,
	trigger: unknown,
): Promise<BrowserPilotBridgeResponse> {
	if (!chrome.downloads?.download)
		return browserPilotError(
			BROWSER_PILOT_ERROR_CODES.UNSUPPORTED_TARGET,
			"chrome.downloads API is unavailable; reload the bridge extension after granting downloads permission",
			{},
		);
	const id = await transferDownload(options);
	let item: TransferDownloadSummary;
	try {
		item = await transferWaitDownloadComplete(id, timeoutMs);
	} catch (error) {
		const record = errorRecord(error);
		if (record.code === "DOWNLOAD_BLOCKED_BY_BROWSER")
			return browserPilotError(
				"DOWNLOAD_BLOCKED_BY_BROWSER",
				record.message || "Chrome blocked the download",
				asRecord(record.details),
			);
		throw error;
	}
	return {
		ok: true,
		data: { mode, trigger: trigger || null, download: item, downloadId: item.id, path: item.path || null },
	};
}

function transferDownloadOptions(
	msg: BrowserPilotBridgeCommand,
	url: string,
	suggestedFilename?: unknown,
): TransferDownloadOptions {
	const options: TransferDownloadOptions = { url, saveAs: msg.saveAs === true };
	const explicitFilename = typeof msg.filename === "string" && msg.filename.trim() ? msg.filename.trim() : undefined;
	const filename = explicitFilename || (typeof suggestedFilename === "string" ? suggestedFilename.trim() : "");
	if (filename) options.filename = filename;
	if (typeof msg.conflictAction === "string" && ["uniquify", "overwrite", "prompt"].includes(msg.conflictAction))
		options.conflictAction = msg.conflictAction;
	return options;
}

function transferEvaluationError(error: unknown, selector: string): BrowserPilotBridgeResponse {
	const record = errorRecord(error);
	return {
		ok: false,
		error_code: String(record.code || BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR),
		error: errorText(error),
		details: asRecord(record.details || { selector }),
	};
}

async function transferEvaluateSelector(
	tabId: number,
	expression: string,
	timeoutMs: number,
	selector: string,
): Promise<BrowserPilotBridgeResponse> {
	try {
		return await transferEvaluate(tabId, expression, Math.min(timeoutMs, 10000));
	} catch (error) {
		return transferEvaluationError(error, selector);
	}
}

async function transferDownloadUrl(
	msg: BrowserPilotBridgeCommand,
	timeoutMs: number,
): Promise<BrowserPilotBridgeResponse> {
	const modeCheck = transferNormalizeDownloadMode(msg, "url");
	if (modeCheck.ok === false) return modeCheck;
	if (!transferIsHttpUrl(msg.url))
		return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, "transfer.download url must be http(s)", {
			url: msg.url,
		});
	return await transferDownloadWithOptions(transferDownloadOptions(msg, String(msg.url)), timeoutMs, "url", null);
}

async function transferDownloadMedia(
	tabId: number,
	msg: BrowserPilotBridgeCommand,
	selector: string,
	timeoutMs: number,
): Promise<BrowserPilotBridgeResponse> {
	const extracted = await transferEvaluateSelector(
		tabId,
		transferMediaUrlScript(selector, msg.index, msg.filename),
		timeoutMs,
		selector,
	);
	if (extracted.ok === false) return extracted;
	const data = responseData(extracted) as TransferEvalData;
	if (!data.href)
		return browserPilotError(
			BROWSER_PILOT_ERROR_CODES.INVALID_RULE,
			"Matched element does not expose a downloadable media URL",
			{ selector },
		);
	return await transferDownloadWithOptions(
		transferDownloadOptions(msg, String(data.href), data.suggestedFilename),
		timeoutMs,
		"media",
		data || null,
	);
}

async function transferAmbiguousClick(
	reason: unknown,
	startedAt: number,
	details: JsonRecord,
): Promise<BrowserPilotBridgeResponse> {
	const candidates = await transferDownloadCandidatesSince(startedAt);
	return await transferAmbiguousDownload(reason, {
		...details,
		candidate_count: candidates.length,
		candidate_ids: candidates.slice(0, 10).map((item) => item.id),
	});
}

async function transferMatchPageDownload(
	begin: TransferPageDownloadEvent,
	startedAt: number,
	timeoutMs: number,
	details: JsonRecord,
): Promise<BrowserPilotBridgeResponse> {
	if (begin.pageDownloadError)
		return await transferAmbiguousClick(begin.pageDownloadError, startedAt, {
			...details,
			pageDownloadError: begin.pageDownloadError,
		});
	if (!begin.url)
		return await transferAmbiguousClick("tab download event did not include a URL", startedAt, {
			...details,
			downloadEvent: begin,
		});
	try {
		const item = await transferWaitDownloadForPageEvent(begin, startedAt, timeoutMs);
		return {
			ok: true,
			data: {
				mode: "click",
				...details,
				downloadEvent: begin,
				matchStrategy: "tab-cdp-download-event",
				download: item,
				downloadId: item.id,
				path: item.path || null,
			},
		};
	} catch (error) {
		return await transferAmbiguousClick(errorText(error), startedAt, { ...details, downloadEvent: begin });
	}
}

async function transferTriggerClick(
	tabId: number,
	msg: BrowserPilotBridgeCommand,
	selector: string,
	timeoutMs: number,
): Promise<BrowserPilotBridgeResponse> {
	const startedAt = Date.now();
	const cdp = browserPilotPersistentCdp();
	if (cdp?.send)
		await cdp
			.send(
				tabId,
				"Page.enable",
				{},
				{ persistent: true, name: "transfer_download", timeoutMs: Math.min(timeoutMs, 10000) },
			)
			.catch(() => null);
	const pageDownload = transferWaitPageDownloadBegin(tabId, timeoutMs).catch(
		(error) => ({ pageDownloadError: errorText(error) }) as TransferPageDownloadEvent,
	);
	const triggered = await transferEvaluateSelector(
		tabId,
		transferClickScript(selector, msg.index),
		timeoutMs,
		selector,
	);
	if (triggered.ok === false) return triggered;
	return await transferMatchPageDownload(await pageDownload, startedAt, timeoutMs, {
		selector,
		mode: "click",
		trigger: responseData(triggered) || null,
	});
}

async function transferDownloadClick(
	tabId: number,
	msg: BrowserPilotBridgeCommand,
	selector: string,
	timeoutMs: number,
): Promise<BrowserPilotBridgeResponse> {
	const extracted = await transferEvaluateSelector(
		tabId,
		transferClickDownloadUrlScript(selector, msg.index, msg.filename),
		timeoutMs,
		selector,
	);
	if (extracted.ok === false) return extracted;
	const data = responseData(extracted) as TransferEvalData;
	if (data.href && transferIsHttpUrl(data.href)) {
		return await transferDownloadWithOptions(
			transferDownloadOptions(msg, String(data.href), data.suggestedFilename),
			timeoutMs,
			"click",
			{ ...data, directUrl: true },
		);
	}
	return await transferTriggerClick(tabId, msg, selector, timeoutMs);
}

async function transferDownloadFromPage(
	tabId: number,
	msg: BrowserPilotBridgeCommand,
	timeoutMs: number,
): Promise<BrowserPilotBridgeResponse> {
	if (!chrome.downloads?.onCreated)
		return browserPilotError(
			BROWSER_PILOT_ERROR_CODES.UNSUPPORTED_TARGET,
			"chrome.downloads API is unavailable; reload the bridge extension after granting downloads permission",
			{},
		);
	const selector = String(msg.selector || "");
	if (!selector)
		return browserPilotError(
			BROWSER_PILOT_ERROR_CODES.INVALID_RULE,
			"transfer.download requires selector or url",
			{},
		);
	const modeCheck = transferNormalizeDownloadMode(msg, "selector");
	if (modeCheck.ok === false) return modeCheck;
	if (!("mode" in modeCheck)) return modeCheck;
	return modeCheck.mode === "media"
		? await transferDownloadMedia(tabId, msg, selector, timeoutMs)
		: await transferDownloadClick(tabId, msg, selector, timeoutMs);
}

async function handleBrowserPilotTransferDownload(
	tabId: number,
	msg: BrowserPilotBridgeCommand,
): Promise<BrowserPilotBridgeResponse> {
	const timeoutMs = transferTimeoutMs(msg, 30000);
	const response = msg.url
		? await transferDownloadUrl(msg, timeoutMs)
		: await transferDownloadFromPage(tabId, msg, timeoutMs);
	return transferAnnotateMime(response, msg);
}

function transferFiles(msg: BrowserPilotBridgeCommand): string[] {
	const raw = Array.isArray(msg.files) ? msg.files : typeof msg.file === "string" ? [msg.file] : [];
	return raw.map((file: unknown) => String(file || "")).filter(Boolean);
}

function transferFileChooserEvent(
	tabId: number,
	timeoutMs: number,
): Promise<JsonRecord & { backendNodeId?: number; mode?: string }> {
	return new Promise<JsonRecord & { backendNodeId?: number; mode?: string }>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("Timed out after " + timeoutMs + "ms waiting for file chooser"));
		}, timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			if (subscriptionId) unsubscribeBrowserPilotCdp(subscriptionId);
		};
		const subscriptionId = subscribeBrowserPilotCdp(
			tabId,
			"Page.fileChooserOpened",
			(_source, _method, params) => {
				cleanup();
				resolve(asRecord(params));
			},
			{ waitId: "transfer-upload", kind: "upload", cdpSubscriptions: [] },
		);
	});
}

async function transferEnableFileChooser(
	cdp: TransferCdpBridge,
	tabId: number,
	timeoutMs: number,
): Promise<BrowserPilotBridgeResponse | undefined> {
	const options = { persistent: true, name: "transfer_upload", timeoutMs: Math.min(timeoutMs, 10000) };
	const pageEnabled = normalizePersistentBrowserPilotResponse(await cdp.send(tabId, "Page.enable", {}, options));
	if (pageEnabled.ok === false) return pageEnabled;
	const intercept = normalizePersistentBrowserPilotResponse(
		await cdp.send(tabId, "Page.setInterceptFileChooserDialog", { enabled: true }, options),
	);
	return intercept.ok === false ? intercept : undefined;
}

function transferUploadError(error: unknown, selector: string, fileCount: number): BrowserPilotBridgeResponse {
	const record = errorRecord(error);
	return errorText(error).includes("Not allowed")
		? browserPilotError(BROWSER_PILOT_ERROR_CODES.SAFETY_BLOCKED, BROWSER_PILOT_FILE_ACCESS_MESSAGE, {
				selector,
				files_count: fileCount,
			})
		: browserPilotError(
				String(record.code || BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR),
				record.message || errorText(error),
				asRecord(record.details || { selector, files_count: fileCount }),
			);
}

async function transferCompleteUpload(
	cdp: TransferCdpBridge,
	tabId: number,
	msg: BrowserPilotBridgeCommand,
	selector: string,
	files: string[],
	chooser: JsonRecord & { backendNodeId?: number; mode?: string },
	clicked: BrowserPilotBridgeResponse,
	timeoutMs: number,
): Promise<BrowserPilotBridgeResponse> {
	const backendNodeId = Number(chooser.backendNodeId);
	if (!Number.isInteger(backendNodeId) || backendNodeId <= 0)
		return browserPilotError(
			BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR,
			"File chooser event did not include backendNodeId",
			{ chooser },
		);
	const isMultiple = chooser.mode === "selectMultiple";
	if (!isMultiple && files.length > 1)
		return browserPilotError(
			BROWSER_PILOT_ERROR_CODES.INVALID_RULE,
			"File chooser does not accept multiple files",
			{ selector, files_count: files.length },
		);
	const response = normalizePersistentBrowserPilotResponse(
		await cdp.send(
			tabId,
			"DOM.setFileInputFiles",
			{ backendNodeId, files },
			{ persistent: true, name: "transfer_upload", timeoutMs },
		),
	);
	if (response.ok === false) {
		const message = asRecord(response.error).message || response.message || "";
		return String(message).includes("Not allowed")
			? browserPilotError(BROWSER_PILOT_ERROR_CODES.SAFETY_BLOCKED, BROWSER_PILOT_FILE_ACCESS_MESSAGE, {
					selector,
					files_count: files.length,
				})
			: response;
	}
	return {
		ok: true,
		data: {
			selector,
			index: Number.isInteger(Number(msg.index)) ? Number(msg.index) : 0,
			files_count: files.length,
			isMultiple,
			mode: chooser.mode || null,
			uploaded: true,
			trigger: clicked.data || null,
		},
	};
}

async function handleBrowserPilotTransferUpload(
	tabId: number,
	msg: BrowserPilotBridgeCommand,
): Promise<BrowserPilotBridgeResponse> {
	const files = transferFiles(msg);
	if (!files.length)
		return browserPilotError(
			BROWSER_PILOT_ERROR_CODES.INVALID_RULE,
			"transfer.upload requires at least one file",
			{},
		);
	const selector = String(msg.selector || "");
	if (!selector)
		return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, "transfer.upload requires selector", {});
	const timeoutMs = transferTimeoutMs(msg, 30000);
	const cdp = browserPilotPersistentCdp();
	if (!cdp?.send)
		return browserPilotError(BROWSER_PILOT_ERROR_CODES.INTERNAL_ERROR, "persistent CDP helper is not loaded", {
			tabId,
		});
	const transferCdp = cdp as TransferCdpBridge;
	const setupError = await transferEnableFileChooser(transferCdp, tabId, timeoutMs);
	if (setupError) return setupError;
	const chooserPromise = transferFileChooserEvent(tabId, timeoutMs);
	try {
		const clicked = await transferEvaluate(
			tabId,
			transferClickScript(selector, msg.index),
			Math.min(timeoutMs, 10000),
		);
		if (!clicked || clicked.ok === false) {
			chooserPromise.catch(() => {});
			return clicked;
		}
		return await transferCompleteUpload(
			transferCdp,
			tabId,
			msg,
			selector,
			files,
			await chooserPromise,
			clicked,
			timeoutMs,
		);
	} catch (e) {
		return transferUploadError(e, selector, files.length);
	} finally {
		await cdp
			.send(
				tabId,
				"Page.setInterceptFileChooserDialog",
				{ enabled: false },
				{ persistent: true, name: "transfer_upload_cleanup", timeoutMs: 5000 },
			)
			.catch(() => {});
	}
}

async function handleBrowserPilotTransferCommand(
	cmd: string,
	tabId: number,
	msg: BrowserPilotBridgeCommand,
): Promise<BrowserPilotBridgeResponse> {
	if (cmd === "transfer.download") return await handleBrowserPilotTransferDownload(tabId, msg || {});
	if (cmd === "transfer.upload") return await handleBrowserPilotTransferUpload(tabId, msg || {});
	return browserPilotError(BROWSER_PILOT_ERROR_CODES.INVALID_RULE, "Unknown transfer command: " + cmd, { cmd });
}
export { handleBrowserPilotTransferCommand };
