import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { stdlibPrelude } from "../../src/browser-command-runtime/executeStdlibPrelude.ts";
import { PAGE_REF_RUNTIME_SOURCE } from "../../src/browser-runtime/pageRefRuntimeSource.ts";

type FakeRect = { x: number; y: number; left: number; top: number; right: number; bottom: number; width: number; height: number };
type FakeElement = {
	nodeType: number;
	tagName: string;
	id: string;
	innerText: string;
	textContent: string;
	contains(node: unknown): boolean;
	getAttribute(name: string): string | null;
	getBoundingClientRect(): FakeRect;
};

function rect(left: number, top: number, width: number, height: number): FakeRect {
	return { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height };
}

function element(tagName: string, id: string, text: string, bounds: FakeRect, contains: (node: unknown) => boolean = () => false): FakeElement {
	return {
		nodeType: 1,
		tagName,
		id,
		innerText: text,
		textContent: text,
		contains,
		getAttribute(name: string) {
			return name === "id" ? id : null;
		},
		getBoundingClientRect() {
			return bounds;
		},
	};
}

function createContext() {
	const hidden = element("A", "hidden-link", "hidden", rect(400, 300, 40, 20));
	const visible = element("DIV", "visible-card", "visible card", rect(40, 30, 120, 60));
	const computed = new Map<unknown, Record<string, string>>([
		[hidden, { display: "none", visibility: "visible", opacity: "1", pointerEvents: "auto" }],
		[visible, { display: "block", visibility: "visible", opacity: "1", pointerEvents: "auto" }],
	]);
	const context = {
		console: { warn() {} },
		Date,
		Map,
		Math,
		Number,
		JSON,
		innerWidth: 800,
		innerHeight: 600,
		setTimeout,
		clearTimeout,
		XPathResult: { FIRST_ORDERED_NODE_TYPE: 0 },
		CSS: { escape: (value: string) => value },
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		document: {
			documentElement: { clientWidth: 800, clientHeight: 600 },
			querySelector(selector: string) {
				return selector === ".hidden-link" ? hidden : selector === ".visible-card" ? visible : null;
			},
			querySelectorAll(selector: string) {
				if (selector === ".hidden-link") return [hidden];
				if (selector === ".visible-card") return [visible];
				if (selector === ".duplicate") return [hidden, visible];
				return [];
			},
			evaluate() {
				return { singleNodeValue: null };
			},
			elementFromPoint(x: number, y: number) {
				return x >= 40 && y >= 30 ? visible : null;
			},
		},
		getComputedStyle(el: unknown) {
			return computed.get(el) ?? { display: "block", visibility: "visible", opacity: "1", pointerEvents: "auto" };
		},
		window: undefined as unknown,
		globalThis: undefined as unknown,
		__result: undefined as unknown,
		__bound: undefined as unknown,
		__namespace: undefined as unknown,
	};
	context.window = context;
	context.globalThis = context;
	return { context, visible };
}

test("browserPilot.resolve skips hidden locator matches when a later locator is visibly hittable", () => {
	const { context, visible } = createContext();
	const registry = {
		"bp-ref://control/1": {
			ok: true,
			fresh: true,
			descriptor: {
				refId: "bp-ref://control/1",
				locators: [
					{ by: "css", value: ".hidden-link" },
					{ by: "css", value: ".visible-card" },
				],
			},
		},
	};
	const script = `${stdlibPrelude(registry, { target: "bp-ref://control/1" })}\nglobalThis.__result = browserPilot.resolve("bp-ref://control/1"); globalThis.__bound = browserPilot.refs.target;`;
	vm.runInContext(script, vm.createContext(context));
	const result = context.__result as { el?: FakeElement; tried?: string[] };
	assert.equal(result.el, visible);
	assert.equal(context.__bound, visible);
	assert.deepEqual(Array.from(result.tried ?? []), ["css", "css"]);
});

test("browserPilot refs never resolve an element from stale coordinates", () => {
	const { context } = createContext();
	const ref = "bp-ref://control/point-only";
	const registry = { [ref]: { ok: true, fresh: true, descriptor: { refId: ref, locators: [{ by: "point", x: 90, y: 60 }] } } };
	vm.runInContext(`${stdlibPrelude(registry, { target: ref })}\nglobalThis.__bound = browserPilot.refs.target;`, vm.createContext(context));
	assert.equal(context.__bound, null);
});

