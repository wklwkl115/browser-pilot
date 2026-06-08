import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { clearResourceStore, REF_STORE_MAX_ENTRIES, RESOURCE_STORE_MAX_ENTRIES, registerBrowserResultResource, registerRefDescriptor } from "../../../src/resources/resourceStore.ts";
import { readBrowserResultResource } from "../../../src/resources/resourceReader.ts";

test("browser-result resource search mode accepts canonical query parameter", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "browser-resource-query-"));
	const artifactPath = path.join(dir, "artifact.txt");
	await writeFile(artifactPath, "alpha\nneedle line\nomega\n", "utf8");
	const uri = registerBrowserResultResource({
		kind: "raw-result",
		artifactPath,
		name: "searchable artifact",
		mime: "text/plain",
	});

	const result = await readBrowserResultResource(`${uri}?mode=search&query=needle&contextLines=0`);

	assert.equal(result.ok, true);
	assert.match(result.ok ? result.content.text : result.error, /needle line/);
	assert.doesNotMatch(result.ok ? result.content.text : result.error, /alpha|omega/);
	clearResourceStore();
});

test("browser-result resource search mode keeps legacy search alias", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "browser-resource-search-"));
	const artifactPath = path.join(dir, "artifact.txt");
	await writeFile(artifactPath, "alpha\nlegacy line\nomega\n", "utf8");
	const uri = registerBrowserResultResource({
		kind: "raw-result",
		artifactPath,
		name: "searchable artifact",
		mime: "text/plain",
	});

	const result = await readBrowserResultResource(`${uri}?mode=search&search=legacy&contextLines=0`);

	assert.equal(result.ok, true);
	assert.match(result.ok ? result.content.text : result.error, /legacy line/);
	assert.doesNotMatch(result.ok ? result.content.text : result.error, /alpha|omega/);
	clearResourceStore();
});

test("browser-result resource reads pass artifact window controls through query params", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "browser-resource-window-"));
	const artifactPath = path.join(dir, "artifact.txt");
	await writeFile(artifactPath, "0123456789abcdef\n", "utf8");
	const uri = registerBrowserResultResource({
		kind: "raw-result",
		artifactPath,
		name: "windowed artifact",
		mime: "text/plain",
	});

	const result = await readBrowserResultResource(`${uri}?mode=text&offset=1&limit=1&columnOffset=4&columnLimit=4`);

	assert.equal(result.ok, true);
	assert.match(result.ok ? result.content.text : result.error, /1: 4567/);
	assert.doesNotMatch(result.ok ? result.content.text : result.error, /0123|89ab/);
	clearResourceStore();
});

test("browser-result resource query parameter promotes whole resources to search mode", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "browser-resource-query-promote-"));
	const artifactPath = path.join(dir, "artifact.txt");
	await writeFile(artifactPath, "alpha\npromoted search line\nomega\n", "utf8");
	const uri = registerBrowserResultResource({
		kind: "raw-result",
		artifactPath,
		name: "searchable artifact",
		mime: "text/plain",
	});

	const result = await readBrowserResultResource(`${uri}?query=promoted`);

	assert.equal(result.ok, true);
	assert.match(result.ok ? result.content.text : result.error, /promoted search line/);
	clearResourceStore();
});

test("pi-ref resource reads preserve explicit jsonPath over backing browser-result resource", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "browser-resource-piref-backed-"));
	const artifactPath = path.join(dir, "artifact.json");
	await writeFile(artifactPath, JSON.stringify({ data: { items: ["alpha", "beta"] } }), "utf8");
	const resourceUri = registerBrowserResultResource({
		kind: "raw-result",
		artifactPath,
		name: "json artifact",
		mime: "application/json",
	});
	const ref = registerRefDescriptor({
		descriptor: {
			kind: "data-slice",
			locators: [],
			owner: {},
			policy: { redaction: "default", shareableAcrossSessions: true, liveActionsAllowed: false },
			snapshot: { observationId: "obs-json", resourceUri, jsonPath: "data.items[1]", immutable: true },
			observationId: "obs-json",
			createdAt: Date.now(),
			ttlMs: 60_000,
		},
		name: "json slice",
	});

	const result = await readBrowserResultResource(ref);

	assert.equal(result.ok, true);
	assert.equal(result.ok ? JSON.parse(result.content.text) : undefined, "beta");
	clearResourceStore();
});

test("pi-ref resource reads explicit artifact-backed data slices without browser-result URI", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "browser-resource-piref-direct-"));
	const artifactPath = path.join(dir, "artifact.json");
	await writeFile(artifactPath, JSON.stringify({ data: { token: "direct-slice" } }), "utf8");
	const ref = registerRefDescriptor({
		descriptor: {
			kind: "data-slice",
			locators: [],
			owner: {},
			policy: { redaction: "default", shareableAcrossSessions: true, liveActionsAllowed: false },
			snapshot: { observationId: "obs-direct", jsonPath: "data.token", immutable: true },
			observationId: "obs-direct",
			createdAt: Date.now(),
			ttlMs: 60_000,
		},
		artifactPath,
		resourceKind: "raw-result",
		name: "direct json slice",
	});

	const result = await readBrowserResultResource(ref);

	assert.equal(result.ok, true);
	assert.equal(result.ok ? JSON.parse(result.content.text) : undefined, "direct-slice");
	clearResourceStore();
});

