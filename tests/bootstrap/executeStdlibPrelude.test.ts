import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { stdlibPrelude } from "../../src/browser-command-runtime/executeStdlibPrelude.ts";

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
	const hidden = element("A", "hidden-link", "hidden", rect(8, 8, 40, 20));
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
			querySelectorAll() {
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

test("browserPilot stdlib exposes its current helper namespace", () => {
	const { context } = createContext();
	vm.runInContext(`${stdlibPrelude({})}\nglobalThis.__namespace = browserPilot.__namespace;`, vm.createContext(context));
	assert.deepEqual(Array.from((context.__namespace as string[]) ?? []), ["refs", "resolve", "box", "setValue", "settled"]);
});
