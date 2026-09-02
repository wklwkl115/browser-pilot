import test from "node:test";
import assert from "node:assert/strict";

// input.ts transitively loads cdp.ts, which registers chrome.debugger listeners at module scope.
Object.assign(globalThis, {
	chrome: {
		runtime: { id: "browser-pilot-test" },
		debugger: {
			onDetach: { addListener() {} },
			onEvent: { addListener() {}, removeListener() {} },
		},
		storage: {},
		tabs: {},
	},
	self: globalThis,
});

const input = await import("../../src/bridge/extension/service_worker/input.ts");

type Call = { method: string; params: Record<string, unknown>; targetId?: string };
type Reply = { ok: boolean; data?: Record<string, unknown>; error?: string; error_code?: string };
type Script = (call: Call, index: number) => Reply | undefined;

const REF_TARGET = {
	refId: "bp-ref://control/abc",
	kind: "control",
	backendNodeId: 42,
	locators: [{ by: "backendNodeId", value: 42 }],
	semantic: { role: "textbox", name: "Email" },
};
const LOCATOR_TARGET = {
	refId: "bp-ref://control/def",
	kind: "control",
	locators: [{ by: "css", value: "#agree" }],
	semantic: { role: "checkbox", name: "Agree" },
};

function cdpValue(value: unknown): Reply {
	return { ok: true, data: { result: { result: { type: "object", value } } } };
}
function cdpRaw(result: Record<string, unknown>): Reply {
	return { ok: true, data: { result } };
}
function cdpFail(message: string): Reply {
	return { ok: false, error: message, error_code: "CDP_ERROR" };
}

/** Default happy-path replies; scenario scripts override individual methods. */
function baseline(call: Call): Reply {
	switch (call.method) {
		case "DOM.resolveNode":
			return cdpRaw({ object: { objectId: "obj-1" } });
		case "DOM.getNodeForLocation":
			return cdpRaw({ backendNodeId: 77, frameId: "frame-1" });
		case "Runtime.callFunctionOn":
			return cdpValue({ ok: true, x: 120, y: 40 });
		case "Runtime.evaluate":
			return cdpValue({ ok: true, x: 120, y: 40 });
		default:
			return cdpRaw({});
	}
}

function harness(script: Script = () => undefined) {
	const calls: Call[] = [];
	input.setInputCdpSenderForTests(async (_tabId, _msg, method, params, targetId) => {
		const call: Call = { method, params, targetId };
		calls.push(call);
		return (script(call, calls.length - 1) ?? baseline(call)) as never;
	});
	return {
		calls,
		methods: () => calls.map((call) => call.method),
		types: () => calls.map((call) => call.params.type).filter(Boolean),
		restore: () => input.setInputCdpSenderForTests(),
	};
}

function isCheckStateCall(call: Call): boolean {
	return call.method === "Runtime.callFunctionOn" && String(call.params.functionDeclaration).includes("aria-pressed");
}
function isSelectCall(call: Call): boolean {
	return (
		call.method === "Runtime.callFunctionOn" && String(call.params.functionDeclaration).includes("option_not_found")
	);
}
function isEditableProbe(call: Call): boolean {
	return call.method === "Runtime.evaluate" && String(call.params.expression).includes("not_editable");
}

