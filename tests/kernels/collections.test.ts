import assert from "node:assert/strict";
import test from "node:test";
import { buildCollectionModels } from "../../src/kernels/abml/collections.ts";
import type { Entity } from "../../src/kernels/abml/entity.ts";

const state = { visible: true, occluded: false, disabled: false, focused: false, editable: false, inViewport: true };

function item(
	ref: string,
	role: string,
	container: { role: string; name: string },
	box: { x: number; y: number; w: number; h: number },
): Entity {
	return {
		ref,
		kind: "element",
		role,
		name: ref,
		state,
		source: "ax",
		geometry: { box },
		hints: { containerRole: container.role, containerName: container.name },
	};
}

function page(): Entity[] {
	const nav = { role: "list", name: "Site navigation" };
	const orders = { role: "table", name: "Orders" };
	return [
		...Array.from({ length: 4 }, (_, i) =>
			item(`bp-ref://element/nav-${i}`, "listitem", nav, { x: 20 + i * 120, y: 10, w: 100, h: 30 }),
		),
		...Array.from({ length: 10 }, (_, i) =>
			item(`bp-ref://element/row-${i}`, "row", orders, { x: 40, y: 120 + i * 40, w: 800, h: 36 }),
		),
	];
}

test("pagination controls attach to the collection they sit under, not to every collection on the page", () => {
	const models = buildCollectionModels({
		entities: page(),
		scanEvidence: {
			actionables: [
				// Footer link far below the table: must not be treated as pagination for anything.
				{
					ref: "bp-ref://control/footer-more",
					label: "More about us",
					rect: { x: 40, y: 1400, width: 120, height: 30 },
				},
				// Directly under the table, horizontally inside it.
				{ ref: "bp-ref://control/next", label: "下一页", rect: { x: 700, y: 540, width: 80, height: 32 } },
			],
		},
	});
	const orders = models.find((model) => model.containerName === "Orders");
	const nav = models.find((model) => model.containerName === "Site navigation");
	assert.ok(orders && nav, "both collections should be modelled");
	assert.equal(orders.completeness, "paginated");
	assert.deepEqual(orders.paginationControl, { ref: "bp-ref://control/next", label: "下一页", kind: "next" });
	assert.equal(nav.paginationControl, undefined);
	assert.notEqual(nav.completeness, "paginated");
});

test("load-more controls inside a feed mark it lazy and rel=next wins over label heuristics", () => {
	const feed = { role: "feed", name: "Timeline" };
	const entities = Array.from({ length: 6 }, (_, i) =>
		item(`bp-ref://element/post-${i}`, "article", feed, { x: 0, y: i * 200, w: 600, h: 180 }),
	);
	const lazy = buildCollectionModels({
		entities,
		scanEvidence: {
			actionables: [
				{ ref: "bp-ref://control/more", label: "加载更多", rect: { x: 200, y: 1100, width: 200, height: 40 } },
			],
		},
	});
	assert.equal(lazy[0]?.completeness, "lazy");
	assert.equal(lazy[0]?.paginationControl?.kind, "load-more");

	const paginated = buildCollectionModels({
		entities,
		scanEvidence: {
			actionables: [
				{ ref: "bp-ref://control/more", label: "Show more", rect: { x: 200, y: 1200, width: 200, height: 40 } },
				{
					ref: "bp-ref://control/next",
					label: "→",
					rel: "next",
					rect: { x: 500, y: 1200, width: 40, height: 40 },
				},
			],
		},
	});
	assert.equal(paginated[0]?.completeness, "paginated");
	assert.equal(paginated[0]?.confidence, "high");
	assert.equal(paginated[0]?.paginationControl?.ref, "bp-ref://control/next");
});

test("pagination vocabulary covers common non-English labels", () => {
	const orders = { role: "table", name: "Orders" };
	const entities = Array.from({ length: 5 }, (_, i) =>
		item(`bp-ref://element/row-${i}`, "row", orders, { x: 0, y: i * 40, w: 600, h: 36 }),
	);
	for (const [label, kind] of [
		["次のページ", "next"],
		["Siguiente", "next"],
		["上一页", "previous"],
		["Zurück", "previous"],
		["查看更多", "show-more"],
		["Mehr laden", "load-more"],
	] as const) {
		const [model] = buildCollectionModels({
			entities,
			scanEvidence: {
				actionables: [{ ref: "bp-ref://control/x", label, rect: { x: 100, y: 220, width: 100, height: 30 } }],
			},
		});
		assert.equal(model?.paginationControl?.kind, kind, `${label} should classify as ${kind}`);
	}
});

test("controls without geometry only apply to a single-collection page", () => {
	const orders = { role: "table", name: "Orders" };
	const nav = { role: "list", name: "Nav" };
	const single = buildCollectionModels({
		entities: Array.from({ length: 3 }, (_, i) =>
			item(`bp-ref://element/r-${i}`, "row", orders, { x: 0, y: i * 40, w: 600, h: 36 }),
		),
		scanEvidence: { actionables: [{ ref: "bp-ref://control/next", label: "Next" }] },
	});
	assert.equal(single[0]?.completeness, "paginated");
	const multiple = buildCollectionModels({
		entities: [
			...Array.from({ length: 3 }, (_, i) =>
				item(`bp-ref://element/r-${i}`, "row", orders, { x: 0, y: i * 40, w: 600, h: 36 }),
			),
			...Array.from({ length: 3 }, (_, i) =>
				item(`bp-ref://element/n-${i}`, "listitem", nav, { x: 0, y: 500 + i * 40, w: 600, h: 36 }),
			),
		],
		scanEvidence: { actionables: [{ ref: "bp-ref://control/next", label: "Next" }] },
	});
	assert.ok(multiple.every((model) => model.paginationControl === undefined));
});