test("browser-result resource read errors do not leak local artifact paths", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "browser-resource-missing-"));
	const artifactPath = path.join(dir, "missing-secret-artifact.txt");
	const uri = registerBrowserResultResource({
		kind: "raw-result",
		artifactPath,
		name: "missing artifact",
		mime: "text/plain",
	});

	const result = await readBrowserResultResource(`${uri}?mode=text`);

	assert.equal(result.ok, false);
	assert.equal(result.ok ? undefined : result.code, "RESOURCE_READ_ERROR");
	assert.doesNotMatch(result.ok ? "" : result.error, new RegExp(artifactPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(result.ok ? "" : result.error, /missing-secret-artifact/);
	clearResourceStore();
});

test("browser-result stale resource reads return a stable recapture code without local paths", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "browser-resource-stale-"));
	const artifactPath = path.join(dir, "stale-secret-artifact.txt");
	await writeFile(artifactPath, "original\n", "utf8");
	const uri = registerBrowserResultResource({
		kind: "raw-result",
		artifactPath,
		name: "stale artifact",
		mime: "text/plain",
	});
	await writeFile(artifactPath, "rewritten\n", "utf8");

	const result = await readBrowserResultResource(`${uri}?mode=text`);

	assert.equal(result.ok, false);
	assert.equal(result.ok ? undefined : result.code, "RESOURCE_STALE");
	assert.match(result.ok ? "" : result.error, /Resource is stale/);
	assert.doesNotMatch(result.ok ? "" : result.error, new RegExp(artifactPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(result.ok ? "" : result.error, /stale-secret-artifact/);
	clearResourceStore();
});

test("pi-ref stale resource reads return RESOURCE_STALE without local paths", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "browser-resource-piref-stale-"));
	const artifactPath = path.join(dir, "piref-secret-artifact.json");
	await writeFile(artifactPath, JSON.stringify({ data: { token: "original" } }), "utf8");
	const ref = registerRefDescriptor({
		descriptor: {
			kind: "data-slice",
			locators: [],
			owner: {},
			policy: { redaction: "default", shareableAcrossSessions: true, liveActionsAllowed: false },
			snapshot: { observationId: "obs-stale", jsonPath: "data.token", immutable: true },
			observationId: "obs-stale",
			createdAt: Date.now(),
			ttlMs: 60_000,
		},
		artifactPath,
		resourceKind: "raw-result",
		name: "stale direct json slice",
	});
	await writeFile(artifactPath, JSON.stringify({ data: { token: "rewritten" } }), "utf8");

	const result = await readBrowserResultResource(ref);

	assert.equal(result.ok, false);
	assert.equal(result.ok ? undefined : result.code, "RESOURCE_STALE");
	assert.match(result.ok ? "" : result.error, /Resource is stale/);
	assert.doesNotMatch(result.ok ? "" : result.error, new RegExp(artifactPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(result.ok ? "" : result.error, /piref-secret-artifact/);
	clearResourceStore();
});

test("capacity-evicted browser-result resource reads fail without local paths", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "browser-resource-cap-"));
	const artifactPath = path.join(dir, "cap-secret-artifact.txt");
	await writeFile(artifactPath, "bounded\n", "utf8");
	const oldUri = registerBrowserResultResource({
		kind: "raw-result",
		artifactPath,
		name: "old bounded artifact",
		mime: "text/plain",
	});
	for (let i = 0; i < RESOURCE_STORE_MAX_ENTRIES; i += 1) {
		registerBrowserResultResource({
			kind: "raw-result",
			artifactPath,
			name: `bounded artifact ${i}`,
			mime: "text/plain",
		});
	}

	const result = await readBrowserResultResource(`${oldUri}?mode=text`);

	assert.equal(result.ok, false);
	assert.equal(result.ok ? undefined : result.code, "RESOURCE_NOT_FOUND");
	assert.doesNotMatch(result.ok ? "" : result.error, new RegExp(artifactPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(result.ok ? "" : result.error, /cap-secret-artifact/);
	clearResourceStore();
});

test("capacity-evicted pi-ref resource reads fail without local paths", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "browser-resource-piref-cap-"));
	const artifactPath = path.join(dir, "piref-cap-secret-artifact.json");
	await writeFile(artifactPath, JSON.stringify({ data: { value: "bounded" } }), "utf8");
	const capNow = Date.now();
	const oldRef = registerRefDescriptor({
		descriptor: {
			kind: "data-slice",
			locators: [],
			owner: {},
			policy: { redaction: "default", shareableAcrossSessions: true, liveActionsAllowed: false },
			snapshot: { observationId: "obs-cap-old", jsonPath: "data.value", immutable: true },
			observationId: "obs-cap-old",
			createdAt: capNow,
			ttlMs: 60_000_000,
		},
		artifactPath,
		resourceKind: "raw-result",
		name: "old bounded ref",
	});
	for (let i = 0; i < REF_STORE_MAX_ENTRIES; i += 1) {
		registerRefDescriptor({
			descriptor: {
				kind: "data-slice",
				locators: [],
				owner: {},
				policy: { redaction: "default", shareableAcrossSessions: true, liveActionsAllowed: false },
				snapshot: { observationId: `obs-cap-${i}`, jsonPath: "data.value", immutable: true },
				observationId: `obs-cap-${i}`,
				createdAt: capNow + 1 + i,
				ttlMs: 60_000_000,
			},
			artifactPath,
			resourceKind: "raw-result",
			name: `bounded ref ${i}`,
		});
	}

	const result = await readBrowserResultResource(oldRef);

	assert.equal(result.ok, false);
	assert.equal(result.ok ? undefined : result.code, "RESOURCE_NOT_FOUND");
	assert.doesNotMatch(result.ok ? "" : result.error, new RegExp(artifactPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.doesNotMatch(result.ok ? "" : result.error, /piref-cap-secret-artifact/);
	clearResourceStore();
});
