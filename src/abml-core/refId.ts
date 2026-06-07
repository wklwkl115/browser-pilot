import type { RefDescriptor, RefKind } from "./types.js";

export function makePiRefUri(kind: RefKind, id: string): string {
	return `pi-ref://${kind}/${id}`;
}

function stableHash24(value: unknown): string {
	const text = JSON.stringify(value);
	const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b];
	return seeds.map((seed) => {
		let hash = seed >>> 0;
		for (let index = 0; index < text.length; index += 1) {
			hash ^= text.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		return hash.toString(16).padStart(8, "0");
	}).join("");
}

export function stableRefIdForDescriptor(descriptor: Omit<RefDescriptor, "refId">): string | undefined {
	const semantic = descriptor.semantic || {};
	const anchor = semantic.anchor;
	const semanticAnchor = anchor?.scope === "abml-template"
		&& anchor.confidence === "high"
		&& anchor.mintingEligible === true
		&& typeof anchor.containerRole === "string"
		&& typeof anchor.containerName === "string"
		&& typeof anchor.normalizedName === "string"
		? {
			scope: "abml-template",
			containerRole: anchor.containerRole,
			containerName: anchor.containerName,
			role: anchor.role || semantic.role,
			kind: anchor.kind || descriptor.kind,
			normalizedName: anchor.normalizedName,
		}
		: undefined;
	const locator = semanticAnchor ? undefined : descriptor.locators.find((item) => item.by === "css")
		|| descriptor.locators.find((item) => item.by === "backendNodeId")
		|| descriptor.locators.find((item) => item.by === "axNodeId")
		|| descriptor.locators.find((item) => item.by === "textAnchor")
		|| descriptor.locators[0];
	if (!semanticAnchor && !locator) return undefined;
	const stable = {
		kind: descriptor.kind,
		tabId: descriptor.owner.tabId,
		origin: descriptor.owner.topLevelOrigin,
		url: descriptor.documentEpoch?.url,
		...(semanticAnchor ? { semanticAnchor } : { locator, role: semantic.role, name: semantic.name }),
	};
	const hash = stableHash24(stable);
	return makePiRefUri(descriptor.kind, hash);
}

export function summaryRefIdForDescriptor(descriptor: Omit<RefDescriptor, "refId">): string {
	const stable = stableRefIdForDescriptor(descriptor);
	if (stable) return stable;
	const hash = stableHash24({
		kind: descriptor.kind,
		owner: descriptor.owner,
		snapshot: descriptor.snapshot,
		semantic: descriptor.semantic,
		locators: descriptor.locators,
	});
	return makePiRefUri(descriptor.kind, hash);
}
