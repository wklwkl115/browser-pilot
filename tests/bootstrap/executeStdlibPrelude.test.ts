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
		console,
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
				return selector === ".hidden-link" ? hidden : null;
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
					{ by: "point", x: 90, y: 60 },
				],
			},
		},
	};
	const script = `${stdlibPrelude(registry)}\nglobalThis.__result = browserPilot.resolve("bp-ref://control/1");`;
	vm.runInContext(script, vm.createContext(context));
	const result = context.__result as { el?: FakeElement; tried?: string[] };
	assert.equal(result.el, visible);
	assert.deepEqual(Array.from(result.tried ?? []), ["css", "point"]);
});

test("browserPilot stdlib namespace no longer exposes the removed physical-action helper", () => {
	const { context } = createContext();
	vm.runInContext(`${stdlibPrelude({})}\nglobalThis.__namespace = browserPilot.__namespace;\nglobalThis.__result = Object.prototype.hasOwnProperty.call(browserPilot, "click");`, vm.createContext(context));
	assert.deepEqual(Array.from((context.__namespace as string[]) ?? []), ["resolve", "box", "setValue", "settled"]);
	assert.equal(context.__result, false);
});
