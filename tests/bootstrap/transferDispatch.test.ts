import test from "node:test";
import assert from "node:assert/strict";
import type { JsonRecord } from "../../src/bridge/extension/service_worker/types.ts";

type DownloadItem = JsonRecord & { id: number; url: string; finalUrl: string; filename: string; state: string; startTime: string };
type EvalPlan = { value?: JsonRecord; exception?: string; downloadEvent?: JsonRecord; downloadItem?: DownloadItem; fileChooser?: JsonRecord };

const debuggerListeners = new Set<(source: { tabId?: number }, method: string, params?: JsonRecord) => void>();
const downloadCreatedListeners = new Set<(item: DownloadItem) => void>();
const downloadChangedListeners = new Set<(delta: JsonRecord) => void>();
const downloads = new Map<number, DownloadItem>();
const downloadCalls: JsonRecord[] = [];
const cdpCalls: Array<{ tabId: number; method: string; params: JsonRecord; options: JsonRecord }> = [];
const evalPlans: EvalPlan[] = [];
let downloadId = 100;
let nextDownloadDanger = "safe";

function event<T extends (...args: never[]) => unknown>(listeners: Set<T>) {
	return {
		addListener(listener: T) { listeners.add(listener); },
		removeListener(listener: T) { listeners.delete(listener); },
	};
}

function completedDownload(id: number, url: string, filename = `C:\\Downloads\\file-${id}.bin`): DownloadItem {
	return { id, url, finalUrl: url, filename, state: "complete", mime: "application/octet-stream", bytesReceived: 12, totalBytes: 12, danger: "safe", exists: true, startTime: new Date().toISOString() };
}

function emitDebugger(tabId: number, method: string, params: JsonRecord): void {
	for (const listener of debuggerListeners) listener({ tabId }, method, params);
}

const chromeStub = {
	runtime: { id: "browser-pilot-transfer-test", lastError: undefined, getManifest: () => ({ version: "0.0.0" }) },
	debugger: {
		onEvent: event(debuggerListeners),
		onDetach: event(new Set<() => void>()),
		async attach() {},
		async detach() {},
		async sendCommand() { return {}; },
	},
	downloads: {
		download(options: JsonRecord, callback: (id?: number) => void) {
			downloadCalls.push({ ...options });
			const id = ++downloadId;
			const item = { ...completedDownload(id, String(options.url), typeof options.filename === "string" ? `C:\\Downloads\\${options.filename}` : undefined), danger: nextDownloadDanger };
			downloads.set(id, item);
			for (const listener of downloadCreatedListeners) listener(item);
			callback(id);
		},
		search(query: JsonRecord, callback: (items: DownloadItem[]) => void) {
			let items = Array.from(downloads.values());
			if (query.id !== undefined) items = items.filter((item) => item.id === Number(query.id));
			if (query.url !== undefined) items = items.filter((item) => item.url === String(query.url));
			callback(items);
		},
		onCreated: event(downloadCreatedListeners),
		onChanged: event(downloadChangedListeners),
	},
};

const cdpBridge = {
	async send(tabId: number, method: string, params: JsonRecord = {}, options: JsonRecord = {}) {
		cdpCalls.push({ tabId, method, params, options });
		if (method !== "Runtime.evaluate") return { ok: true, data: {} };
		const plan = evalPlans.shift() || { value: {} };
		if (plan.downloadItem) downloads.set(plan.downloadItem.id, plan.downloadItem);
		if (plan.downloadEvent) emitDebugger(tabId, "Page.downloadWillBegin", plan.downloadEvent);
		if (plan.fileChooser) emitDebugger(tabId, "Page.fileChooserOpened", plan.fileChooser);
		if (plan.exception) return { ok: true, data: { result: { exceptionDetails: { exception: { description: plan.exception } } } } };
		return { ok: true, data: { result: { result: { value: plan.value || {} } } } };
	},
};

Object.assign(globalThis, {
	chrome: chromeStub,
	self: globalThis,
	browserPilotPersistentCdpBridge: cdpBridge,
	BrowserPilotPersistentCdp: cdpBridge,
});

const transfer = await import("../../src/bridge/extension/service_worker/transfer.ts");

function reset(): void {
	downloads.clear();
	downloadCalls.length = 0;
	cdpCalls.length = 0;
	evalPlans.length = 0;
	downloadId = 100;
	nextDownloadDanger = "safe";
}

test("transfer download completes direct URL and selector media paths", async () => {
	reset();
	const direct = await transfer.handleBrowserPilotTransferCommand("transfer.download", 7, { url: "https://example.test/report.pdf", filename: "report.pdf", timeoutMs: 500 });
	assert.equal(direct.ok, true);
	assert.equal((direct.data as JsonRecord).mode, "url");
	assert.equal((direct.data as JsonRecord).path, "C:\\Downloads\\report.pdf");
	assert.deepEqual(downloadCalls[0], { url: "https://example.test/report.pdf", saveAs: false, filename: "report.pdf" });

	reset();
	evalPlans.push({ value: { href: "https://example.test/image.png", suggestedFilename: "image.png" } });
	const media = await transfer.handleBrowserPilotTransferCommand("transfer.download", 7, { selector: "img.hero", mode: "media", timeoutMs: 500 });
	assert.equal(media.ok, true);
	assert.equal((media.data as JsonRecord).mode, "media");
	assert.deepEqual((media.data as JsonRecord).mimeMismatch, { expected: "image", actual: "application/octet-stream" });
	assert.equal(downloadCalls[0]?.url, "https://example.test/image.png");
	assert.equal(downloadCalls[0]?.filename, "image.png");
});

