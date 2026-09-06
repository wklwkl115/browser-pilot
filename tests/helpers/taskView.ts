import type { Entity } from "../../src/kernels/abml/entity.ts";
import type { PageObservationV3 } from "../../src/kernels/abml/pageObservation.ts";

export function taskEntity(id: string, role: string, name: string, children?: Entity[]): Entity {
	return {
		ref: `bp-ref://${role === "textbox" || role === "button" ? "control" : "region"}/${id}`,
		kind: role === "textbox" || role === "button" ? "control" : "region",
		role,
		name,
		source: "ax",
		state: {
			visible: true,
			occluded: false,
			disabled: false,
			focused: false,
			editable: role === "textbox",
			inViewport: true,
		},
		...(role === "textbox" || role === "button"
			? {
					actionability: {
						actions: [role === "textbox" ? ("edit" as const) : ("click" as const)],
						confidence: "high" as const,
					},
				}
			: {}),
		...(children ? { children } : {}),
	};
}

export function taskObservation(entities: Entity[], overrides: Partial<PageObservationV3> = {}): PageObservationV3 {
	return {
		schema: "browser-page-observation/v3",
		tool: "browser_observe",
		model: "PageObservation",
		canonical: true,
		target: {
			url: "https://example.test/invoices",
			browserSessionId: "session-1",
			tabId: 7,
			targetGeneration: 1,
			pageEpoch: "page-1",
		},
		snapshot: {
			snapshotId: "snapshot-task",
			browserSessionId: "session-1",
			tabId: 7,
			targetGeneration: 1,
			pageEpoch: "page-1",
			url: "https://example.test/invoices",
			sourceMode: "scan",
			capturedAt: Date.now(),
			ttlMs: 60_000,
		},
		entities,
		providers: { structure: { planned: true, status: "executed" } },
		frontier: { items: [] },
		content: { text: "Invoice workspace", headings: ["Invoice workspace"], complete: true },
		actionSpace: { items: [], scopes: [], coverage: { captured: 0, captureComplete: true } },
		...overrides,
	};
}

export function taskInvoice(id = "INV-2048") {
	const note = { ...taskEntity(`${id}-note`, "textbox", "备注"), value: "已联系客户" };
	const button = taskEntity(`${id}-save`, "button", "Save");
	const heading = taskEntity(`${id}-heading`, "heading", id);
	const record = taskEntity(id, "form", id, [heading, note, button]);
	return { note, button, record };
}