test("input.ref type clicks to focus, verifies editability, clears, then inserts trusted text", async () => {
	const h = harness((call) =>
		isEditableProbe(call) ? cdpValue({ ok: true, tag: "input", type: "email" }) : undefined,
	);
	try {
		const result = await input.handleBrowserPilotRefInputCommand("input.ref", 7, {
			cmd: "input.ref",
			action: "type",
			text: "hello@example.test",
			clear: true,
			target: REF_TARGET,
		});
		assert.equal(result.ok, true, JSON.stringify(result));
		const data = result.data as Record<string, Record<string, unknown>>;
		assert.equal(data.input.action, "type");
		assert.equal(data.input.resolution, "backendNodeId");
		assert.deepEqual(data.input.text, { redacted: true, charCount: 18, cleared: true });
		assert.deepEqual(h.types(), [
			"mouseMoved",
			"mousePressed",
			"mouseReleased",
			"rawKeyDown",
			"keyUp",
			"keyDown",
			"keyUp",
		]);
		const selectAll = h.calls.find((call) => call.params.type === "rawKeyDown");
		assert.deepEqual(selectAll?.params.commands, ["selectAll"]);
		const insert = h.calls.find((call) => call.method === "Input.insertText");
		assert.equal(insert?.params.text, "hello@example.test");
		assert.equal(h.methods().indexOf("Input.insertText"), h.methods().length - 1);
		assert.equal(JSON.stringify(result).includes("hello@example.test"), false);
	} finally {
		h.restore();
	}
});

test("input.ref type without clear leaves existing content and skips editing commands", async () => {
	const h = harness((call) => (isEditableProbe(call) ? cdpValue({ ok: true, tag: "textarea" }) : undefined));
	try {
		const result = await input.handleBrowserPilotRefInputCommand("input.ref", 7, {
			cmd: "input.ref",
			action: "type",
			text: "more",
			target: REF_TARGET,
		});
		assert.equal(result.ok, true);
		assert.deepEqual(h.types(), ["mouseMoved", "mousePressed", "mouseReleased"]);
		assert.equal(h.methods().filter((method) => method === "Input.dispatchKeyEvent").length, 0);
		assert.equal(h.methods().filter((method) => method === "Input.insertText").length, 1);
	} finally {
		h.restore();
	}
});

test("input.ref type refuses to insert into a non-editable focus target", async () => {
	const h = harness((call) =>
		isEditableProbe(call) ? cdpValue({ ok: false, reason: "not_editable", tag: "button" }) : undefined,
	);
	try {
		const result = await input.handleBrowserPilotRefInputCommand("input.ref", 7, {
			cmd: "input.ref",
			action: "type",
			text: "nope",
			target: REF_TARGET,
		});
		assert.equal(result.ok, false);
		assert.equal(result.error_code, "TARGET_NOT_EDITABLE");
		assert.equal((result.details as Record<string, Record<string, unknown>>).input.phase, "inspectFocus");
		assert.equal(h.methods().includes("Input.insertText"), false);
	} finally {
		h.restore();
	}
});

test("input.ref type reports a disabled field with its own error code", async () => {
	const h = harness((call) => (isEditableProbe(call) ? cdpValue({ ok: false, reason: "disabled" }) : undefined));
	try {
		const result = await input.handleBrowserPilotRefInputCommand("input.ref", 7, {
			cmd: "input.ref",
			action: "type",
			text: "x",
			target: REF_TARGET,
		});
		assert.equal(result.error_code, "TARGET_DISABLED");
	} finally {
		h.restore();
	}
});

test("input.ref check is idempotent when the control already matches the desired state", async () => {
	const h = harness((call) =>
		isCheckStateCall(call) ? cdpValue({ ok: true, kind: "checkbox", checked: true, disabled: false }) : undefined,
	);
	try {
		const result = await input.handleBrowserPilotRefInputCommand("input.ref", 7, {
			cmd: "input.ref",
			action: "check",
			target: REF_TARGET,
		});
		assert.equal(result.ok, true, JSON.stringify(result));
		const check = (result.data as Record<string, Record<string, unknown>>).input.check as Record<string, unknown>;
		assert.deepEqual(check, {
			kind: "checkbox",
			desired: true,
			before: true,
			after: true,
			toggled: false,
			applied: true,
		});
		assert.equal(h.methods().includes("Input.dispatchMouseEvent"), false);
	} finally {
		h.restore();
	}
});