test("browserPilot.resolve disambiguates repeated selectors with captured geometry", () => {
	const { context, visible } = createContext();
	const ref = "bp-ref://control/repeated";
	const registry = { [ref]: { ok: true, fresh: true, descriptor: { refId: ref, locators: [{ by: "css", value: ".duplicate" }], geometry: { point: { x: 100, y: 60 } } } } };
	vm.runInContext(`${stdlibPrelude(registry)}\nglobalThis.__result = browserPilot.resolve(${JSON.stringify(ref)});`, vm.createContext(context));
	assert.equal((context.__result as { el?: FakeElement }).el, visible);
});

test("browserPilot.resolve fails closed when repeated semantic candidates share the captured neighborhood", () => {
	const { context } = createContext();
	const first = element("BUTTON", "save-1", "Save", rect(40, 30, 120, 40));
	const second = element("BUTTON", "save-2", "Save", rect(120, 30, 120, 40));
	context.document.querySelectorAll = () => [first, second];
	context.document.elementFromPoint = (x: number) => x < 140 ? first : second;
	const ref = "bp-ref://control/repeated-save";
	const registry = { [ref]: { ok: true, fresh: true, descriptor: {
		refId: ref,
		locators: [{ by: "textAnchor", value: "Save", role: "button", exact: true }],
		semantic: { role: "button", name: "Save" },
		geometry: { point: { x: 140, y: 50 } },
	} } };
	vm.runInContext(`${stdlibPrelude(registry)}\nglobalThis.__result = browserPilot.resolve(${JSON.stringify(ref)});`, vm.createContext(context));
	assert.equal((context.__result as { el?: FakeElement }).el, null);
});

test("browserPilot.resolve never switches identity to a visible duplicate", () => {
	const { context } = createContext();
	const occluded = element("BUTTON", "occluded-save", "Save", rect(40, 30, 120, 40));
	const visible = element("BUTTON", "visible-save", "Save", rect(500, 300, 120, 40));
	context.document.querySelectorAll = () => [occluded, visible];
	context.document.elementFromPoint = () => visible;
	const ref = "bp-ref://control/occluded-save";
	const registry = { [ref]: { ok: true, fresh: true, descriptor: { refId: ref, locators: [{ by: "textAnchor", value: "Save", role: "button", exact: true }], semantic: { role: "button", name: "Save" }, geometry: { point: { x: 100, y: 50 } } } } };
	vm.runInContext(`${stdlibPrelude(registry)}\nglobalThis.__result = browserPilot.resolve(${JSON.stringify(ref)});`, vm.createContext(context));
	assert.equal((context.__result as { el?: FakeElement }).el, occluded);
});

test("browserPilot.resolve rebinds a rerendered control by semantic identity", () => {
	const { context } = createContext();
	const replacement = element("BUTTON", "smoke-action", "Run smoke", rect(40, 30, 120, 40));
	context.document.querySelectorAll = (selector: string) => selector === "#stale-selector" ? [] : selector.includes("[aria-label]") ? [replacement] : [];
	context.document.elementFromPoint = () => replacement;
	const ref = "bp-ref://control/rerendered";
	const registry = { [ref]: { ok: true, fresh: true, descriptor: {
		refId: ref,
		locators: [{ by: "css", value: "#stale-selector" }, { by: "textAnchor", value: "Run smoke", role: "button", exact: false }],
		semantic: { role: "button", name: "Run smoke" },
	} } };
	vm.runInContext(`${stdlibPrelude(registry)}\nglobalThis.__result = browserPilot.resolve(${JSON.stringify(ref)});`, vm.createContext(context));
	assert.equal((context.__result as { el?: FakeElement }).el, replacement);
});

