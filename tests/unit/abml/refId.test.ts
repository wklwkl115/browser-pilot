import test from "node:test";
import assert from "node:assert/strict";
import { makePiRefUri, stableRefIdForDescriptor, summaryRefIdForDescriptor } from "../../../src/abml-core/refId.ts";
import type { RefDescriptor } from "../../../src/abml-core/types.ts";

type DescriptorInput = Omit<RefDescriptor, "refId">;

function descriptor(overrides: Partial<DescriptorInput> = {}): DescriptorInput {
	return {
		kind: "control",
		locators: [{ by: "css", value: "#submit" }],
		owner: { browserSessionId: "s1", tabId: 7, topLevelOrigin: "https://example.test" },
		policy: { redaction: "default", shareableAcrossSessions: false, liveActionsAllowed: true },
		semantic: { role: "button", name: "Submit" },
		observationId: "obs-1",
		documentEpoch: { url: "https://example.test/form", capturedAt: 1000 },
		createdAt: 1000,
		ttlMs: 60_000,
		...overrides,
	};
}

test("refId: makePiRefUri keeps canonical pi-ref shape", () => {
	assert.equal(makePiRefUri("control", "abc123"), "pi-ref://control/abc123");
});

test("refId: css locator is identity-priority over session-scoped backend/AX ids", () => {
	const a = descriptor({ locators: [{ by: "backendNodeId", value: 10 }, { by: "axNodeId", value: "ax-a" }, { by: "css", value: "#submit" }] });
	const b = descriptor({ locators: [{ by: "backendNodeId", value: 99 }, { by: "axNodeId", value: "ax-b" }, { by: "css", value: "#submit" }] });
	assert.equal(stableRefIdForDescriptor(a), stableRefIdForDescriptor(b));
});

test("refId: semantic anchor wins over locator path", () => {
	const semantic = {
		role: "button",
		name: "Buy",
		anchor: {
			scope: "abml-template" as const,
			confidence: "high" as const,
			mintingEligible: true,
			containerRole: "list",
			containerName: "Products",
			role: "button",
			kind: "control",
			normalizedName: "buy",
		},
	};
	const a = descriptor({ semantic, locators: [{ by: "css", value: "#buy-a" }] });
	const b = descriptor({ semantic, locators: [{ by: "css", value: "#buy-b" }] });
	assert.equal(stableRefIdForDescriptor(a), stableRefIdForDescriptor(b));
});

test("refId: same descriptor is stable, tab and URL remain identity-sensitive", () => {
	const base = descriptor();
	assert.equal(stableRefIdForDescriptor(base), stableRefIdForDescriptor(descriptor()));
	assert.notEqual(stableRefIdForDescriptor(base), stableRefIdForDescriptor(descriptor({ owner: { ...base.owner, tabId: 8 } })));
	assert.notEqual(stableRefIdForDescriptor(base), stableRefIdForDescriptor(descriptor({ documentEpoch: { url: "https://example.test/other", capturedAt: 1000 } })));
});

test("refId: no stable anchor falls back only through summaryRefIdForDescriptor", () => {
	const unstable = descriptor({ locators: [], semantic: { role: "status" }, snapshot: { observationId: "obs-1", resourceUri: "browser-result://x", immutable: true } });
	assert.equal(stableRefIdForDescriptor(unstable), undefined);
	assert.match(summaryRefIdForDescriptor(unstable), /^pi-ref:\/\/control\/[0-9a-f]{24}$/);
});