test("input.ref check toggles through a trusted click and re-reads the state", async () => {
	let reads = 0;
	const h = harness((call) => {
		if (!isCheckStateCall(call)) return undefined;
		reads += 1;
		return cdpValue({ ok: true, kind: "switch", checked: reads > 1, disabled: false });
	});
	try {
		const result = await input.handleBrowserPilotRefInputCommand("input.ref", 7, {
			cmd: "input.ref",
			action: "check",
			checked: true,
			target: REF_TARGET,
		});
		assert.equal(result.ok, true, JSON.stringify(result));
		const check = (result.data as Record<string, Record<string, unknown>>).input.check as Record<string, unknown>;
		assert.deepEqual(check, {
			kind: "switch",
			desired: true,
			before: false,
			after: true,
			toggled: true,
			applied: true,
		});
		assert.deepEqual(h.types(), ["mouseMoved", "mousePressed", "mouseReleased"]);
		assert.equal(reads, 2);
	} finally {
		h.restore();
	}
});

test("input.ref check unchecks when checked:false and rejects non-toggle controls", async () => {
	let reads = 0;
	const h = harness((call) => {
		if (!isCheckStateCall(call)) return undefined;
		reads += 1;
		return cdpValue({ ok: true, kind: "checkbox", checked: reads === 1, disabled: false });
	});
	try {
		const result = await input.handleBrowserPilotRefInputCommand("input.ref", 7, {
			cmd: "input.ref",
			action: "check",
			checked: false,
			target: REF_TARGET,
		});
		const check = (result.data as Record<string, Record<string, unknown>>).input.check as Record<string, unknown>;
		assert.deepEqual(
			{ before: check.before, after: check.after, applied: check.applied },
			{ before: true, after: false, applied: true },
		);
	} finally {
		h.restore();
	}
	const unsupported = harness((call) =>
		isCheckStateCall(call) ? cdpValue({ ok: false, reason: "unsupported", tag: "a" }) : undefined,
	);
	try {
		const result = await input.handleBrowserPilotRefInputCommand("input.ref", 7, {
			cmd: "input.ref",
			action: "check",
			target: REF_TARGET,
		});
		assert.equal(result.ok, false);
		assert.equal(result.error_code, "INVALID_REF_TARGET");
	} finally {
		unsupported.restore();
	}
});

test("input.ref check grounds locator-only refs through a hit test before reading state", async () => {
	const h = harness((call) =>
		isCheckStateCall(call) ? cdpValue({ ok: true, kind: "checkbox", checked: true, disabled: false }) : undefined,
	);
	try {
		const result = await input.handleBrowserPilotRefInputCommand("input.ref", 7, {
			cmd: "input.ref",
			action: "check",
			target: LOCATOR_TARGET,
		});
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.equal((result.data as Record<string, Record<string, unknown>>).input.resolution, "liveLocator");
		const located = h.calls.find((call) => call.method === "DOM.getNodeForLocation");
		assert.deepEqual({ x: located?.params.x, y: located?.params.y }, { x: 120, y: 40 });
		const resolved = h.calls.find((call) => call.method === "DOM.resolveNode");
		assert.equal(resolved?.params.backendNodeId, 77);
	} finally {
		h.restore();
	}
});

test("input.ref select focuses the control and applies the option without opening a native popup", async () => {
	const h = harness((call) =>
		isSelectCall(call)
			? cdpValue({
					ok: true,
					selected: { index: 2, value: "cn", label: "China" },
					before: ["us"],
					multiple: false,
				})
			: undefined,
	);
	try {
		const result = await input.handleBrowserPilotRefInputCommand("input.ref", 7, {
			cmd: "input.ref",
			action: "select",
			label: "China",
			target: REF_TARGET,
		});
		assert.equal(result.ok, true, JSON.stringify(result));
		const select = (result.data as Record<string, Record<string, unknown>>).input.select as Record<string, unknown>;
		assert.deepEqual(select.selected, { index: 2, value: "cn", label: "China" });
		assert.equal(select.dispatch, "synthetic");
		const selectCall = h.calls.find(isSelectCall);
		assert.deepEqual((selectCall?.params.arguments as Array<{ value: unknown }>)[0]?.value, { label: "China" });
		assert.equal(h.methods().includes("Input.dispatchMouseEvent"), false);
		assert.equal(h.methods().includes("DOM.focus"), true);
	} finally {
		h.restore();
	}
});