test("browserPilot.resolve refreshes semantic candidates after an in-script rerender", () => {
	const { context } = createContext();
	const first = element("BUTTON", "first", "Run smoke", rect(40, 30, 120, 40));
	const second = element("BUTTON", "second", "Run smoke", rect(40, 30, 120, 40));
	let current = first;
	context.document.querySelectorAll = () => [current];
	context.document.elementFromPoint = () => current;
	const ref = "bp-ref://control/dynamic";
	const registry = { [ref]: { ok: true, fresh: true, descriptor: { refId: ref, locators: [{ by: "textAnchor", value: "Run smoke", role: "button", exact: true }], semantic: { role: "button", name: "Run smoke" } } } };
	const sandbox = context as typeof context & { __replace(): void; __before?: string; __after?: string };
	sandbox.__replace = () => { current = second; };
	vm.runInContext(`${stdlibPrelude(registry)}\nglobalThis.__before = browserPilot.resolve(${JSON.stringify(ref)}).el?.id; globalThis.__replace(); globalThis.__after = browserPilot.resolve(${JSON.stringify(ref)}).el?.id;`, vm.createContext(sandbox));
	assert.deepEqual({ before: sandbox.__before, after: sandbox.__after }, { before: "first", after: "second" });
});

test("shared ref runtime preserves the canvas region role", () => {
	const { context } = createContext();
	const canvas = element("CANVAS", "surface", "", rect(40, 30, 120, 80));
	context.document.elementFromPoint = () => canvas;
	const sandbox = context as typeof context & { __canvas: FakeElement };
	sandbox.__canvas = canvas;
	vm.runInContext(`globalThis.__result = (${PAGE_REF_RUNTIME_SOURCE}).point(globalThis.__canvas, { semantic: { role: "region" } }, false);`, vm.createContext(sandbox));
	assert.equal((sandbox.__result as { ok?: boolean }).ok, true);
});

test("browserPilot.resolve treats native img and AX image roles as the same semantic entity", () => {
	const { context } = createContext();
	const image = element("IMG", "preview", "Preview", rect(40, 30, 120, 80));
	context.document.querySelectorAll = (selector: string) => selector.includes("img[alt]") ? [image] : [];
	context.document.elementFromPoint = () => image;
	const ref = "bp-ref://media/preview";
	const registry = { [ref]: { ok: true, fresh: true, descriptor: { refId: ref, locators: [{ by: "textAnchor", value: "Preview", role: "image", exact: true }], semantic: { role: "image", name: "Preview" } } } };
	vm.runInContext(`${stdlibPrelude(registry)}\nglobalThis.__result = browserPilot.resolve(${JSON.stringify(ref)});`, vm.createContext(context));
	assert.equal((context.__result as { el?: FakeElement }).el, image);
});

test("browserPilot.resolve rejects semantic mismatches and ambiguous replacements", () => {
	for (const candidates of [
		[element("BUTTON", "danger", "Danger", rect(40, 30, 120, 40))],
		[element("BUTTON", "save-1", "Save", rect(40, 30, 120, 40)), element("BUTTON", "save-2", "Save", rect(200, 30, 120, 40))],
	]) {
		const { context } = createContext();
		context.document.querySelectorAll = () => candidates;
		context.document.elementFromPoint = (x: number, y: number) => candidates.find((candidate) => {
			const bounds = candidate.getBoundingClientRect();
			return x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom;
		}) ?? null;
		const name = candidates.length === 1 ? "Run smoke" : "Save";
		const ref = `bp-ref://control/${candidates.length === 1 ? "mismatch" : "ambiguous"}`;
		const registry = { [ref]: { ok: true, fresh: true, descriptor: { refId: ref, locators: [{ by: "textAnchor", value: name, role: "button", exact: false }], semantic: { role: "button", name } } } };
		vm.runInContext(`${stdlibPrelude(registry)}\nglobalThis.__result = browserPilot.resolve(${JSON.stringify(ref)});`, vm.createContext(context));
		assert.equal((context.__result as { el?: FakeElement }).el, null);
	}
});

test("browserPilot stdlib exposes its current helper namespace", () => {
	const { context } = createContext();
	vm.runInContext(`${stdlibPrelude({})}\nglobalThis.__namespace = browserPilot.__namespace;`, vm.createContext(context));
	assert.deepEqual(Array.from((context.__namespace as string[]) ?? []), ["refs", "resolve", "box", "setValue", "settled"]);
});
