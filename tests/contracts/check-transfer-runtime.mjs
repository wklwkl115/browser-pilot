import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { buildTransferDownloadCommand, buildTransferUploadCommand, checkedUploadFiles, rejectUnsafeExecuteCommand, requireDownloadTarget, requireUploadConfirmation } from "../../src/tools/transferValidation.ts";
import { summarizeTransferData } from "../../src/tools/summaries/transfer.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const transferSource = readFileSync(path.join(root, "bridge", "pi_browser_bridge", "transfer.js"), "utf8");

function assertErrorCode(error, code) {
	assert.equal(error?.code, code);
	return true;
}

async function testPiToolLayer() {
	const temp = await mkdtemp(path.join(os.tmpdir(), "pi-browser-transfer-"));
	try {
		const uploadFile = path.join(temp, "upload.txt");
		await writeFile(uploadFile, "upload payload", "utf8");
		assert.throws(() => requireUploadConfirmation(false, "#file"), (error) => assertErrorCode(error, "UPLOAD_CONFIRMATION_REQUIRED"), "upload must require explicit confirmation");
		assert.throws(() => rejectUnsafeExecuteCommand({ cmd: "transfer.upload" }), (error) => {
			assertErrorCode(error, "UPLOAD_REQUIRES_BROWSER_UPLOAD");
			assert.equal(Object.hasOwn(error, "stack"), false, "transfer validation errors must not carry stack traces into tool output");
			return true;
		}, "browser_execute must not bypass browser_upload validation");
		rejectUnsafeExecuteCommand({ cmd: "transfer.download" });
		rejectUnsafeExecuteCommand({ cmd: "persistent_cdp", action: "send", cdpMethod: "Input.insertText" });
		await assert.rejects(checkedUploadFiles(["relative.txt"]), (error) => assertErrorCode(error, "UPLOAD_PATH_NOT_ABSOLUTE"), "upload must reject relative paths");
		await assert.rejects(checkedUploadFiles([path.join(temp, "missing.txt")]), (error) => assertErrorCode(error, "UPLOAD_FILE_NOT_FOUND"), "upload must reject missing files before browser command");
		await assert.rejects(checkedUploadFiles([temp]), (error) => assertErrorCode(error, "UPLOAD_PATH_NOT_FILE"), "upload must reject directories");
		await assert.rejects(checkedUploadFiles(Array.from({ length: 51 }, (_, index) => path.join(temp, `f${index}.txt`))), (error) => assertErrorCode(error, "UPLOAD_FILES_LIMIT"), "upload must cap batch size before stat calls");
		const files = await checkedUploadFiles([uploadFile]);
		assert.deepEqual(files, [path.resolve(uploadFile)], "upload validation must resolve absolute file paths");
		requireUploadConfirmation(true, "#file");
		const uploadCommand = buildTransferUploadCommand("#file", files, 2);
		assert.deepEqual(uploadCommand, { cmd: "transfer.upload", selector: "#file", files, index: 2 }, "upload command shape must stay stable");
		assert.throws(() => requireDownloadTarget({}), (error) => assertErrorCode(error, "DOWNLOAD_TARGET_REQUIRED"), "download must require selector or url");
		requireDownloadTarget({ url: "https://example.test/file.txt" });
		requireDownloadTarget({ selector: "a[download]" });
		const directCommand = buildTransferDownloadCommand({ url: " https://example.test/file.txt ", filename: "file.txt", conflictAction: "overwrite", saveAs: false });
		assert.equal(directCommand.cmd, "transfer.download");
		assert.equal(directCommand.mode, "url");
		assert.equal(directCommand.url, "https://example.test/file.txt");
		assert.equal(directCommand.conflictAction, "overwrite");
		const selectorCommand = buildTransferDownloadCommand({ selector: " img.hero ", mode: "media", index: 1 });
		assert.equal(selectorCommand.selector, "img.hero");
		assert.equal(selectorCommand.mode, "media");
		assert.equal(selectorCommand.index, 1);
		const uploadSummary = summarizeTransferData({ uploaded: true, selector: "#file", files_count: 1, isMultiple: false });
		assert.equal(uploadSummary.items[0].uploaded, true, "upload summaries must expose compact upload status");
		const downloadSummary = summarizeTransferData({ downloadId: 12, path: "C:/Downloads/file.txt", download: { id: 12, state: "complete", path: "C:/Downloads/file.txt", url: "https://example.test/file.txt" } });
		assert.equal(downloadSummary.items[0].path, "C:/Downloads/file.txt", "download summaries must expose completed path");
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}

function createTransferRuntime({ cdpSend, downloadStart, downloadComplete, chooserMode = "selectSingle" } = {}) {
	const listeners = { created: new Set(), changed: new Set() };
	const subscriptions = new Map();
	const downloadItems = new Map();
	const downloadOptions = [];
	const cdpCalls = [];
	let nextSubscriptionId = 1;
	let nextDownloadId = 100;
	let runtimeLastError = null;
	function emitCreated(item) { for (const listener of Array.from(listeners.created)) listener(item); }
	function emitChanged(delta) { for (const listener of Array.from(listeners.changed)) listener(delta); }
	function completeDownload(id, patch = {}) {
		const item = downloadItems.get(Number(id));
		Object.assign(item, patch, { state: "complete", endTime: new Date().toISOString(), exists: true });
		emitChanged({ id: Number(id), state: { current: "complete" }, filename: { current: item.filename } });
	}
	const context = {
		console,
		setTimeout,
		clearTimeout,
		URL,
		PI_BROWSER_ERROR_CODES: {
			INVALID_RULE: "INVALID_RULE",
			UNSUPPORTED_TARGET: "UNSUPPORTED_TARGET",
			INTERNAL_ERROR: "INTERNAL_ERROR",
			SAFETY_BLOCKED: "SAFETY_BLOCKED",
			AMBIGUOUS_DOWNLOAD: "AMBIGUOUS_DOWNLOAD",
		},
		piBrowserError(code, message, details = {}) { return { ok: false, error_code: code, error: { code, message, details }, details }; },
		normalizePersistentPiBrowserResponse(resp) { return resp; },
		piBrowserPersistentCdp() {
			return {
				async send(tabId, method, params, options) {
					cdpCalls.push({ tabId, method, params, options });
					if (cdpSend) return await cdpSend({ tabId, method, params, options, cdpCalls, subscriptions, emitFileChooser });
					return { ok: true, data: { result: { result: { value: true } } } };
				},
			};
		},
		subscribePiBrowserCdp(tabId, event, handler) {
			const id = `sub-${nextSubscriptionId++}`;
			subscriptions.set(id, { tabId, event, handler });
			return id;
		},
		unsubscribePiBrowserCdp(id) { subscriptions.delete(id); return true; },
		chrome: {
			runtime: { get lastError() { return runtimeLastError; }, set lastError(value) { runtimeLastError = value; } },
			downloads: {
				download(options, callback) {
					downloadOptions.push(options);
					if (options.url === "https://example.test/fail.txt") { runtimeLastError = { message: "download denied" }; callback(undefined); runtimeLastError = null; return; }
					const id = nextDownloadId++;
					const item = downloadStart?.(id, options) || { id, url: options.url, finalUrl: options.url, filename: `C:/Downloads/${options.filename || "direct.txt"}`, state: "in_progress", bytesReceived: 0, totalBytes: 3, danger: "safe", exists: false };
					downloadItems.set(id, item);
					callback(id);
					setTimeout(() => {
						if (downloadComplete) downloadComplete({ id, item, completeDownload, emitCreated, emitChanged });
						else completeDownload(id, { bytesReceived: item.totalBytes || 3 });
					}, 0);
				},
				search(query, callback) {
					let items = Array.from(downloadItems.values());
					if (query.id !== undefined) items = [downloadItems.get(Number(query.id))].filter(Boolean);
					if (query.url) items = items.filter(item => item.url === query.url || item.finalUrl === query.url);
					if (query.startedAfter) {
						const min = Date.parse(query.startedAfter);
						items = items.filter(item => !item.startTime || Date.parse(item.startTime) >= min);
					}
					callback(items);
				},
				onCreated: { addListener(listener) { listeners.created.add(listener); }, removeListener(listener) { listeners.created.delete(listener); } },
				onChanged: { addListener(listener) { listeners.changed.add(listener); }, removeListener(listener) { listeners.changed.delete(listener); } },
			},
		},
	};
	function emitCdpEvent(method, params = {}) {
		for (const rec of Array.from(subscriptions.values())) {
			const events = Array.isArray(rec.event) ? rec.event : [rec.event];
			if (events.includes(method) || events.includes("*")) rec.handler({ tabId: rec.tabId }, method, params);
		}
	}
	function emitFileChooser(params = {}) {
		emitCdpEvent("Page.fileChooserOpened", { backendNodeId: 88, mode: chooserMode, ...params });
	}
	vm.createContext(context);
	vm.runInContext(transferSource, context, { filename: "transfer.js" });
	return { context, cdpCalls, downloadOptions, downloadItems, emitCreated, emitChanged, completeDownload, emitFileChooser, emitCdpEvent, subscriptions };
}

async function testBridgeDownloadRuntime() {
	let runtime = createTransferRuntime();
	let result = await runtime.context.handlePiBrowserTransferCommand("transfer.download", 1, { url: "https://example.test/direct.txt", filename: "direct.txt", conflictAction: "overwrite", timeoutMs: 1000 });
	assert.equal(result.ok, true);
	assert.equal(result.data.download.state, "complete");
	assert.equal(result.data.path, "C:/Downloads/direct.txt");
	assert.equal(runtime.downloadOptions[0].conflictAction, "overwrite");

	runtime = createTransferRuntime();
	result = await runtime.context.handlePiBrowserTransferCommand("transfer.download", 1, { url: "file:///tmp/nope", timeoutMs: 1000 });
	assert.equal(result.error_code, "INVALID_RULE", "direct downloads must reject non-http URLs");

	runtime = createTransferRuntime({
		cdpSend: async ({ method, params }) => {
			if (method === "Runtime.evaluate" && params.expression.includes("sourceTag")) return { ok: true, data: { result: { result: { value: { href: "", selector: "#download" } } } } };
			if (method === "Runtime.evaluate") {
				setTimeout(() => {
					const item = { id: 201, url: "blob:https://example.test/blob", finalUrl: "blob:https://example.test/blob", filename: "C:/Downloads/click.txt", state: "in_progress", bytesReceived: 0, totalBytes: 5, danger: "safe", exists: false };
					runtime.downloadItems.set(201, item);
					runtime.emitCreated(item);
					setTimeout(() => runtime.completeDownload(201, { bytesReceived: 5 }), 0);
				}, 0);
				return { ok: true, data: { result: { result: { value: { clicked: true, selector: "#download" } } } } };
			}
			return { ok: true, data: {} };
		},
	});
	result = await runtime.context.handlePiBrowserTransferCommand("transfer.download", 2, { selector: "#download", timeoutMs: 1000 });
	assert.equal(result.error_code, "AMBIGUOUS_DOWNLOAD", "click downloads must reject global download fallback without a tab-scoped CDP event");
	assert.equal(result.details.candidate_count, 1, "ambiguous click downloads should report candidate count without selecting another tab's download");

	runtime = createTransferRuntime({
		cdpSend: async ({ method, params }) => {
			if (method === "Page.enable") return { ok: true, data: {} };
			if (method === "Runtime.evaluate" && params.expression.includes("sourceTag")) return { ok: true, data: { result: { result: { value: { href: "", selector: "#download" } } } } };
			if (method === "Runtime.evaluate") {
				setTimeout(() => {
					const item = { id: 301, url: "blob:https://example.test/tab", finalUrl: "blob:https://example.test/tab", filename: "C:/Downloads/tab.txt", state: "in_progress", startTime: new Date().toISOString(), bytesReceived: 0, totalBytes: 4, danger: "safe", exists: false };
					runtime.downloadItems.set(301, item);
					runtime.emitCdpEvent("Page.downloadWillBegin", { guid: "g-301", url: item.url, suggestedFilename: "tab.txt" });
					setTimeout(() => runtime.completeDownload(301, { bytesReceived: 4 }), 0);
				}, 0);
				return { ok: true, data: { result: { result: { value: { clicked: true, selector: "#download" } } } } };
			}
			return { ok: true, data: {} };
		},
	});
	result = await runtime.context.handlePiBrowserTransferCommand("transfer.download", 2, { selector: "#download", timeoutMs: 1000 });
	assert.equal(result.ok, true);
	assert.equal(result.data.matchStrategy, "tab-cdp-download-event", "click downloads must prefer tab-scoped CDP download events");
	assert.equal(result.data.downloadEvent.url, "blob:https://example.test/tab");
	assert.equal(result.data.downloadId, 301);

	runtime = createTransferRuntime({
		cdpSend: async ({ method, params }) => {
			if (method === "Runtime.evaluate") {
				assert.match(params.expression, /downloadable media URL/, "media mode must install media extraction script");
				setTimeout(() => {
					const item = { id: 202, url: "https://example.test/image.png", finalUrl: "https://example.test/image.png", filename: "C:/Downloads/image.png", state: "in_progress", bytesReceived: 0, totalBytes: 7, danger: "safe", exists: false };
					runtime.downloadItems.set(202, item);
					runtime.emitCreated(item);
					setTimeout(() => runtime.completeDownload(202, { bytesReceived: 7 }), 0);
				}, 0);
				return { ok: true, data: { result: { result: { value: { href: "https://example.test/image.png", suggestedFilename: "image.png" } } } } };
			}
			return { ok: true, data: {} };
		},
	});
	result = await runtime.context.handlePiBrowserTransferCommand("transfer.download", 3, { selector: "img.hero", mode: "media", timeoutMs: 1000 });
	assert.equal(result.ok, true);
	assert.equal(result.data.mode, "media");
	assert.equal(result.data.path, "C:/Downloads/image.png");
}

function uploadCdpSend({ mode = "selectMultiple", setFilesResponse = { ok: true, data: {} } } = {}) {
	return async ({ method, params, emitFileChooser }) => {
		if (method === "Page.enable") return { ok: true, data: {} };
		if (method === "Page.setInterceptFileChooserDialog") return { ok: true, data: { enabled: params.enabled } };
		if (method === "Runtime.evaluate") {
			setTimeout(() => emitFileChooser({ backendNodeId: 99, mode }), 0);
			return { ok: true, data: { result: { result: { value: { clicked: true, selector: "#file" } } } } };
		}
		if (method === "DOM.setFileInputFiles") return setFilesResponse;
		return { ok: true, data: {} };
	};
}

async function testBridgeUploadRuntime() {
	let runtime = createTransferRuntime({ cdpSend: uploadCdpSend({ mode: "selectMultiple" }) });
	let result = await runtime.context.handlePiBrowserTransferCommand("transfer.upload", 4, { selector: "#file", files: ["C:/tmp/a.txt", "C:/tmp/b.txt"], timeoutMs: 1000 });
	assert.equal(result.ok, true);
	assert.equal(result.data.uploaded, true);
	assert.equal(result.data.files_count, 2);
	assert.ok(runtime.cdpCalls.some(call => call.method === "DOM.setFileInputFiles" && call.params.backendNodeId === 99 && call.params.files.length === 2), "upload must set files on chooser backend node");
	assert.equal(runtime.cdpCalls.at(-1).method, "Page.setInterceptFileChooserDialog", "upload must cleanup file chooser interception");
	assert.equal(runtime.cdpCalls.at(-1).params.enabled, false);

	runtime = createTransferRuntime({ cdpSend: uploadCdpSend({ mode: "selectSingle" }) });
	result = await runtime.context.handlePiBrowserTransferCommand("transfer.upload", 4, { selector: "#file", files: ["C:/tmp/a.txt", "C:/tmp/b.txt"], timeoutMs: 1000 });
	assert.equal(result.error_code, "INVALID_RULE", "upload must reject multiple files for single chooser");
	assert.equal(runtime.cdpCalls.some(call => call.method === "DOM.setFileInputFiles"), false, "single chooser rejection must not set files");
	assert.equal(runtime.cdpCalls.at(-1).params.enabled, false, "single chooser rejection must cleanup interception");

	runtime = createTransferRuntime({ cdpSend: uploadCdpSend({ mode: "selectSingle", setFilesResponse: { ok: false, error: { message: "Not allowed" } } }) });
	result = await runtime.context.handlePiBrowserTransferCommand("transfer.upload", 5, { selector: "#file", files: ["C:/tmp/a.txt"], timeoutMs: 1000 });
	assert.equal(result.error_code, "SAFETY_BLOCKED", "upload must map Chrome file access denial to safety guidance");
	assert.match(result.error.message, /Allow access to file URLs/);
	assert.equal(runtime.cdpCalls.at(-1).params.enabled, false, "file access failure must cleanup interception");
}

await testPiToolLayer();
await testBridgeDownloadRuntime();
await testBridgeUploadRuntime();
console.log("transfer runtime contract ok");