test("transfer click uses extracted HTTP URL without arming a page-event wait", async () => {
	reset();
	evalPlans.push({ value: { href: "https://example.test/archive.zip", suggestedFilename: "archive.zip" } });
	const result = await transfer.handleBrowserPilotTransferCommand("transfer.download", 7, { selector: "a.download", mode: "click", timeoutMs: 500 });
	assert.equal(result.ok, true);
	assert.equal((result.data as JsonRecord).mode, "click");
	assert.equal(((result.data as JsonRecord).trigger as JsonRecord).directUrl, true);
	assert.equal(debuggerListeners.size, 0);
	assert.equal(cdpCalls.filter((call) => call.method === "Runtime.evaluate").length, 1);
});

test("transfer download fails immediately when Chrome requires confirmation", async () => {
	reset();
	nextDownloadDanger = "uncommon";
	const result = await transfer.handleBrowserPilotTransferCommand("transfer.download", 7, { url: "https://example.test/uncommon.exe", timeoutMs: 500 });
	assert.equal(result.ok, false);
	assert.equal(result.error_code, "DOWNLOAD_BLOCKED_BY_BROWSER");
	assert.equal((result.details as JsonRecord).danger, "uncommon");
});

test("transfer click matches the tab CDP event to a completed Chrome download", async () => {
	reset();
	const item = completedDownload(240, "https://example.test/generated.csv", "C:\\Downloads\\generated.csv");
	evalPlans.push(
		{ value: { href: "", suggestedFilename: "download" } },
		{ value: { clicked: true, selector: "button.export", index: 0 }, downloadItem: item, downloadEvent: { url: item.url, guid: "guid-240", suggestedFilename: "generated.csv" } },
	);
	const result = await transfer.handleBrowserPilotTransferCommand("transfer.download", 7, { selector: "button.export", timeoutMs: 500 });
	assert.equal(result.ok, true);
	assert.equal((result.data as JsonRecord).matchStrategy, "tab-cdp-download-event");
	assert.equal((result.data as JsonRecord).downloadId, 240);
	assert.equal((result.data as JsonRecord).path, "C:\\Downloads\\generated.csv");
	assert.equal(debuggerListeners.size, 0);
});

test("transfer download preserves selector errors and ambiguous URL-less page events", async () => {
	reset();
	evalPlans.push({ exception: "Error: Invalid selector: [" });
	const invalid = await transfer.handleBrowserPilotTransferCommand("transfer.download", 7, { selector: "[", timeoutMs: 500 });
	assert.equal(invalid.ok, false);
	assert.equal(invalid.error_code, "INVALID_SELECTOR");

	reset();
	const candidate = completedDownload(250, "https://example.test/candidate.bin");
	evalPlans.push(
		{ value: { href: "" } },
		{ value: { clicked: true }, downloadItem: candidate, downloadEvent: { guid: "guid-250", suggestedFilename: "candidate.bin" } },
	);
	const ambiguous = await transfer.handleBrowserPilotTransferCommand("transfer.download", 7, { selector: "button.download", timeoutMs: 500 });
	assert.equal(ambiguous.ok, false);
	assert.equal(ambiguous.error_code, "AMBIGUOUS_DOWNLOAD");
	assert.equal((ambiguous.details as JsonRecord).candidate_count, 1);
	assert.deepEqual((ambiguous.details as JsonRecord).candidate_ids, [250]);
	assert.equal(debuggerListeners.size, 0);
});

test("transfer upload binds the chooser backend node and always disables interception", async () => {
	reset();
	evalPlans.push({ value: { clicked: true, selector: "input[type=file]", index: 0 }, fileChooser: { backendNodeId: 55, mode: "selectMultiple" } });
	const result = await transfer.handleBrowserPilotTransferCommand("transfer.upload", 7, { selector: "input[type=file]", files: ["C:\\fixtures\\a.txt", "C:\\fixtures\\b.txt"], timeoutMs: 500 });
	assert.equal(result.ok, true);
	assert.deepEqual(result.data, {
		selector: "input[type=file]",
		index: 0,
		files_count: 2,
		isMultiple: true,
		mode: "selectMultiple",
		uploaded: true,
		trigger: { clicked: true, selector: "input[type=file]", index: 0 },
	});
	const setFiles = cdpCalls.find((call) => call.method === "DOM.setFileInputFiles");
	assert.deepEqual(setFiles?.params, { backendNodeId: 55, files: ["C:\\fixtures\\a.txt", "C:\\fixtures\\b.txt"] });
	assert.deepEqual(cdpCalls.filter((call) => call.method === "Page.setInterceptFileChooserDialog").map((call) => call.params.enabled), [true, false]);
	assert.equal(debuggerListeners.size, 0);
});