test("input.ref select surfaces the available options when nothing matches", async () => {
	const h = harness((call) =>
		isSelectCall(call)
			? cdpValue({
					ok: false,
					reason: "option_not_found",
					options: [{ index: 0, value: "us", label: "United States", disabled: false }],
				})
			: undefined,
	);
	try {
		const result = await input.handleBrowserPilotRefInputCommand("input.ref", 7, {
			cmd: "input.ref",
			action: "select",
			value: "zz",
			target: REF_TARGET,
		});
		assert.equal(result.ok, false);
		assert.equal(result.error_code, "INVALID_INPUT");
		const details = (result.details as Record<string, Record<string, unknown>>).input;
		assert.equal(details.reason, "option_not_found");
		assert.equal(Array.isArray(details.options), true);
	} finally {
		h.restore();
	}
	const missing = harness();
	try {
		const result = await input.handleBrowserPilotRefInputCommand("input.ref", 7, {
			cmd: "input.ref",
			action: "select",
			target: REF_TARGET,
		});
		assert.equal(result.error_code, "INVALID_RULE");
		assert.match(String(result.error), /value, label, or index/);
	} finally {
		missing.restore();
	}
});

test("input.ref focus uses DOM.focus and falls back to a trusted click for non-focusable hosts", async () => {
	const direct = harness();
	try {
		const result = await input.handleBrowserPilotRefInputCommand("input.ref", 7, {
			cmd: "input.ref",
			action: "focus",
			target: REF_TARGET,
		});
		assert.equal(result.ok, true, JSON.stringify(result));
		const focus = (result.data as Record<string, Record<string, unknown>>).input.focus as Record<string, unknown>;
		assert.equal(focus.method, "DOM.focus");
		assert.equal(direct.methods().includes("Input.dispatchMouseEvent"), false);
	} finally {
		direct.restore();
	}
	const fallback = harness((call) => (call.method === "DOM.focus" ? cdpFail("Element is not focusable") : undefined));
	try {
		const result = await input.handleBrowserPilotRefInputCommand("input.ref", 7, {
			cmd: "input.ref",
			action: "focus",
			target: REF_TARGET,
		});
		assert.equal(result.ok, true, JSON.stringify(result));
		const focus = (result.data as Record<string, Record<string, unknown>>).input.focus as Record<string, unknown>;
		assert.equal(focus.method, "click");
		assert.deepEqual(fallback.types(), ["mouseMoved", "mousePressed", "mouseReleased"]);
	} finally {
		fallback.restore();
	}
});

test("input.ref hover on a DOM ref only moves the pointer", async () => {
	const h = harness();
	try {
		const result = await input.handleBrowserPilotRefInputCommand("input.ref", 7, {
			cmd: "input.ref",
			action: "hover",
			target: REF_TARGET,
		});
		assert.equal(result.ok, true);
		assert.deepEqual(h.types(), ["mouseMoved"]);
	} finally {
		h.restore();
	}
});

test("input.ref keeps pointer-only gestures on visual refs and form verbs on DOM refs", async () => {
	const h = harness();
	try {
		const wheel = await input.handleBrowserPilotRefInputCommand("input.ref", 7, {
			cmd: "input.ref",
			action: "wheel",
			target: REF_TARGET,
		});
		assert.equal(wheel.error_code, "INVALID_RULE");
		assert.match(String(wheel.error), /Non-visual input.ref targets support/);
		const visualCheck = await input.handleBrowserPilotRefInputCommand("input.ref", 7, {
			cmd: "input.ref",
			action: "check",
			target: { ...REF_TARGET, visual: { actionableGrounding: true, anchor: { point: { x: 0.5, y: 0.5 } } } },
		});
		assert.equal(visualCheck.error_code, "INVALID_RULE");
		assert.match(String(visualCheck.error), /Visual input.ref targets support/);
		assert.equal(h.calls.length, 0);
	} finally {
		h.restore();
	}
});
